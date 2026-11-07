'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const { pipeline } = require('node:stream/promises');
const { createAiccTransport } = require('./official-aicc.cjs');

const INSTALL = Symbol.for('workbuddy.pi.official-model-bridge');
const BODY_LIMIT = 8 * 1024 * 1024;
const OFFICIAL_DOMAINS = ['workbuddy.cn', 'codebuddy.cn', 'codebuddy.ai', 'copilot.tencent.com', 'copilot.qq.com'];
const nativeError = (code, status = 400) => Object.assign(Error(code), { code, status });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const safeText = (value, fallback = '') => typeof value === 'string' && !/[\x00-\x1f]/.test(value) ? value.slice(0, 256) : fallback;

function assertOfficialUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw nativeError('UNTRUSTED_MODEL_ENDPOINT', 403); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || (url.port && url.port !== '443') ||
      !OFFICIAL_DOMAINS.some(domain => hostname === domain || hostname.endsWith('.' + domain))) throw nativeError('UNTRUSTED_MODEL_ENDPOINT', 403);
  return url;
}
function resolveTarget(model, product, kind) {
  const root = assertOfficialUrl(product.endpoint);
  if (model.url) {
    const configured = assertOfficialUrl(model.url);
    if (model.useCustomProtocol === true) return configured.href;
    const pathname = configured.pathname.replace(/\/+$/, '');
    if (kind === 'responses' && /\/chat\/completions$/.test(pathname)) { configured.pathname = pathname.replace(/\/chat\/completions$/, '/responses'); return configured.href; }
    if (/\/(?:chat\/completions|responses)$/.test(pathname)) return configured.href;
    configured.pathname = pathname + (kind === 'responses' ? '/responses' : '/chat/completions');
    return configured.href;
  }
  const base = root.pathname.replace(/\/+$/, '');
  root.pathname = (/\/v2$/.test(base) ? base : base + '/v2') + (kind === 'responses' ? '/responses' : '/chat/completions');
  return root.href;
}
function currentSession(manager) { return manager.currentSessionSubject?.getValue?.(); }
function identity(session) {
  if (!session?.auth?.accessToken || !session?.account?.uid) return '';
  const account = session.account;
  return JSON.stringify([account.uid, account.type || '', account.enterpriseId || '', session.auth.domain || '']);
}
function isAicc(model, product) {
  return model.id.endsWith('-aicc') || model.labels?.includes?.('enterprise:aicc') ||
    product.productFeaturesConfig?.AiccConfidentialModel?.models?.includes?.(model.id);
}
function aiccAllowed(model, product, session) {
  const list = product.productFeaturesConfig?.AiccConfidentialModel?.models;
  const ids = Array.isArray(list) && list.length ? list : ['glm-5.2-aicc'];
  return product.productFeatures?.AiccConfidentialModel === true && ids.includes(model.id) &&
    model.labels?.includes?.('enterprise:aicc') &&
    (String(product.networkEnvironment || '').toLowerCase() === 'ioa' || String(session?.account?.type || '').toLowerCase() === 'ultimate');
}
function modelKind(model, product) {
  if (isAicc(model, product)) return 'aicc';
  return /responses/i.test(String(model.api || '')) ? 'responses' : 'chat-completions';
}
function publicModel(model, product, session) {
  const kind = modelKind(model, product);
  const tokenLimit = value => (typeof value === 'number' || typeof value === 'string')
    && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
  // WorkBuddy also represents selectable windows as { defaultLength, supportedLengths }.
  // Converting that object to Number silently reduced Hy4's 300k window to 32k.
  const declaredWindow = tokenLimit(model.contextWindow) ?? tokenLimit(model.contextWindow?.defaultLength);
  const inputLimit = tokenLimit(model.maxInputTokens);
  const maximum = Math.min(inputLimit ?? 20000000, 20000000);
  const supported = Array.from(new Set(Array.isArray(model.contextWindow?.supportedLengths)
    ? model.contextWindow.supportedLengths : [])).filter(value => Number.isSafeInteger(value) && value > 1 && value <= maximum).sort((a, b) => a - b);
  const fallback = Math.max(2, Math.min(declaredWindow ?? inputLimit ?? 32768, maximum));
  const contextWindow = supported.length ? supported.includes(declaredWindow) ? declaredWindow : supported[0] : fallback;
  const maxTokens = Math.min(tokenLimit(model.maxOutputTokens) ?? 8192, contextWindow - 1, 2000000);
  const disabled = model.disabled === true || (kind === 'aicc' && !aiccAllowed(model, product, session));
  return { id: model.id, name: safeText(model.name, model.id), api: kind === 'responses' ? 'openai-responses' : 'openai-completions',
    contextWindow, maxTokens, maxInputTokens: inputLimit ? maximum : Math.max(contextWindow, ...supported),
    supportedContextWindows: supported.length ? supported : [contextWindow],
    reasoning: model.supportsReasoning === true, input: model.supportsImages === false || model.disabledMultimodal === true ? ['text'] : ['text', 'image'],
    supportsToolCall: model.supportsToolCall !== false, transport: kind, disabled,
    ...(disabled ? { disabledReason: kind === 'aicc' && !aiccAllowed(model, product, session) ? 'AICC_PERMISSION_REQUIRED' : 'MODEL_UNAVAILABLE' } : {}),
    capabilities: { reasoning: model.reasoning ? { supportedEfforts: model.reasoning.supportedEfforts, canDisableThinking: model.reasoning.canDisableThinking,
      defaultEffort: model.reasoning.defaultEffort, effort: model.reasoning.effort, summary: model.reasoning.summary } : undefined,
      onlyReasoning: model.onlyReasoning === true, useCustomProtocol: model.useCustomProtocol === true } };
}
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const OFFICIAL_THINKING_FIELD = '__workbuddy_pi_thinking_level';
/** Only the local control field selects a level; it is never sent to the official service. */
function applyOfficialThinking(payload, model, kind) {
  if (!Object.hasOwn(payload, OFFICIAL_THINKING_FIELD)) return payload;
  const { [OFFICIAL_THINKING_FIELD]: level, ...result } = payload;
  if (!THINKING_LEVELS.includes(level)) throw nativeError('MODEL_THINKING_INVALID', 409);
  const details = object(model.reasoning) ? model.reasoning : {};
  if (model.supportsReasoning !== true) {
    if (level !== 'off') throw nativeError('MODEL_THINKING_UNSUPPORTED', 409);
    return result;
  }
  const declared = Array.isArray(details.supportedEfforts) ? [...new Set(details.supportedEfforts)].filter(value => THINKING_LEVELS.includes(value) && value !== 'off') : [];
  const fixed = [details.defaultEffort, details.effort].find(value => THINKING_LEVELS.includes(value) && value !== 'off');
  const supported = declared.length ? declared : fixed ? [fixed] : ['minimal', 'low', 'medium', 'high'];
  const canDisable = typeof details.canDisableThinking === 'boolean' ? details.canDisableThinking : model.onlyReasoning !== true;
  if (level === 'off' ? !canDisable : !supported.includes(level)) throw nativeError('MODEL_THINKING_UNSUPPORTED', 409);
  if (kind === 'responses') {
    result.reasoning = { ...(object(result.reasoning) ? result.reasoning : {}), effort: level === 'off' ? 'none' : level };
    if (level !== 'off' && ['auto', 'concise', 'detailed'].includes(details.summary)) result.reasoning.summary = details.summary;
    delete result.reasoning_effort;
  } else {
    result.reasoning_effort = level === 'off' ? 'none' : level;
  }
  return result;
}
function selectConversationModels(product) {
  const models = Array.isArray(product.models) ? product.models : [];
  const agents = (Array.isArray(product.agents) ? product.agents : []).filter(agent => object(agent) && typeof agent.name === 'string');
  const agent = agents.find(agent => agent.tags?.includes?.('default')) || agents.find(agent => agent.name === 'cli') || agents.find(agent => agent.models?.length);
  if (!agent) return { models, agent: undefined };
  const result = [], selected = new Set();
  for (const id of Array.isArray(agent.models) ? agent.models : []) {
    const model = models.find(model => object(model) && (model.id === id || model.name === id));
    if (model && !selected.has(model.id)) { selected.add(model.id); result.push(model); }
  }
  for (const model of models) {
    if (!object(model) || (selected.size && !selected.has(model.id))) continue;
    if (model.tags?.includes?.('chat') && !result.some(entry => entry.id === model.id)) result.push(model);
  }
  return { models: result, agent };
}
function catalogDetails(product, session) {
  assertOfficialUrl(product.endpoint);
  const raw = Array.isArray(product.models) ? product.models : [], selection = selectConversationModels(product);
  const selected = new Set(selection.models), seen = new Set(), entries = [], excluded = [];
  for (const model of raw) {
    const valid = object(model) && typeof model.id === 'string' && model.id && model.id.length <= 256 && !/[\x00-\x1f]/.test(model.id);
    let reason;
    if (!valid) reason = 'INVALID_MODEL_DESCRIPTOR';
    else if (seen.has(model.id)) reason = 'DUPLICATE_MODEL_ID';
    else if (!selected.has(model)) reason = model.tags?.some?.(tag => /^(?:text|image)-to-(?:image|video)$/.test(tag)) ? 'AUXILIARY_MODALITY' : /^(?:completion|nes)-/.test(model.id) ? 'AUXILIARY_COMPLETION' : 'NOT_CLI_CONVERSATION_MODEL';
    else if (model.local === true || /^(?:custom|custom-local|local):/.test(model.id) || model.tags?.includes?.('custom')) reason = 'CUSTOM_OR_LOCAL_MODEL';
    if (!reason) { try { resolveTarget(model, product, modelKind(model, product)); } catch { reason = 'UNTRUSTED_MODEL_ENDPOINT'; } }
    if (valid) seen.add(model.id);
    if (reason) { excluded.push({ id: valid ? model.id : null, reason }); continue; }
    seen.add(model.id); entries.push({ model, public: publicModel(model, product, session) });
  }
  // Preserve the original agent model ordering and distinct variant IDs.
  entries.sort((left, right) => selection.models.indexOf(left.model) - selection.models.indexOf(right.model));
  return { entries, metadata: { productModelCount: raw.length, conversationModelCount: selection.models.length,
    exposedModelCount: entries.length, enabledModelCount: entries.filter(entry => !entry.public.disabled).length,
    excludedModelCount: excluded.length, selectedAgent: selection.agent ? { name: safeText(selection.agent.name), modelCount: Array.isArray(selection.agent.models) ? selection.agent.models.length : 0 } : null,
    exposedIds: entries.map(entry => entry.model.id), excluded } };
}
function catalog(product, session) { return catalogDetails(product, session).entries; }
function privateDirectory(directory) {
  if (!path.isAbsolute(directory)) throw Error('Official bridge directory must be absolute');
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw Error('Official bridge directory contains a symlink or conflict');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.getuid && fs.statSync(directory).uid !== process.getuid()) throw Error('Official bridge directory has a different owner');
  fs.chmodSync(directory, 0o700);
}
function writePrivate(filename, value) {
  const existing = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw Error('Official bridge locator is not a regular file');
  const temporary = filename + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try { fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, filename); }
  finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
