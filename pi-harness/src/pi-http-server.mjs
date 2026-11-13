import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, lstatSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { runLauncher } from '../scripts/remote-pi-rpc.cjs';

const THREAD = 'pi-thread-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const THREAD_ROUTE = new RegExp('^/v1/pi/threads/(' + THREAD + ')/(open|events|rpc|close|files(?:/[^/]+)?)$');
const OWNER = /^[a-z][a-z0-9_-]{0,63}$/;
const AUTHORIZATION = /^Bearer ([a-zA-Z0-9._~-]{32,512})$/;
const MAX_RPC_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_RPCS_PER_LAUNCH = 8192;
const SSE_HEARTBEAT_MS = 15000;
const MODES = new Set(['text', 'office', 'fileOffice']);
const commands = new Set(['get_state', 'get_session_stats', 'prompt', 'abort']);
const officeCommands = new Set(['office_configure', 'extension_ui_response']);
const decoder = new TextDecoder('utf-8', { fatal: true });

function httpError(status, code) {
  return Object.assign(new Error(code), { status, code });
}

function safeInteger(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error('Invalid ' + name);
  return value;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJson(req, limit) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw httpError(415, 'EXPECTED_JSON');
  }
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw httpError(413, 'BODY_TOO_LARGE');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(decoder.decode(Buffer.concat(chunks, size)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch {
    throw httpError(400, 'INVALID_JSON');
  }
}

function configuredOwners(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > 128) throw Error('Invalid Pi service tokens');
  const digests = new Set();
  return tokens.map(entry => {
    if (!entry || !OWNER.test(entry.owner ?? '') || typeof entry.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.sha256) || digests.has(entry.sha256)) throw Error('Invalid Pi service token');
    digests.add(entry.sha256);
    return { owner: entry.owner, digest: Buffer.from(entry.sha256, 'hex') };
  });
}

function requestOwner(req, owners) {
  const match = AUTHORIZATION.exec(req.headers.authorization ?? '');
  if (!match) throw httpError(401, 'AUTH_REQUIRED');
  const digest = createHash('sha256').update(match[1]).digest();
  let owner;
  for (const entry of owners) if (timingSafeEqual(entry.digest, digest)) owner = entry.owner;
  if (!owner) throw httpError(401, 'AUTH_REQUIRED');
  return owner;
}

function privateDirectory(directory) {
  mkdirSync(directory, { mode: 0o700 });
  return verifyPrivateDirectory(directory);
}

function verifyPrivateDirectory(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077)
      || (process.getuid && stat.uid !== process.getuid())) throw Error('Invalid private Pi directory');
  return directory;
}

function ensurePrivateDirectory(directory) {
  try { return privateDirectory(directory); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return verifyPrivateDirectory(directory);
  }
}

function rememberMode(home, id, mode) {
  const directory = ensurePrivateDirectory(join(home, 'thread-modes'));
  const filename = join(directory, id);
  try { writeFileSync(filename, mode + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 || (stat.mode & 0o077)
      || (process.getuid && stat.uid !== process.getuid())) throw Error('Invalid Pi thread metadata');
    if (readFileSync(filename, 'utf8') !== mode + '\n') throw httpError(409, 'THREAD_MODE_MISMATCH');
  }
}

function parseCursor(req, url) {
  const raw = req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
  if (!/^(0|[1-9]\d{0,15})$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw httpError(400, 'INVALID_EVENT_CURSOR');
  }
  return Number(raw);
}

function assertEpoch(actual, expected) {
  if (actual !== expected) throw httpError(409, 'STALE_PI_EPOCH');
}

function validateRecord(record, mode) {
  const { id, type } = record;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id) || typeof type !== 'string'
    || !(commands.has(type) || (mode === 'office' && officeCommands.has(type)))) {
    throw httpError(400, 'UNSUPPORTED_PI_RPC');
  }
  if (commands.has(type)) {
    const keys = type === 'prompt' ? ['id', 'type', 'message', 'images'] : ['id', 'type'];
    if (Object.keys(record).some(key => !keys.includes(key))
      || (type === 'prompt' && (typeof record.message !== 'string' || !record.message.length
        || Buffer.byteLength(record.message) > 512 * 1024 || record.message.includes('\0')
        || (record.images !== undefined && (!Array.isArray(record.images) || record.images.length))))) {
      throw httpError(400, 'INVALID_PI_RPC');
    }
  }
}

