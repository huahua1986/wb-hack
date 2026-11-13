#!/opt/workbuddy-runtime/node-v24.21.0-linux-x64/bin/node
'use strict';

const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { mkdirSync, mkdtempSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { basename, join } = require('node:path');
const { Transform } = require('node:stream');

const THREAD_ID = /^pi-thread-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TURN_ID = /^pi-turn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OFFICE_ID = 'builtin-office:editor-sdk';
const OFFICE_TOOLS = new Set(['open_file', 'close_file', 'office_catalog', 'office_read', 'office_edit', 'save_file']);
const EXTENSIONS = {
  'native-feature-extension.mjs': '9b244bdaa194c066908c9948e8a3266f709583576c932c9cc3f82127f88fbe53',
  'approval-extension.mjs': '53c785dbcba7a0d2607c3de43de3122a8eb4f68808c4dfffac5ce11089a48cbd',
};
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_PLAIN_RECORD_BYTES = 512 * 1024;
const MAX_CONTEXT_BYTES = 192 * 1024;
const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 512 * 1024;
const COMMANDS = new Set(['get_state', 'get_session_stats', 'prompt', 'abort']);
const OBJECT = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, keys) => OBJECT(value) && Object.keys(value).every(key => keys.includes(key));
const rpcId = id => typeof id === 'string' && id.length >= 1 && id.length <= 128 && !/[\x00-\x1f\x7f]/.test(id);
const shortText = (text, max) => typeof text === 'string' && Buffer.byteLength(text) <= max && !text.includes('\0');

function invalid() { return Error('Invalid or unsupported Pi RPC record'); }
function parse(record) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record)); }

function validateContext(context, thread) {
  if (!onlyKeys(context, ['version', 'threadId', 'turnId', 'instructions', 'tools'])
    || context.version !== 1 || context.threadId !== thread || !TURN_ID.test(context.turnId)
    || !shortText(context.instructions, 16 * 1024) || !Array.isArray(context.tools)
    || !context.tools.length || context.tools.length > OFFICE_TOOLS.size
    || Buffer.byteLength(JSON.stringify(context)) > MAX_CONTEXT_BYTES) throw invalid();

  const names = new Set();
  const tools = context.tools.map(tool => {
    if (!onlyKeys(tool, ['name', 'rawName', 'label', 'description', 'parameters'])
      || !OFFICE_TOOLS.has(tool.rawName) || !shortText(tool.label, 2048)
      || !shortText(tool.description, 16 * 1024) || !OBJECT(tool.parameters)
      || tool.parameters.type !== 'object' || !OBJECT(tool.parameters.properties)) throw invalid();
    const name = 'wb_mcp_' + createHash('sha256').update(OFFICE_ID + '\0' + tool.rawName).digest('hex').slice(0, 24);
    const schema = JSON.stringify(tool.parameters);
    if (tool.name !== name || names.has(name) || Buffer.byteLength(schema) > MAX_SCHEMA_BYTES
      || /"(?:__proto__|constructor|prototype|\$schema|\$id|\$dynamicRef)"\s*:/.test(schema)
      || /"\$ref"\s*:\s*"(?!#)/.test(schema)) throw invalid();
    names.add(name);
    return { name, label: tool.label, description: tool.description, parameters: tool.parameters };
  });
  return { version: 1, threadId: thread, turnId: context.turnId, instructions: context.instructions, tools };
}

function extensionFiles(directory) {
  return Object.entries(EXTENSIONS).map(([name, digest]) => {
    const file = join(directory, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 || (stat.mode & 0o022)
      || createHash('sha256').update(readFileSync(file)).digest('hex') !== digest) {
      throw Error('Remote Office extension integrity check failed');
    }
    return file;
  });
}

// Only LF delimits the protocol. Unicode separators are valid inside JSON strings.
function createFramer(maxBytes) {
  let parts = [], size = 0;
  return function* frames(chunk) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      if (size + part.length > maxBytes) throw invalid();
      if (part.length) parts.push(part);
      size += part.length;
      if (newline === -1) return;
      const complete = Buffer.concat(parts, size);
      parts = [];
      size = 0;
      yield complete;
      start = newline + 1;
    }
  };
}