async function readBody(request, limit = BODY_LIMIT) {
  let bytes = 0; const chunks = [];
  for await (const chunk of request) { bytes += chunk.length; if (bytes > limit) throw nativeError('REQUEST_TOO_LARGE', 413); chunks.push(chunk); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw nativeError('INVALID_JSON'); }
  if (!object(body)) throw nativeError('INVALID_BODY');
  return body;
}
function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(body));
}
function streamOf(data) {
  if (data && typeof data.pipe === 'function') return data;
  if (data && typeof data.getReader === 'function') return Readable.fromWeb(data);
  throw nativeError('OFFICIAL_STREAM_UNAVAILABLE', 502);
}
function upstreamCode(response) {
  const data = response?.data;
  if (object(data) && (typeof data.code === 'number' || typeof data.code === 'string')) return String(data.code).slice(0, 64);
  // Preserve the small set of standard OpenAI overflow identifiers needed by
  // Pi's compact-and-retry recovery. Never forward nested messages or arbitrary
  // provider payload strings that may contain private request material.
  const nested = object(data?.error) ? data.error.code : undefined;
  return ['context_length_exceeded', 'model_context_window_exceeded', 'request_too_large'].includes(nested) ? nested : undefined;
}

class TerminalSseMonitor extends Transform {
  constructor(onTerminal) { super(); this.decoder = new StringDecoder('utf8'); this.pending = ''; this.terminal = undefined; this.onTerminal = onTerminal; }
  event(frame) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    let terminal;
    if (data === '[DONE]') terminal = 'complete';
    else if (data) {
      let payload; try { payload = JSON.parse(data); } catch { return; }
      if (payload.type === 'response.completed' || payload.type === 'response.incomplete') terminal = 'complete';
      else if (payload.type === 'response.failed' || payload.type === 'error' || payload.error) terminal = 'error';
    }
    if (terminal && (!this.terminal || terminal === 'error')) { this.terminal = terminal; this.onTerminal(terminal); }
  }
  consume() {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.pending); if (!match) break;
      this.event(this.pending.slice(0, match.index)); this.pending = this.pending.slice(match.index + match[0].length);
    }
    if (Buffer.byteLength(this.pending) > 4 * 1024 * 1024) throw nativeError('OFFICIAL_SSE_EVENT_TOO_LARGE', 502);
  }
  _transform(chunk, encoding, callback) { try { this.pending += this.decoder.write(chunk); this.consume(); this.push(chunk); callback(); } catch (error) { callback(error); } }
  _flush(callback) {
    try { this.pending += this.decoder.end(); this.consume(); if (this.pending.trim()) this.event(this.pending);
      if (!this.terminal) throw nativeError('OFFICIAL_STREAM_TRUNCATED', 502); callback();
    } catch (error) { callback(error); }
  }
}