function startThread({ owner, id, mode, home, launcher, launchPi, extensionsDir, eventLimit, eventBytes }) {
  const input = new PassThrough();
  const subscribers = new Set();
  const thread = {
    owner, id, mode, epoch: randomUUID(), cursor: 0, firstRetained: 1, bytes: 0, events: [],
    requests: new Map(), activePrompt: null, filesActive: false, closing: false, closed: false, touchedAt: Date.now(),
    workspace: join(home, '.workbuddy-pi-ssh', 'workspaces', id),
    input, subscribers,
  };

  function publish(record) {
    const id = ++thread.cursor;
    const frame = Buffer.from('id: ' + id + '\ndata: ' + JSON.stringify(record) + '\n\n');
    thread.events.push({ id, frame });
    thread.bytes += frame.length;
    while (thread.events.length > eventLimit || thread.bytes > eventBytes) {
      thread.bytes -= thread.events.shift().frame.length;
    }
    thread.firstRetained = thread.events[0]?.id ?? thread.cursor + 1;
    thread.touchedAt = Date.now();
    for (const subscriber of subscribers) {
      if (subscriber.writableLength > eventBytes) subscriber.destroy();
      else subscriber.write(frame);
    }
  }

  function accept(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.type !== 'string'
      || record.type === 'workbuddy_transport_closed') throw Error('Invalid Pi output');
    if (record.type === 'agent_settled' || (record.type === 'response' && record.id === thread.activePrompt
      && (record.success === false || record.data?.disposition === 'handled'))) thread.activePrompt = null;
    publish(record);
  }

  thread.close = () => {
    if (thread.closing || thread.closed) return;
    thread.closing = true;
    input.end();
  };

  let chunks = [], length = 0;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      try {
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf(10, start);
          const end = newline === -1 ? chunk.length : newline;
          const part = chunk.subarray(start, end);
          length += part.length;
          if (length > MAX_OUTPUT_BYTES) throw Error('Pi output record exceeds limit');
          if (part.length) chunks.push(part);
          if (newline === -1) break;
          const record = JSON.parse(decoder.decode(Buffer.concat(chunks, length)));
          chunks = [];
          length = 0;
          accept(record);
          start = end + 1;
        }
        callback();
      } catch (error) { callback(error); }
    },
  });
  input.on('error', () => thread.close());
  output.on('error', () => thread.close());
  const diagnostics = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  launcher({
    thread: id, office: mode === 'office', home, input, output, error: diagnostics, launchPi, extensionsDir,
    manageSignals: false,
    onExit(code) {
      if (thread.closed) return;
      thread.closed = true;
      thread.activePrompt = null;
      publish({ type: 'workbuddy_transport_closed', code: Number.isInteger(code) ? code : 1 });
      for (const subscriber of subscribers) subscriber.end();
    },
  });
  return thread;
}

/**
 * A bounded, authenticated Pi RPC relay. Run behind a trusted TLS ingress.
 * Detaching an SSE subscriber does not affect the Pi process or its session.
 */