function runLauncher({
  thread, office, home, input = process.stdin, output = process.stdout, error = process.stderr,
  launchPi = spawn, extensionsDir = '/usr/local/libexec/workbuddy-pi-extensions',
  manageSignals = true,
  onExit = code => { process.exitCode = code; },
}) {
  process.umask(0o077);
  const state = join(home, '.workbuddy-pi-ssh');
  const workspace = join(state, 'workspaces', thread);
  const sessions = join(state, 'sessions');
  for (const directory of [state, join(state, 'workspaces'), workspace, sessions]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
      throw Error('Invalid Pi thread directory');
    }
  }
  const session = join(sessions, thread + '.jsonl');
  const extensions = office ? extensionFiles(extensionsDir) : [];
  const contextDir = office ? mkdtempSync(join(state, '.office-wire-')) : undefined;
  const contextFile = contextDir ? join(contextDir, 'context.json') : undefined;
  const pending = new Map();
  let child, context, signature, activePromptId, consumed = false;
  let closing = false, failed = false, shutdownTimer;

  function shutdown() {
    if (closing) return;
    closing = true;
    input.destroy();
    if (!child) {
      finish(failed ? 65 : 0);
      return;
    }
    if (child.stdin.writable) child.stdin.end('{"type":"abort"}\n');
    shutdownTimer = setTimeout(() => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch (cause) {
        if (cause.code !== 'ESRCH') error.write('Unable to stop remote Pi.\n');
      }
    }, 2500);
    shutdownTimer.unref();
  }

  function finish(code) {
    clearTimeout(shutdownTimer);
    if (manageSignals) {
      process.removeListener('SIGHUP', shutdown);
      process.removeListener('SIGTERM', shutdown);
    }
    input.destroy();
    if (contextDir) rmSync(contextDir, { recursive: true, force: true });
    onExit(failed ? 65 : code ?? 1);
  }

  function observe(record) {
    if (record.type === 'agent_settled' || (record.type === 'response' && record.id === activePromptId
      && (!record.success || record.data?.disposition === 'handled'))) {
      activePromptId = undefined;
      pending.clear();
    }
    if (record.type !== 'extension_ui_request' || !['confirm', 'input'].includes(record.method)) return;
    if (!activePromptId || !rpcId(record.id) || pending.has(record.id) || pending.size >= 32) throw invalid();
    const confirm = record.method === 'confirm';
    const payload = confirm ? record.message : record.placeholder;
    if (!shortText(payload, 48 * 1024)) throw invalid();
    const value = JSON.parse(payload);
    const toolName = confirm ? value?.toolName : value?.name;
    const args = confirm ? value?.input : value?.arguments;
    if (!context.tools.some(tool => tool.name === toolName) || !OBJECT(args) || !rpcId(value.toolCallId)) throw invalid();
    if (confirm
      ? record.title !== 'WorkBuddy Pi 操作确认' || value.protocol !== 'workbuddy-host-approval-v1'
      : record.title !== 'WorkBuddy Native MCP' || value.protocol !== 'workbuddy-native-mcp-call-v1'
        || value.threadId !== thread || value.turnId !== context.turnId) throw invalid();
    pending.set(record.id, record.method);
  }

  function start() {
    const tools = office
      ? ['--no-builtin-tools', '--tools', context.tools.map(tool => tool.name).join(','),
        ...extensions.flatMap(file => ['--extension', file])]
      : ['--no-tools'];
    child = launchPi('/usr/bin/flock', ['-n', session + '.lock', '/usr/local/bin/pi',
      '--mode', 'rpc', '--provider', 'tokenlink', '--model', 'hy4', '--thinking', 'off',
      '--offline', '--no-extensions', '--no-skills', '--no-mcp',
      '--no-context-files', '--no-prompt-templates', '--session', session, ...tools,
    ], {
      cwd: workspace, detached: true, stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
        PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0',
        ...(office ? { WORKBUDDY_PI_NATIVE_CONTEXT_FILE: contextFile } : {}),
      },
    });
    child.stdin.on('error', shutdown);
    child.on('error', () => { failed = true; error.write('Unable to start remote Pi.\n'); });
    child.on('close', finish);
    if (!office) {
      child.stdout.pipe(output, { end: false });
      return;
    }
    const childFrames = createFramer(8 * 1024 * 1024);
    const track = new Transform({
      transform(chunk, _encoding, callback) {
        try {
          for (const frame of childFrames(chunk)) {
            observe(parse(frame));
            this.push(Buffer.concat([frame, Buffer.from('\n')]));
          }
          callback();
        } catch (cause) { callback(cause); }
      },
    });
    track.on('error', () => { failed = true; shutdown(); });
    child.stdout.on('error', () => { failed = true; shutdown(); });
    child.stdout.pipe(track).pipe(output, { end: false });
  }

  function configure(message) {
    if (!onlyKeys(message, ['type', 'id', 'context']) || activePromptId) throw invalid();
    const next = validateContext(message.context, thread);
    const nextSignature = JSON.stringify(next.tools);
    if (next.turnId === context?.turnId || (signature && signature !== nextSignature)) throw invalid();
    const temporary = contextFile + '.' + randomUUID();
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, contextFile);
    } finally { rmSync(temporary, { force: true }); }
    context = next;
    signature = nextSignature;
    consumed = false;
    if (!child) start();
    output.write(JSON.stringify({
      type: 'response', id: message.id, command: 'office_configure', success: true, data: { turnId: context.turnId },
    }) + '\n');
    return true;
  }

  function extensionResponse(message) {
    if (!onlyKeys(message, ['id', 'type', 'confirmed', 'value'])) throw invalid();
    const method = pending.get(message.id);
    if (method === 'confirm') {
      if (typeof message.confirmed !== 'boolean' || Object.hasOwn(message, 'value')) throw invalid();
    } else if (method === 'input') {
      if (!shortText(message.value, MAX_RESULT_BYTES) || Object.hasOwn(message, 'confirmed')) throw invalid();
      const value = JSON.parse(message.value);
      if (!(onlyKeys(value, ['ok', 'result']) && value.ok === true && Object.hasOwn(value, 'result'))
        && !(onlyKeys(value, ['ok', 'code']) && value.ok === false && /^NATIVE_[A-Z_]{1,80}$/.test(value.code))) throw invalid();
    } else throw invalid();
    pending.delete(message.id);
    return child.stdin.write(JSON.stringify(message) + '\n');
  }

  function forward(record) {
    const message = parse(record);
    if (!rpcId(message?.id)) throw invalid();
    if (office && message.type === 'office_configure') return configure(message);
    if (!child) throw invalid();
    if (office && message.type === 'extension_ui_response') return extensionResponse(message);
    if (!COMMANDS.has(message.type) || !onlyKeys(message, ['type', 'id', 'message', 'images'])
      || (message.type === 'prompt' ? typeof message.message !== 'string' : 'message' in message || 'images' in message)
      || ('images' in message && (!Array.isArray(message.images) || message.images.length))) throw invalid();
    const { id, type } = message;
    if (office && type === 'prompt') {
      if (activePromptId || consumed || !shortText(message.message, MAX_PLAIN_RECORD_BYTES)) throw invalid();
      activePromptId = id;
      consumed = true;
    }
    return child.stdin.write(JSON.stringify({ id, type, ...(type === 'prompt' ? { message: message.message } : {}) }) + '\n');
  }

  const frames = createFramer(office ? MAX_RECORD_BYTES : MAX_PLAIN_RECORD_BYTES);
  function consume(records) {
    try {
      for (;;) {
        if (closing) return;
        const next = records.next();
        if (next.done) {
          input.resume();
          return;
        }
        if (!forward(next.value)) {
          child.stdin.once('drain', () => consume(records));
          return;
        }
      }
    } catch {
      failed = true;
      error.write('Invalid or unsupported Pi RPC input.\n');
      shutdown();
    }
  }

  if (!office) start();
  input.on('data', chunk => {
    input.pause();
    consume(frames(chunk));
  });
  input.on('end', shutdown);
  input.on('error', shutdown);
  output.on('error', shutdown);
  if (manageSignals) {
    process.on('SIGHUP', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

if (require.main === module) {
  const thread = process.argv[2];
  if (process.argv.length !== 3 || !THREAD_ID.test(thread ?? '') || !process.env.SSH_CONNECTION) {
    console.error('Expected one WorkBuddy Pi thread ID over SSH.');
    process.exitCode = 64;
  } else {
    try {
      runLauncher({ thread, office: basename(process.argv[1]) === 'workbuddy-pi-office-rpc', home: homedir() });
    } catch {
      console.error('Remote Pi launcher setup failed.');
      process.exitCode = 65;
    }
  }
}

module.exports = { runLauncher };