async function installOfficialModelBridge(options) {
  if (process.env.WORKBUDDY_PI_OFFICIAL_BUILD !== '1') throw Error('Official model bridge requires the Pi official build');
  if (globalThis[INSTALL]) return globalThis[INSTALL];
  const promise = startOfficialModelBridge(options).catch(error => { if (globalThis[INSTALL] === promise) delete globalThis[INSTALL]; throw error; });
  globalThis[INSTALL] = promise; return promise;
}

async function startOfficialModelBridge(options) {
  const { authenticationManager: auth, productManager, restOperations, configService } = options;
  const productEnvService = options.productEnvService || auth?.productEnvService;
  if (!auth?.currentSessionSubject || typeof auth.waitForSessionRefresh !== 'function' ||
      typeof auth.refreshSessionForAuthenticationFailure !== 'function' || !productEnvService?.getCurrent ||
      !productManager?.waitConfiguration || !restOperations?.request) throw Error('Official model bridge requires daemon services');
  const directory = options.bridgeDir || process.env.WORKBUDDY_PI_MODEL_BRIDGE_DIR;
  if (!directory) throw Error('Missing official model bridge directory');
  privateDirectory(directory);
  const locatorPath = path.join(directory, 'locator.json'), instanceId = crypto.randomUUID();
  const lifetimeMs = options.ticketLifetimeMs ?? 300000, now = options.now || Date.now;
  if (!Number.isFinite(lifetimeMs) || lifetimeMs < 1000) throw Error('Invalid bridge ticket lifetime');
  let key = identity(currentSession(auth)), ticket, expiresAt, port, generation = 0, closed = false, aicc;
  const active = new Set(), counters = { completed: 0, cancelled: 0, errors: 0, upstreamAborted: 0, upstreamClosedAfterTerminal: 0 };
  function revoke() { generation++; for (const controller of active) controller.abort(nativeError('OFFICIAL_SESSION_CHANGED', 401)); aicc?.close(); aicc = undefined; }
  function rotate() {
    if (closed || !port) return;
    ticket = crypto.randomBytes(32).toString('base64url'); expiresAt = now() + lifetimeMs;
    writePrivate(locatorPath, { version: 1, port, pid: process.pid, instanceId, ticket, expiresAt });
  }
  function checkIdentity() {
    const next = identity(currentSession(auth));
    if (next !== key) { key = next; revoke(); rotate(); }
    return key;
  }
  async function productSnapshot() {
    return { ...await productManager.waitConfiguration(), endpoint: productManager.getEndpoint(), networkEnvironment: await productEnvService.getCurrent() };
  }
  function cleanupLocator() {
    try { const current = JSON.parse(fs.readFileSync(locatorPath, 'utf8')); if (current.instanceId === instanceId) fs.unlinkSync(locatorPath); } catch {}
  }
  const exit = () => { closed = true; revoke(); cleanupLocator(); };
  const server = http.createServer(async (request, response) => {
    let controller, onClose, failed = false, upstreamStarted = false, terminal, streamFailed = false, succeeded = false;
    try {
      checkIdentity();
      if (request.headers.origin || request.headers.host !== `127.0.0.1:${port}`) throw nativeError('LOCAL_CLIENT_REQUIRED', 403);
      const supplied = request.headers.authorization;
      const expected = 'Bearer ' + ticket;
      if (typeof supplied !== 'string' || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) || now() >= expiresAt) {
        if (now() >= expiresAt) rotate(); throw nativeError('INVALID_BRIDGE_TICKET', 401);
      }
      if (request.url === '/v1/status' && request.method === 'GET') {
        let modelCount = 0, catalogMetadata;
        try { if (key) { const result = catalogDetails(await productSnapshot(), currentSession(auth)); modelCount = result.entries.length; catalogMetadata = result.metadata; } } catch {}
        sendJson(response, 200, { ready: true, authenticated: !!key, modelCount, catalogMetadata, activeRequests: active.size, ...counters }); return;
      }
      if (!checkIdentity()) throw nativeError('WORKBUDDY_LOGIN_REQUIRED', 401);
      if (request.url === '/healthz' && request.method === 'GET') { sendJson(response, 200, { status: 'ok', version: 1 }); return; }
      if (request.method === 'POST' && ['/v1/native/mcp/list', '/v1/native/mcp/call'].includes(request.url)) {
        const operation = request.url.endsWith('/call') ? 'call' : 'list';
        if (typeof options.nativeMcp?.[operation] !== 'function') throw nativeError('NATIVE_MCP_UNAVAILABLE', 503);
        const body = await readBody(request, 64 * 1024);
        if (!/^pi-thread-[a-f0-9-]{36}$/.test(body.threadId) || typeof body.cwd !== 'string'
          || !path.isAbsolute(body.cwd) || body.cwd.includes('\0') || Object.keys(body).some(field =>
            !['threadId', 'turnId', 'cwd', 'connectors', 'serverId', 'rawName', 'arguments'].includes(field))) throw nativeError('INVALID_BODY');
        if (operation === 'call' && !/^pi-turn-[a-f0-9-]{36}$/.test(body.turnId)) throw nativeError('INVALID_BODY');
        const owner = generation;
        controller = new AbortController(); active.add(controller);
        onClose = () => { if (!response.writableEnded) controller.abort(nativeError('CLIENT_CANCELED', 499)); };
        response.once('close', onClose); request.once('aborted', onClose);
        if (!checkIdentity() || generation !== owner) throw nativeError('OFFICIAL_SESSION_CHANGED', 401);
        const result = await options.nativeMcp[operation]({ ...body, signal: controller.signal });
        if (!checkIdentity() || generation !== owner) throw nativeError('OFFICIAL_SESSION_CHANGED', 401);
        controller.signal.throwIfAborted();
        if (Buffer.byteLength(JSON.stringify(result ?? null)) > 384 * 1024) throw nativeError('NATIVE_MCP_RESULT_LIMIT', 413);
        sendJson(response, 200, { result: result ?? null }); succeeded = true; return;
      }
      const product = await productSnapshot();
      const result = catalogDetails(product, currentSession(auth)), entries = result.entries;
      if (request.url === '/v1/models' && request.method === 'GET') { sendJson(response, 200, { object: 'list', data: entries.map(entry => entry.public), metadata: result.metadata }); return; }
      if (request.method !== 'POST' || !['/v1/chat/completions', '/v1/responses'].includes(request.url)) throw nativeError('NOT_FOUND', 404);
      const body = await readBody(request), entry = entries.find(entry => entry.model.id === body.model);
      if (!entry) throw nativeError('BUILTIN_MODEL_REQUIRED', 403);
      if (entry.public.disabled) throw nativeError(entry.public.disabledReason, 403);
      const kind = entry.public.transport;
      if ((request.url === '/v1/responses') !== (kind === 'responses')) throw nativeError('MODEL_API_MISMATCH', 409);
      if ((kind === 'responses' && body.input === undefined) || (kind !== 'responses' && !Array.isArray(body.messages))) throw nativeError('MODEL_INPUT_REQUIRED');
      controller = new AbortController(); active.add(controller); const ownerGeneration = generation;
      controller.signal.addEventListener('abort', () => { if (upstreamStarted) counters[terminal ? 'upstreamClosedAfterTerminal' : 'upstreamAborted']++; }, { once: true });
      onClose = () => { if (!response.writableEnded) controller.abort(nativeError('CLIENT_CANCELED', 499)); };
      response.once('close', onClose); request.once('aborted', onClose);
      if (!checkIdentity() || generation !== ownerGeneration) throw nativeError('OFFICIAL_SESSION_CHANGED', 401);
      const target = resolveTarget(entry.model, product, kind);
      const fields = object(entry.model.providerData) ? entry.model.providerData : {};
      const payload = applyOfficialThinking({ ...fields, ...body, model: entry.model.id }, entry.model, kind);
      const extra = { ...(object(entry.model.extra_vars) ? entry.model.extra_vars : {}), ...(object(fields.extra_vars) ? fields.extra_vars : {}), ...(object(body.extra_vars) ? body.extra_vars : {}) };
      if (Object.keys(extra).length) payload.extra_vars = extra;
      const requestId = crypto.randomUUID(), messageId = crypto.randomUUID();
      const optimization = await configService?.get?.('enableModelOptimization');
      const optimize = typeof optimization === 'boolean' ? optimization : optimization?.enabled === true;
      const applicationName = safeText(product.applicationName, 'WorkBuddy');
      const appVersion = safeText(process.env.WORKBUDDY_APP_VERSION || product.productVersion, '5.9.2');
      const clientHeaders = await options.getClientHeaders?.() || { 'X-IDE-Type': applicationName, 'X-IDE-Name': applicationName, 'User-Agent': `${applicationName}/${appVersion}` };
      const headers = { ...clientHeaders, 'Content-Type': 'application/json', Accept: body.stream ? 'text/event-stream' : 'application/json',
        'X-Conversation-ID': safeText(request.headers['x-workbuddy-pi-thread-id'], crypto.randomUUID()),
        'X-Conversation-Request-ID': safeText(request.headers['x-workbuddy-pi-turn-id'], crypto.randomUUID()),
        'X-Conversation-Message-ID': messageId, 'X-Request-ID': requestId, 'X-Agent-Intent': 'craft', 'X-Agent-Runtime': 'local-agent', 'X-Private-Data': String(!optimize) };
      let protectedRequest;
      if (kind === 'aicc') {
        aicc ||= (options.createAiccTransport || createAiccTransport)({ restOperations, authenticationManager: auth, trustedControlUrl: () => {
          const root = assertOfficialUrl(productManager.getEndpoint()); root.pathname = root.pathname.replace(/\/v2\/?$/, '').replace(/\/$/, '') + '/v1/aicc'; return root.href;
        } });
        protectedRequest = await aicc.prepare(entry.model, payload, controller.signal);
      }
      try {
        const data = protectedRequest?.body ?? payload;
        Object.assign(headers, protectedRequest?.headers);
        async function send() {
          await auth.waitForSessionRefresh(); controller.signal.throwIfAborted();
          if (generation !== ownerGeneration || !checkIdentity()) throw nativeError('OFFICIAL_SESSION_CHANGED', 401);
          upstreamStarted = true;
          return restOperations.request({ url: target, method: 'POST', data, headers, signal: controller.signal,
            responseType: body.stream ? 'stream' : 'json', validateStatus: () => true, maxRedirects: 0,
            timeout: 1200000, maxBodyLength: BODY_LIMIT, maxContentLength: 32 * 1024 * 1024 });
        }
        let upstream = await send();
        if (upstream.status === 401 && !controller.signal.aborted) {
          upstream.data?.destroy?.();
          try { await auth.refreshSessionForAuthenticationFailure(); } catch { throw nativeError('WORKBUDDY_LOGIN_REQUIRED', 401); }
          if (generation === ownerGeneration && checkIdentity()) upstream = await send();
        }
        if (!(upstream.status >= 200 && upstream.status < 300)) {
          const code = upstreamCode(upstream); upstream.data?.destroy?.();
          throw Object.assign(nativeError('OFFICIAL_REQUEST_REJECTED', upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502), { upstreamStatus: upstream.status, upstreamCode: code });
        }
        controller.signal.throwIfAborted();
        if (body.stream) {
          const source = streamOf(upstream.data);
          const monitor = new TerminalSseMonitor(value => { terminal = value; });
          const onError = () => { if (!controller.signal.aborted) streamFailed = true; };
          source.once('error', onError); monitor.once('error', onError);
          const protection = protectedRequest?.transform(); protection?.once('error', onError);
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Request-ID': requestId });
          const streams = protection ? [source, protection, monitor, response] : [source, monitor, response];
          await pipeline(...streams, { signal: controller.signal });
        } else sendJson(response, 200, protectedRequest ? protectedRequest.decode(upstream.data) : upstream.data);
        succeeded = true;
      } finally { protectedRequest?.close(); }
    } catch (error) {
      failed = true;
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
      const code = /^[A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'OFFICIAL_BRIDGE_ERROR';
      if (!response.headersSent) sendJson(response, status, { error: { type: 'workbuddy_official_error', code,
        message: code, ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}), ...(error.upstreamCode ? { upstreamCode: error.upstreamCode } : {}) } });
      else response.destroy();
    } finally {
      if (controller) {
        if (terminal === 'error' || streamFailed) counters.errors++;
        else if (terminal === 'complete' || succeeded) counters.completed++;
        else if (controller.signal.aborted) counters.cancelled++;
        else if (failed) counters.errors++;
        active.delete(controller);
      }
      if (onClose) { response.removeListener('close', onClose); request.removeListener('aborted', onClose); }
    }
  });
  server.headersTimeout = 10000; server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port; server.unref(); rotate();
  const subscription = auth.currentSessionSubject.subscribe?.(() => { try { checkIdentity(); } catch { revoke(); } });
  const timer = setInterval(() => { try { checkIdentity(); rotate(); } catch { revoke(); } }, Math.max(1000, lifetimeMs * 0.8)); timer.unref();
  process.once('exit', exit);
  return { version: 1, locatorPath, port,
    async close() {
      if (closed) return; closed = true; clearInterval(timer); process.removeListener('exit', exit);
      if (typeof subscription === 'function') subscription(); else subscription?.unsubscribe?.();
      revoke(); cleanupLocator(); server.closeIdleConnections?.();
      await new Promise(resolve => server.close(resolve));
    } };
}

module.exports = { installOfficialModelBridge, startOfficialModelBridge, assertOfficialUrl, resolveTarget, catalog, catalogDetails, selectConversationModels, publicModel, applyOfficialThinking, TerminalSseMonitor };