export async function createPiHttpServer({
  dataDir, agentDir, tokens, allowOffice = false, officeExtension, extensionsDir,
  launchPi = spawn, launcher = runLauncher, eventLimit = 2048, eventBytes = 24 * 1024 * 1024,
  idleMs = 5 * 60_000, activeIdleMs = 15 * 60_000, maxThreads = 16, maxThreadsPerOwner = 4,
} = {}) {
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || dataDir === '/') throw Error('Pi service needs a private data directory');
  if (typeof agentDir !== 'string' || !isAbsolute(agentDir) || agentDir === '/'
    || realpathSync(verifyPrivateDirectory(agentDir)) !== agentDir) throw Error('Pi service needs a private canonical agent profile');
  safeInteger(eventLimit, 1, 4096, 'eventLimit');
  safeInteger(eventBytes, 512, 64 * 1024 * 1024, 'eventBytes');
  safeInteger(idleMs, 100, 60 * 60_000, 'idleMs');
  safeInteger(activeIdleMs, idleMs, 60 * 60_000, 'activeIdleMs');
  safeInteger(maxThreads, 1, 128, 'maxThreads');
  safeInteger(maxThreadsPerOwner, 1, maxThreads, 'maxThreadsPerOwner');
  const owners = configuredOwners(tokens);
  if (realpathSync(ensurePrivateDirectory(dataDir)) !== dataDir) throw Error('Pi data directory must be canonical');
  const homes = ensurePrivateDirectory(join(dataDir, 'owners'));
  const threads = new Map();
  let shuttingDown = false;
  const profileLaunch = (command, args, options) => launchPi(command, args, {
    ...options, stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...options.env, PI_CODING_AGENT_DIR: agentDir },
  });
  let fileOffice;
  if (officeExtension !== undefined) {
    const { handlePiHttpFiles, createFileOfficePiLauncher } = await import('./pi-http-files.mjs');
    fileOffice = {
      handle: handlePiHttpFiles,
      launch: createFileOfficePiLauncher({ officeExtension, launchPi: profileLaunch }),
    };
  }

  async function handle(req, res) {
    if (shuttingDown) throw httpError(503, 'PI_SERVICE_STOPPING');
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw httpError(400, 'INVALID_REQUEST_TARGET');
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== req.url.split('?', 1)[0]) throw httpError(400, 'INVALID_REQUEST_TARGET');
    if (url.pathname === '/v1/pi/healthz' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    const owner = requestOwner(req, owners);
    const match = THREAD_ROUTE.exec(url.pathname);
    if (!match) throw httpError(404, 'NOT_FOUND');
    const [, id, action] = match;
    const key = owner + '\0' + id;
    let thread = threads.get(key);

    if (action === 'open' && req.method === 'POST') {
      const data = await readJson(req, 2048);
      const mode = data.mode ?? 'text';
      if (Object.keys(data).some(key => key !== 'mode') || !MODES.has(mode)
        || (mode === 'office' && !allowOffice) || (mode === 'fileOffice' && !fileOffice)) {
        throw httpError(400, 'INVALID_PI_MODE');
      }
      thread = threads.get(key);
      if (thread && thread.mode !== mode) throw httpError(409, 'THREAD_MODE_MISMATCH');
      if (thread && !thread.closed) {
        if (thread.closing || thread.activePrompt || thread.filesActive) throw httpError(409, 'PI_THREAD_BUSY');
        thread.touchedAt = Date.now();
        sendJson(res, 200, { threadId: id, mode, epoch: thread.epoch, cursor: thread.cursor });
        return;
      }
      // Bound retained closed processes and ensure each owner's live allocations
      // cannot exhaust the service's worker slots.
      for (const [otherKey, other] of threads) {
        if (other.closed && (otherKey === key || threads.size >= maxThreads * 2)) threads.delete(otherKey);
      }
      const live = [...threads.values()].filter(candidate => !candidate.closed);
      if (live.length >= maxThreads || live.filter(candidate => candidate.owner === owner).length >= maxThreadsPerOwner) {
        throw httpError(429, 'PI_WORKER_LIMIT');
      }
      const home = ensurePrivateDirectory(join(homes, owner));
      rememberMode(home, id, mode);
      thread = startThread({
        owner, id, mode, home, launcher, extensionsDir, eventLimit, eventBytes,
        launchPi: mode === 'fileOffice' ? fileOffice.launch : profileLaunch,
      });
      threads.set(key, thread);
      sendJson(res, 200, { threadId: id, mode, epoch: thread.epoch, cursor: 0 });
      return;
    }

    if (!thread) throw httpError(404, 'PI_THREAD_NOT_OPEN');
    if (action === 'events' && req.method === 'GET') {
      assertEpoch(url.searchParams.get('epoch'), thread.epoch);
      const cursor = parseCursor(req, url);
      if (cursor > thread.cursor || cursor < thread.firstRetained - 1) throw httpError(409, 'PI_EVENT_GAP');
      if (thread.subscribers.size >= 2) throw httpError(429, 'PI_SUBSCRIBER_LIMIT');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      res.write(': connected\n\n');
      for (const event of thread.events) if (event.id > cursor) res.write(event.frame);
      if (thread.closed) { res.end(); return; }
      thread.subscribers.add(res);
      const heartbeat = setInterval(() => {
        if (res.writableLength > eventBytes) res.destroy();
        else res.write(': heartbeat\n\n');
      }, SSE_HEARTBEAT_MS);
      heartbeat.unref();
      res.once('close', () => { clearInterval(heartbeat); thread.subscribers.delete(res); });
      return;
    }

    assertEpoch(req.headers['x-pi-epoch'], thread.epoch);
    if (action === 'close' && req.method === 'POST') {
      if (thread.filesActive) throw httpError(409, 'PI_FILES_BUSY');
      req.resume();
      thread.close();
      sendJson(res, 202, { accepted: true });
      return;
    }
    if ((action === 'files' || action.startsWith('files/')) && thread.mode === 'fileOffice') {
      if (thread.filesActive) throw httpError(409, 'PI_FILES_BUSY');
      // A completed worker may still have downloadable artifacts. Uploads
      // and new prompts require the thread's current live epoch.
      if (req.method !== 'GET' && (thread.closed || thread.closing)) throw httpError(409, 'PI_THREAD_CLOSED');
      thread.filesActive = true;
      try {
        const handled = await fileOffice.handle(req, res, {
          action: '/' + action, workspace: thread.workspace, threadBusy: () => Boolean(thread.activePrompt),
        });
        if (handled) return;
      } finally { thread.filesActive = false; thread.touchedAt = Date.now(); }
    }
    if (action !== 'rpc' || req.method !== 'POST') throw httpError(405, 'METHOD_NOT_ALLOWED');
    const record = await readJson(req, MAX_RPC_BYTES);
    validateRecord(record, thread.mode);
    if (threads.get(key) !== thread) throw httpError(409, 'STALE_PI_EPOCH');
    const serialized = JSON.stringify(record);
    const digest = createHash('sha256').update(serialized).digest('hex');
    const previous = thread.requests.get(record.id);
    if (previous) {
      if (previous !== digest) throw httpError(409, 'PI_REQUEST_ID_CONFLICT');
      sendJson(res, 202, { accepted: true, duplicate: true });
      return;
    }
    if (thread.closed || thread.closing) throw httpError(409, 'PI_THREAD_CLOSED');
    if ((record.type === 'prompt' || record.type === 'office_configure') && (thread.activePrompt || thread.filesActive)) {
      throw httpError(409, 'PI_THREAD_BUSY');
    }
    const rpcLimit = MAX_RPCS_PER_LAUNCH + (record.type === 'abort' ? 8 : 0);
    if (thread.requests.size >= rpcLimit || thread.input.writableLength + Buffer.byteLength(serialized) > 2 * MAX_RPC_BYTES) {
      throw httpError(429, 'PI_REQUEST_LIMIT');
    }
    if (record.type === 'prompt') thread.activePrompt = record.id;
    thread.requests.set(record.id, digest);
    thread.touchedAt = Date.now();
    thread.input.write(serialized + '\n');
    sendJson(res, 202, { accepted: true, duplicate: false });
  }

  const server = createServer({ requestTimeout: 60_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 }, (req, res) => {
    void handle(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      const code = status !== 500 && /^[A-Z0-9_]{1,80}$/.test(error.code ?? '') ? error.code : 'PI_SERVICE_ERROR';
      if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      req.resume();
      sendJson(res, status, { error: { code } });
    });
  });
  server.maxConnections = 256;
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, thread] of threads) {
      if (thread.filesActive) continue;
      if (thread.closed && now - thread.touchedAt > idleMs) threads.delete(key);
      else if (!thread.closed && now - thread.touchedAt > (thread.activePrompt ? activeIdleMs : idleMs)) thread.close();
    }
  }, Math.min(1000, idleMs));
  sweep.unref();
  const closeThreads = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sweep);
    for (const thread of threads.values()) {
      for (const subscriber of thread.subscribers) subscriber.end();
      thread.close();
    }
  };
  server.once('close', closeThreads);
  return { server, closeThreads };
}

export async function runPiHttpService(configFile) {
  const filename = resolve(configFile);
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 || (stat.mode & 0o077)) {
    throw Error('Pi service config must be a protected regular file');
  }
  const config = JSON.parse(readFileSync(filename, 'utf8'));
  const { host = '127.0.0.1', port = 8788, ...options } = config;
  if (host !== '127.0.0.1' && host !== '::1') throw Error('Pi HTTP service requires a loopback bind address');
  safeInteger(port, 1, 65535, 'port');
  const allowed = new Set(['dataDir', 'agentDir', 'tokens', 'allowOffice', 'officeExtension', 'extensionsDir',
    'eventLimit', 'eventBytes', 'idleMs', 'activeIdleMs', 'maxThreads', 'maxThreadsPerOwner']);
  if (Object.keys(options).some(key => !allowed.has(key))) throw Error('Invalid Pi service config');
  const { server, closeThreads } = await createPiHttpServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  function stop() {
    closeThreads();
    server.close();
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log('Pi HTTP service listening on loopback');
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const configFile = process.argv[2] ?? process.env.WORKBUDDY_PI_HTTP_CONFIG;
  if (!configFile || process.argv.length > 3) {
    console.error('Usage: node pi-http-server.mjs <config.json>');
    process.exitCode = 64;
  } else {
    runPiHttpService(configFile).catch(() => {
      console.error('Pi HTTP service setup failed');
      process.exitCode = 1;
    });
  }
}
