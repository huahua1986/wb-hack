import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { NativeBridgeClient } from '../src/native-bridge.mjs';
const require = createRequire(import.meta.url);
const { startOfficialModelBridge, installOfficialModelBridge, resolveTarget, catalog, catalogDetails, TerminalSseMonitor, assertOfficialUrl } = require('../src/official-model-bridge.cjs');
const { loadSdk, AiccSseTransform, checkProtected, createAiccTransport } = require('../src/official-aicc.cjs');
const hasLocalSdk = fs.existsSync(new URL('../src/official-aicc-sdk.mjs', import.meta.url));

function subject(value) {
  const listeners = new Set();
  return { getValue: () => value, next(next) { value = next; for (const listener of listeners) listener(next); },
    subscribe(listener) { listeners.add(listener); listener(value); return { unsubscribe: () => listeners.delete(listener) }; } };
}
const session = (uid = 'fixture-user', token = 'fixture-official-token') => ({ account: { uid, type: 'ultimate', enterpriseId: 'fixture-enterprise' }, auth: { accessToken: token, domain: 'www.workbuddy.cn' } });
function product() { return { applicationName: 'WorkBuddy', endpoint: 'https://www.workbuddy.cn', productFeatures: { AiccConfidentialModel: true }, models: [
  { id: 'hy4', name: 'Hy4', supportsToolCall: true, supportsImages: false, maxInputTokens: 100000, maxOutputTokens: 16000 },
  { id: 'responses-model', name: 'Responses', api: 'openai-responses', url: 'https://www.workbuddy.cn/v2/responses' },
  { id: 'custom-protocol', useCustomProtocol: true, url: 'https://copilot.tencent.com/special/model-wire', extra_vars: { origin: 'fixture' } },
  { id: 'glm-5.2-aicc', labels: ['enterprise:aicc'] },
  { id: 'disabled', disabled: true, apiKey: 'must-not-leak' },
  { id: 'unsafe', url: 'https://evil.invalid/v2/chat/completions' },
  { id: 'custom:mine', tags: ['custom'], url: 'https://www.workbuddy.cn/v2' },
  { id: 'local:mine', local: true },
] }; }
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wb-official-bridge-'));
  const current = subject(session()), configuration = product(), calls = [];
  const auth = { currentSessionSubject: current, waitForSessionRefresh: async () => {}, productEnvService: { getCurrent: async () => configuration.networkEnvironment },
    refreshSessionForAuthenticationFailure: async () => { current.next(session('fixture-user', 'fixture-refreshed-token')); } };
  const restOperations = { async request(request) { calls.push(request); return options.request ? options.request(request) : { status: 200, data: { id: 'fixture-completion', model: request.data.model, choices: [{ message: { role: 'assistant', content: 'fixture result' }, finish_reason: 'stop' }] } }; } };
  const bridge = await startOfficialModelBridge({ bridgeDir: directory, authenticationManager: auth,
    productManager: { waitConfiguration: async () => configuration, getEndpoint: () => configuration.endpoint, getCurrentConfiguration: () => configuration },
    restOperations, ...options });
  t.after(async () => { await bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const locator = () => JSON.parse(fs.readFileSync(path.join(directory, 'locator.json')));
  function call(route, body, extra = {}) { const loc = locator(); return fetch(`http://127.0.0.1:${loc.port}${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + loc.ticket, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra.headers }, ...(body ? { body: JSON.stringify(body) } : {}), ...extra, headers: { Authorization: 'Bearer ' + loc.ticket, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra.headers } }); }
  return { bridge, locator, call, calls, current, auth, configuration, directory };
}
async function until(predicate) { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('condition did not settle'); }

test('native MCP routes share official login isolation, accept only bounded local context and never replay calls', async t => {
  const calls = [];
  const f = await fixture(t, { nativeMcp: { async list(value) { calls.push(['list', value]); return [{ serverId: 'connector:fixture', rawName: 'lookup', inputSchema: { type: 'object' } }]; },
    async call(value) { calls.push(['call', value]); throw Object.assign(Error('fixture failure with private data'), { code: 'NATIVE_MCP_CALL_FAILED', status: 502 }); } } });
  const params = { threadId: 'pi-thread-12345678-1234-1234-1234-123456789abc', cwd: f.directory, connectors: ['fixture'] };
  const list = await f.call('/v1/native/mcp/list', params); assert.equal(list.status, 200);
  assert.equal((await list.json()).result[0].rawName, 'lookup');
  const call = await f.call('/v1/native/mcp/call', { ...params, turnId: 'pi-turn-12345678-1234-1234-1234-123456789abc', serverId: 'connector:fixture', rawName: 'lookup', arguments: {} });
  assert.equal(call.status, 502); assert.equal((await call.text()).includes('private data'), false);
  assert.equal(calls.filter(value => value[0] === 'call').length, 1);
  const native = new NativeBridgeClient(f.directory);
  assert.equal((await native.listTools(params))[0].rawName, 'lookup');
  await assert.rejects(native.callTool({ ...params, turnId: 'pi-turn-12345678-1234-1234-1234-123456789abc', serverId: 'connector:fixture', rawName: 'lookup', arguments: {} }), { code: 'NATIVE_MCP_UNAVAILABLE', mayHaveExecuted: true });
  assert.equal(calls.filter(value => value[0] === 'call').length, 2);
  assert.equal((await f.call('/v1/native/mcp/list', { ...params, url: 'https://evil.invalid' })).status, 400);
  assert.equal((await f.call('/v1/native/mcp/list', { ...params, cwd: 'relative' })).status, 400);
  assert.equal((await f.call('/v1/native/mcp/list', params, { headers: { Origin: 'https://example.invalid' } })).status, 403);
  f.current.next(null);
  assert.equal((await f.call('/v1/native/mcp/list', params)).status, 401);
});

test('target selection rejects nonofficial/local/redirect origins and preserves complete special URLs', () => {
  for (const value of ['http://www.workbuddy.cn/v2', 'https://127.0.0.1/v2', 'https://workbuddy.cn.evil.invalid/v2', 'https://evilworkbuddy.cn/v2', 'https://a@www.workbuddy.cn/v2', 'https://www.workbuddy.cn:8787/v2', 'https://www.workbuddy.cn/v2?token=x']) assert.throws(() => assertOfficialUrl(value));
  assert.equal(resolveTarget({ id: 'hy4' }, product(), 'chat-completions'), 'https://www.workbuddy.cn/v2/chat/completions');
  assert.equal(resolveTarget({ id: 'x', url: 'https://www.workbuddy.cn/v2/responses' }, product(), 'responses'), 'https://www.workbuddy.cn/v2/responses');
  assert.equal(resolveTarget({ id: 'x', url: 'https://www.workbuddy.cn/v2/chat/completions' }, product(), 'responses'), 'https://www.workbuddy.cn/v2/responses');
  assert.equal(resolveTarget({ id: 'x', useCustomProtocol: true, url: 'https://www.workbuddy.cn/vendor/protocol' }, product(), 'chat-completions'), 'https://www.workbuddy.cn/vendor/protocol');
  assert.equal(resolveTarget({ id: 'x' }, { endpoint: 'https://www.workbuddy.cn/v2/' }, 'responses'), 'https://www.workbuddy.cn/v2/responses');
});

test('safe directory contains all builtin transport types but no secret/model endpoint or custom fallback', async t => {
  const f = await fixture(t), response = await f.call('/v1/models'), text = await response.text(), result = JSON.parse(text);
  assert.equal(response.status, 200); assert.equal(result.data.length, 5);
  assert.deepEqual(result.data.map(m => m.api), ['openai-completions', 'openai-responses', 'openai-completions', 'openai-completions', 'openai-completions']);
  assert.equal(result.data.find(m => m.id === 'hy4').supportsToolCall, true);
  for (const secret of ['must-not-leak', 'fixture-official-token', 'fixture-enterprise', 'fixture-user', 'https://']) assert.equal(text.includes(secret), false);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.bridge.locatorPath).mode & 0o777, 0o600);
  assert.equal(typeof f.locator().expiresAt, 'number');
});

test('selectable native context windows use the declared default instead of the 32k fallback', () => {
  const config = { ...product(), models: [{ id: 'hy4', contextWindow: { defaultLength: 300000, supportedLengths: [300000, 600000, 960000] }, maxInputTokens: 960000, maxOutputTokens: 64000 }] };
  let model = catalog(config, session())[0].public;
  assert.equal(model.contextWindow, 300000); assert.equal(model.maxTokens, 64000);
  config.models[0].contextWindow = { supportedLengths: [300000, 960000] };
  assert.equal(catalog(config, session())[0].public.contextWindow, 300000);
  config.models[0].contextWindow = { defaultLength: 1200000 };
  assert.equal(catalog(config, session())[0].public.contextWindow, 960000);
  config.models[0] = { id: 'hy4', contextWindow: 4096, maxOutputTokens: 64000 };
  model = catalog(config, session())[0].public;
  assert.equal(model.contextWindow, 4096); assert.equal(model.maxTokens, 4095);
  for (const bad of [true, [], {}, -1, Infinity, 'not-a-number']) {
    config.models[0] = { id: 'hy4', contextWindow: bad, maxInputTokens: 100000, maxOutputTokens: bad };
    model = catalog(config, session())[0].public;
    assert.equal(model.contextWindow, 100000); assert.equal(model.maxTokens, 8192);
  }
});

test('native context tiers retain their actual default and expose only supported bounded lengths', () => {
  const config = { ...product(), models: [{ id: 'hy4', maxInputTokens: 960000, maxOutputTokens: 64000,
    contextWindow: { defaultLength: 600000, supportedLengths: [960000, 300000, 600000, 300000, -1, 1.5, '300000', 1200000] } }] };
  const model = catalog(config, session())[0].public;
  assert.equal(model.contextWindow, 600000);
  assert.deepEqual(model.supportedContextWindows, [300000, 600000, 960000]);
  assert.equal(model.maxInputTokens, 960000); assert.equal(model.maxTokens, 64000);
});

test('bridge rejects unauthenticated/browser clients and never authorizes official requests using local ticket', async t => {
  const f = await fixture(t), loc = f.locator(), url = `http://127.0.0.1:${loc.port}/v1/models`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await f.call('/v1/models', undefined, { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  const response = await f.call('/v1/chat/completions', { model: 'hy4', messages: [{ role: 'user', content: 'hello' }], stream: false }, { headers: { 'x-workbuddy-pi-thread-id': 'fixture-thread', 'x-workbuddy-pi-turn-id': 'fixture-turn' } });
  assert.equal(response.status, 200); await response.json();
  const request = f.calls[0];
  assert.equal(request.url, 'https://www.workbuddy.cn/v2/chat/completions');
  assert.equal(request.headers.Authorization, undefined); assert.equal(JSON.stringify(request).includes(loc.ticket), false);
  assert.equal(request.headers['X-Private-Data'], 'true');
  assert.equal(request.headers['X-Conversation-ID'], 'fixture-thread'); assert.equal(request.headers['X-Conversation-Request-ID'], 'fixture-turn');
  assert.equal(request.headers['X-Agent-Runtime'], 'local-agent'); assert.notEqual(request.headers['X-Conversation-Message-ID'], request.headers['X-Request-ID']);
  assert.equal(request.maxRedirects, 0); assert.ok(request.signal instanceof AbortSignal);
});

test('full special protocol URL, real extra_vars, and responses payload survive the bridge', async t => {
  const f = await fixture(t);
  const special = await f.call('/v1/chat/completions', { model: 'custom-protocol', messages: [{ role: 'user', content: 'hi' }], extra_vars: { turn: 1 } }); await special.json();
  assert.equal(f.calls[0].url, 'https://copilot.tencent.com/special/model-wire'); assert.deepEqual(f.calls[0].data.extra_vars, { origin: 'fixture', turn: 1 });
  const responses = await f.call('/v1/responses', { model: 'responses-model', input: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', name: 'fixture' }] }); await responses.json();
  assert.equal(f.calls[1].url, 'https://www.workbuddy.cn/v2/responses'); assert.deepEqual(f.calls[1].data.tools, [{ type: 'function', name: 'fixture' }]);
  assert.equal((await f.call('/v1/chat/completions', { model: 'responses-model', messages: [] })).status, 409);
  assert.equal((await f.call('/v1/chat/completions', { model: 'custom:mine', messages: [] })).status, 403);
});

test('SSE tool/reasoning/usage frames and multibyte content pass through without reexecution', async t => {
  const frames = 'data: {"choices":[{"delta":{"reasoning_content":"推理"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"read","arguments":"{}"}}]}}]}\n\ndata: {"choices":[{"delta":{"content":"你好"},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
  const f = await fixture(t, { request: async () => ({ status: 200, data: Readable.from([Buffer.from(frames).subarray(0, 31), Buffer.from(frames).subarray(31)]) }) });
  const response = await f.call('/v1/chat/completions', { model: 'hy4', messages: [], stream: true });
  assert.equal(await response.text(), frames); assert.equal(f.calls.length, 1);
  await until(async () => (await (await f.call('/v1/status')).json()).completed === 1);
});

test('client cancel closes actual upstream and status records zero active generators', async t => {
  const upstream = new PassThrough();
  const f = await fixture(t, { request: async () => { upstream.write('data: {"choices":[{"delta":{"content":"start"}}]}\n\n'); return { status: 200, data: upstream }; } });
  const cancel = new AbortController(), response = await f.call('/v1/chat/completions', { model: 'hy4', messages: [], stream: true }, { signal: cancel.signal });
  await response.body.getReader().read(); cancel.abort();
  await until(() => f.calls[0].signal.aborted && upstream.destroyed);
  await until(async () => { const s = await (await f.call('/v1/status')).json(); return s.activeRequests === 0 && s.cancelled === 1 && s.upstreamAborted === 1; });
});

test('logout/account change revokes tickets and cancels upstream without publishing identity', async t => {
  const upstream = new PassThrough(), f = await fixture(t, { request: async () => { upstream.write('data: {"choices":[]}\n\n'); return { status: 200, data: upstream }; } });
  const old = f.locator(), response = await f.call('/v1/chat/completions', { model: 'hy4', messages: [], stream: true }); await response.body.getReader().read();
  f.current.next(undefined);
  await until(() => upstream.destroyed && f.calls[0].signal.aborted);
  assert.equal((await fetch(`http://127.0.0.1:${old.port}/v1/models`, { headers: { Authorization: 'Bearer ' + old.ticket } })).status, 401);
  assert.equal((await f.call('/v1/models')).status, 401);
  assert.equal((await (await f.call('/v1/status')).json()).authenticated, false);
  f.current.next(session('second-fixture-user'));
  assert.equal((await f.call('/v1/models')).status, 200);
});

test('ticket expiry rotates the locator; closing removes only this instance locator', async t => {
  let clock = 10000;
  const f = await fixture(t, { now: () => clock, ticketLifetimeMs: 1000 }), old = f.locator(); clock += 1001;
  assert.equal((await fetch(`http://127.0.0.1:${old.port}/v1/models`, { headers: { Authorization: 'Bearer ' + old.ticket } })).status, 401);
  assert.notEqual(f.locator().ticket, old.ticket); assert.equal((await f.call('/v1/models')).status, 200);
  await f.bridge.close(); assert.equal(fs.existsSync(f.bridge.locatorPath), false);
});

test('official 401 refresh retries once before any output, while permission errors do not leak upstream bodies', async t => {
  let count = 0;
  const f = await fixture(t, { request: async () => ++count === 1 ? { status: 401, data: { code: 401 } } : { status: 200, data: { choices: [] } } });
  const response = await f.call('/v1/chat/completions', { model: 'hy4', messages: [] }); assert.equal(response.status, 200); await response.json(); assert.equal(count, 2);
  f.configuration.models[0].id = 'rejected';
  f.auth.refreshSessionForAuthenticationFailure = async () => { throw Error('fixture refresh fail'); };
  assert.equal((await f.call('/v1/chat/completions', { model: 'disabled', messages: [] })).status, 403);
  const other = await fixture(t, { request: async () => ({ status: 403, data: { code: 1007, message: 'fixture-sensitive-prompt' } }) });
  const denied = await other.call('/v1/chat/completions', { model: 'hy4', messages: [] }), text = await denied.text();
  assert.equal(denied.status, 403); assert.equal(text.includes('fixture-sensitive-prompt'), false); assert.equal(JSON.parse(text).error.upstreamCode, '1007');
  const expired = await fixture(t, { request: async () => ({ status: 401, data: {} }) });
  expired.auth.refreshSessionForAuthenticationFailure = async () => { throw Error('fixture refresh rejected'); };
  const login = await expired.call('/v1/chat/completions', { model: 'hy4', messages: [] });
  assert.equal(login.status, 401); assert.equal((await login.json()).error.code, 'WORKBUDDY_LOGIN_REQUIRED'); assert.equal(expired.calls.length, 1);
});

test('actual standalone AICC SDK is loadable and authenticated encryption rejects tampering', { skip: !hasLocalSdk }, async () => {
  const sdk = await loadSdk(); assert.equal(sdk.VERSION, '1.4.0'); assert.equal(sdk.isAiccDebug(), false); assert.equal(sdk.isAiccVerify(), false);
  const key = Buffer.alloc(32, 7), plain = Buffer.from('AICC fixture data'), sealed = sdk.seal(key, plain);
  assert.equal(sealed.includes(plain), false); assert.deepEqual(sdk.open(key, sealed), plain);
  sealed[sealed.length - 1] ^= 1; assert.throws(() => sdk.open(key, sealed));
});

test('AICC stream decryptor strips cipher data and refuses plaintext protected fields/truncated strict stream', async () => {
  const request = { mode: 1, newStreamDecryptor: () => ({ finished: true, decryptEvent(data) { return [Buffer.from(data.toString().replace('encrypted-content', '明文')), true]; } }) };
  const stream = Readable.from([Buffer.from('data: {"choices":[{"delta":{"content":"encrypted-content"}}]}\n\ndata: [DONE]\n\n')]).pipe(new AiccSseTransform(request, { streamPaths: ['choices.delta.content'] }));
  let result = ''; for await (const chunk of stream) result += chunk.toString(); assert.equal(result.includes('encrypted-content'), false); assert.equal(result.includes('明文'), true);
  assert.throws(() => checkProtected({ choices: [{ delta: { content: 'plain' } }] }, { choices: [{ delta: { content: 'plain' } }] }, ['choices.delta.content']), /AICC_RESPONSE_PLAINTEXT/);
  const strict = new AiccSseTransform({ mode: 1, newStreamDecryptor: () => ({ finished: false }) }, { streamPaths: [] }); strict.protectedLeaves = 1;
  assert.throws(() => strict.assertFinished(), /AICC_STREAM_TRUNCATED/); strict.destroy();
});

test('AICC permission gate never silently downgrades confidential models to plaintext inference', () => {
  const p = product(); p.productFeatures.AiccConfidentialModel = false;
  const aicc = catalog(p, session()).find(entry => entry.model.id === 'glm-5.2-aicc');
  assert.equal(aicc.public.transport, 'aicc'); assert.equal(aicc.public.disabled, true); assert.equal(aicc.public.disabledReason, 'AICC_PERMISSION_REQUIRED');
});

test('AICC IOA authorization uses the injected ProductEnvService, not only product fields', async t => {
  const f = await fixture(t); f.current.next({ ...session(), account: { uid: 'fixture-user', type: 'personal' } });
  f.auth.productEnvService.getCurrent = async () => 'iOA';
  const result = await (await f.call('/v1/models')).json();
  assert.equal(result.data.find(model => model.id === 'glm-5.2-aicc').disabled, false);
  assert.equal((await (await f.call('/v1/status')).json()).catalogMetadata.enabledModelCount, result.metadata.enabledModelCount);
  f.auth.productEnvService.getCurrent = async () => 'internal';
  const internal = await (await f.call('/v1/models')).json();
  assert.equal(internal.data.find(model => model.id === 'glm-5.2-aicc').disabled, true);
  assert.equal((await (await f.call('/v1/status')).json()).catalogMetadata.enabledModelCount, internal.metadata.enabledModelCount);
});

test('AICC control plane uses existing RestOperations and actual encrypted SSE never leaks ciphertext to Pi', { skip: !hasLocalSdk }, async t => {
  const sdk = await loadSdk(), key = Buffer.alloc(32, 9), policy = sdk.defaultPolicy(sdk.Protocol.OPENAI);
  const encrypt = text => 'fixture-cipher:' + sdk.seal(key, Buffer.from(text)).toString('base64');
  const decrypt = text => sdk.open(key, Buffer.from(text.slice('fixture-cipher:'.length), 'base64')).toString();
  let controlTarget, flags, controlCalls = 0;
  class SessionFactory { setTransport() { return this; } setProtocol(value) { flags = { ...flags, protocol: value }; return this; } setMode(value) { flags = { ...flags, mode: value }; return this; } }
  class SessionPool { constructor(factory) { this.factory = factory; } }
  class ModelPool {
    constructor(endpoint, empty, timeout, factory) { factory(); }
    setTransport(transport) { this.transport = transport; return this; }
    async newRequest() {
      await this.transport({ header: { Authorization: 'must-be-stripped', 'X-Request-Id': 'fixture-control' }, body: Buffer.from('{}') });
      return { mode: 2, endpoint: () => 'fixture-tee-endpoint', close() {},
        encryptRequest(buffer) { const body = JSON.parse(buffer); for (const message of body.messages) if (typeof message.content === 'string') message.content = encrypt(message.content); return Buffer.from(JSON.stringify(body)); },
        newStreamDecryptor() { return { finished: true, decryptEvent(buffer) { const body = JSON.parse(buffer); for (const choice of body.choices || []) if (choice.delta?.content) choice.delta.content = decrypt(choice.delta.content); return [Buffer.from(JSON.stringify(body)), true]; } }; },
      };
    }
    close() {}
  }
  const fakeSdk = { ModelPool, SessionPool, SessionFactory, WireProtocol: sdk.WireProtocol, Mode: sdk.Mode, Protocol: sdk.Protocol, defaultPolicy: () => policy };
  const f = await fixture(t, { createAiccTransport: options => createAiccTransport({ ...options, loadSdkImpl: async () => fakeSdk }),
    request: async request => {
      if (request.url.endsWith('/v1/aicc')) { controlTarget = request; return { status: ++controlCalls === 1 ? 401 : 200, data: Buffer.from('{}') }; }
      assert.equal(request.headers['X-AICC-Mode'], '1'); assert.equal(request.headers['X-AICC-Endpoint'], 'fixture-tee-endpoint');
      assert.equal(JSON.stringify(request.data).includes('fixture plaintext input'), false);
      return { status: 200, data: Readable.from(['data: ' + JSON.stringify({ choices: [{ delta: { content: encrypt('加密后的真实测试') } }] }) + '\n\ndata: [DONE]\n\n']) };
    } });
  const response = await f.call('/v1/chat/completions', { model: 'glm-5.2-aicc', messages: [{ role: 'user', content: 'fixture plaintext input' }], stream: true });
  const result = await response.text(); assert.equal(response.status, 200); assert.equal(result.includes('加密后的真实测试'), true); assert.equal(result.includes('fixture-cipher'), false);
  assert.equal(controlTarget.url, 'https://www.workbuddy.cn/v1/aicc'); assert.equal(controlTarget.headers.Authorization, undefined);
  assert.equal(controlCalls, 2); assert.equal(controlTarget.signal, f.calls[2].signal); assert.deepEqual(flags, { protocol: 1, mode: 2 });
});

test('install refuses an ordinary app context and directory symlinks', async t => {
  const previous = process.env.WORKBUDDY_PI_OFFICIAL_BUILD; delete process.env.WORKBUDDY_PI_OFFICIAL_BUILD;
  await assert.rejects(installOfficialModelBridge({}), /official build/); if (previous !== undefined) process.env.WORKBUDDY_PI_OFFICIAL_BUILD = previous;
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wb-bridge-symlink-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'real')); fs.symlinkSync(path.join(directory, 'real'), path.join(directory, 'link'));
  await assert.rejects(startOfficialModelBridge({ bridgeDir: path.join(directory, 'link'), authenticationManager: {
    currentSessionSubject: subject(session()), waitForSessionRefresh() {}, refreshSessionForAuthenticationFailure() {}, productEnvService: { getCurrent() {} },
  }, productManager: { waitConfiguration() {} }, restOperations: { request() {} } }), /symlink/);
});

test('5.9.1 captured safe directory selects exactly the original 32 conversation IDs, not all 100 product rows', async t => {
  const config = { ...productionSelectionMetadata, endpoint: 'https://www.workbuddy.cn', productFeatures: { AiccConfidentialModel: true } };
  const details = catalogDetails(config, session());
  assert.equal(details.metadata.productModelCount, 100); assert.equal(details.metadata.conversationModelCount, 32);
  assert.equal(details.metadata.exposedModelCount, 32); assert.equal(details.metadata.excludedModelCount, 68);
  assert.deepEqual(details.entries.map(entry => entry.model.id), productionSelectionMetadata.agents[0].models);
  assert.equal(details.entries.some(entry => entry.model.id === 'hy4-preview-ioa'), true);
  assert.equal(details.entries.some(entry => entry.model.id === 'hy4-preview-dev'), false);
  const reasons = Object.fromEntries(details.metadata.excluded.map(entry => [entry.id, entry.reason]));
  assert.equal(reasons['default-image-generation'], 'AUXILIARY_MODALITY');
  assert.equal(reasons['kling-video-v3'], 'AUXILIARY_MODALITY'); assert.equal(reasons['completion-gf'], 'AUXILIARY_COMPLETION');
  assert.equal(reasons['hy4-preview-dev'], 'NOT_CLI_CONVERSATION_MODEL');
  const f = await fixture(t); f.configuration.models = config.models; f.configuration.agents = config.agents;
  const response = await (await f.call('/v1/models')).json();
  assert.equal(response.data.length, 32); assert.equal(response.metadata.exposedIds.length, 32);
  const status = await (await f.call('/v1/status')).json(); assert.equal(status.catalogMetadata.productModelCount, 100); assert.equal(status.modelCount, 32);
});

test('distinct selectable variant IDs with the same display name remain independently selectable', () => {
  const config = { endpoint: 'https://www.workbuddy.cn', agents: [{ name: 'cli', tags: ['default'], models: ['variant-a', 'variant-b'] }],
    models: [{ id: 'variant-a', name: 'Hy4' }, { id: 'variant-b', name: 'Hy4' }, { id: 'not-selected', name: 'Hy4' }] };
  assert.deepEqual(catalog(config, session()).map(entry => entry.model.id), ['variant-a', 'variant-b']);
});

test('normal cross-chunk DONE followed by Pi-style early body cancellation is completed and promptly releases upstream', async t => {
  const upstream = new PassThrough();
  const f = await fixture(t, { request: async () => {
    upstream.write('data: {"choices":[{"delta":{"content":"正常回复"},"finish_reason":"stop"}]}\r\n\r\n');
    setImmediate(() => { upstream.write('data: [DO'); setImmediate(() => upstream.write('NE]\r\n\r\n')); });
    return { status: 200, data: upstream };
  } });
  const response = await f.call('/v1/chat/completions', { model: 'hy4', messages: [], stream: true }), reader = response.body.getReader();
  let text = ''; while (!text.includes('[DONE]')) { const next = await reader.read(); assert.equal(next.done, false); text += Buffer.from(next.value).toString(); }
  await reader.cancel();
  await until(() => upstream.destroyed && f.calls[0].signal.aborted);
  await until(async () => { const status = await (await f.call('/v1/status')).json(); return status.completed === 1 && status.activeRequests === 0; });
  const status = await (await f.call('/v1/status')).json(); assert.equal(status.cancelled, 0); assert.equal(status.errors, 0); assert.equal(status.upstreamAborted, 0); assert.equal(status.upstreamClosedAfterTerminal, 1);
});

test('Responses completed event is terminal even when the consumer closes before DONE', async t => {
  const upstream = new PassThrough(), f = await fixture(t, { request: async () => {
    upstream.write('event: response.completed\ndata: {"type":"response.com');
    setImmediate(() => upstream.write('pleted","response":{"status":"completed"}}\n\n')); return { status: 200, data: upstream };
  } });
  const response = await f.call('/v1/responses', { model: 'responses-model', input: 'fixture', stream: true }), reader = response.body.getReader();
  let text = ''; while (!text.includes('"status":"completed"')) { const next = await reader.read(); text += Buffer.from(next.value).toString(); }
  await reader.cancel(); await until(() => upstream.destroyed);
  await until(async () => (await (await f.call('/v1/status')).json()).completed === 1);
  const status = await (await f.call('/v1/status')).json(); assert.equal(status.cancelled, 0); assert.equal(status.activeRequests, 0);
});

test('source EOF without protocol terminal is a truncated stream error, not normal completion or user stop', async t => {
  const f = await fixture(t, { request: async () => ({ status: 200, data: Readable.from(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']) }) });
  await assert.rejects(async () => { const response = await f.call('/v1/chat/completions', { model: 'hy4', messages: [], stream: true }); await response.text(); });
  await until(async () => (await (await f.call('/v1/status')).json()).activeRequests === 0);
  const status = await (await f.call('/v1/status')).json(); assert.equal(status.completed, 0); assert.equal(status.cancelled, 0); assert.equal(status.errors, 1);
});

test('terminal monitor detects Responses errors and exact UTF-8/event splits without rewriting wire bytes', async () => {
  let terminal; const monitor = new TerminalSseMonitor(value => { terminal = value; });
  const text = 'event: response.failed\r\ndata: {"type":"response.failed","message":"失败"}\r\n\r\n';
  const buffer = Buffer.from(text), stream = Readable.from([...buffer].map(byte => Buffer.from([byte]))).pipe(monitor);
  const seen = []; for await (const data of stream) seen.push(data);
  // A downstream streaming decoder receives the exact original bytes.
  assert.equal(terminal, 'error'); assert.deepEqual(Buffer.concat(seen), buffer);
  assert.equal(monitor.terminal, 'error');
});

// Safe 5.9.1 directory projection: model/agent metadata only, no URLs or credentials.
const productionSelectionMetadata = {"agents":[{"name":"cli","tags":["cli","default","model:craft"],"models":["auto","hy4-preview-ioa","hy3-ioa","echo","glm-5.3-ioa","glm-5.3-flash-ioa","glm-5.3-flashx","glm-5.2-ioa","glm-5.2-aicc","kimi-k3-ioa","kimi-k2.8-preview","minimax-m3.1-flash","minimax-m3-ioa","claude-opus-5.5","claude-sonnet-5.5","claude-opus-5","claude-opus-4.8-1m","claude-opus-4.7-1m","claude-opus-4.6-1m","claude-sonnet-5-1m","claude-sonnet-5","gpt-6-astra","gpt-6.1-sol","gpt-6-sol","gpt-6-luna","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gemini-3.5-flash","deepseek-v4.1-flash","deepseek-v4-pro-ioa","mimo-v2.6-pro"]}],"models":[{"id":"auto","name":"Auto","tags":["craft"]},{"id":"hy3-ioa","name":"Hy3","tags":["craft","badge:内部模型:#3B82F6"]},{"id":"hy4-preview-ioa","name":"Hy4 preview"},{"id":"hy4-preview-dev","name":"Hy4 preview"},{"id":"echo","name":"Echo","tags":["badge:free:#22C55E","badge:内部模型:#3B82F6"]},{"id":"hy3-dev-0402","name":"HY3-dev0402"},{"id":"codewise-default-model-v2","name":"Default"},{"id":"glm-5v-turbo-ioa","name":"GLM-5v-Turbo","tags":["craft"]},{"id":"glm-5.3-ioa","name":"GLM-5.3","tags":["craft"]},{"id":"glm-5.3-flash-ioa","name":"GLM-5.3-Flash"},{"id":"glm-5.3-flashx","name":"GLM-5.3-FlashX"},{"id":"glm-5.2-ioa","name":"GLM-5.2","tags":["craft"]},{"id":"glm-5.2-aicc","name":"GLM-5.2 AICC","labels":["enterprise:aicc","enterprise:selfhost"]},{"id":"glm-5.1-ioa","name":"GLM-5.1","tags":["craft"]},{"id":"glm-5.0-turbo-ioa","name":"GLM-5.0-Turbo","tags":["craft"]},{"id":"glm-4.6v-ioa","name":"GLM-4.6V"},{"id":"kimi-k3-ioa","name":"Kimi-K3"},{"id":"kimi-k2.8-preview","name":"Kimi-K2.8-Preview"},{"id":"kimi-k2.5-ioa","name":"Kimi-K2.5","tags":["craft"]},{"id":"minimax-m2.7-ioa","name":"MiniMax-M2.7","tags":["craft"]},{"id":"minimax-m3-ioa","name":"MiniMax-M3"},{"id":"minimax-m2.5-ioa","name":"MiniMax-M2.5","tags":["craft"]},{"id":"kimi-k2-thinking","name":"Kimi-K2-Thinking"},{"id":"glm-4.6-ioa","name":"GLM-4.6"},{"id":"deepseek-v4-flash-ioa","name":"Deepseek-V4-Flash"},{"id":"deepseek-v4.1-flash","name":"Deepseek-V4.1-Flash"},{"id":"deepseek-v4-pro-ioa","name":"Deepseek-V4-Pro"},{"id":"deepseek-v3-1-gf","name":"DeepSeek-V3-1"},{"id":"deepseek-v3-1-lkeap","name":"DeepSeek-V3-1"},{"id":"deepseek-v3-1","name":"DeepSeek-V3.1"},{"id":"claude-3.7","name":"Claude-3.7-Sonnet","tags":["badge:企业版:#3B82F6"]},{"id":"claude-opus-5.5","name":"Claude-Opus-5.5","tags":["badge:企业版:#3B82F6"]},{"id":"claude-opus-5","name":"Claude-Opus-5","tags":["badge:企业版:#3B82F6"]},{"id":"claude-opus-4.8","name":"Claude-Opus-4.8","tags":["badge:企业版:#3B82F6"]},{"id":"claude-opus-4.8-1m","name":"Claude-Opus-4.8  (1M context)","tags":["badge:企业版:#3B82F6"]},{"id":"claude-opus-4.7-1m","name":"Claude-Opus-4.7 (1M context)","tags":["craft","badge:企业版:#3B82F6"]},{"id":"claude-opus-4.7","name":"Claude-Opus-4.7","tags":["craft","badge:企业版:#3B82F6"]},{"id":"claude-opus-4.6-1m","name":"Claude-Opus-4.6 (1M context)","tags":["craft","badge:企业版:#3B82F6"]},{"id":"claude-sonnet-5-1m","name":"Claude-Sonnet-5-1M","tags":["craft","badge:企业版:#3B82F6"]},{"id":"claude-sonnet-5","name":"Claude-Sonnet-5","tags":["craft","badge:企业版:#3B82F6"]},{"id":"claude-sonnet-4.6-1m","name":"Claude-Sonnet-4.6 (1M context)","tags":["craft","badge:企业版:#3B82F6"]},{"id":"claude-opus-4.6","name":"Claude-Opus-4.6","tags":["craft","badge:企业版:#3B82F6"]},{"id":"claude-opus-4.5","name":"Claude-Opus-4.5","tags":["craft","badge:企业版:#3B82F6"]},{"id":"claude-haiku-4.5","name":"Claude-Haiku-4.5","tags":["craft","badge:企业版:#3B82F6"]},{"id":"claude-4.5","name":"Claude-Sonnet-4.5","tags":["craft","badge:企业版:#3B82F6"]},{"id":"claude-4.0","name":"Claude-Sonnet-4.0","tags":["badge:企业版:#3B82F6"]},{"id":"gpt-6-astra","name":"GPT-6-Astra","tags":["badge:企业版:#3B82F6"]},{"id":"gpt-6-sol","name":"GPT-6-Sol","tags":["badge:企业版:#3B82F6"]},{"id":"gpt-6-luna","name":"GPT-6-Luna","tags":["badge:企业版:#3B82F6"]},{"id":"gpt-5.6-sol","name":"GPT-5.6-Sol","tags":["badge:企业版:#3B82F6"]},{"id":"gpt-5.6-terra","name":"GPT-5.6-Terra","tags":["badge:企业版:#3B82F6"]},{"id":"gpt-5.6-luna","name":"GPT-5.6-Luna","tags":["badge:企业版:#3B82F6"]},{"id":"gpt-5.5","name":"GPT-5.5","tags":["badge:企业版:#3B82F6"]},{"id":"gpt-5.4","name":"GPT-5.4","tags":["craft","badge:企业版:#3B82F6"]},{"id":"gpt-5.3-codex","name":"GPT-5.3-Codex","tags":["craft","badge:企业版:#3B82F6"]},{"id":"gpt-5.2-codex","name":"GPT-5.2-Codex","tags":["craft","badge:企业版:#3B82F6"]},{"id":"gpt-5.2","name":"GPT-5.2","tags":["craft","badge:企业版:#3B82F6"]},{"id":"gpt-5.1","name":"GPT-5.1","tags":["craft","badge:企业版:#3B82F6"]},{"id":"gpt-5.1-codex","name":"GPT-5.1-Codex","tags":["badge:企业版:#3B82F6"]},{"id":"gpt-5.1-codex-max","name":"GPT-5.1-Codex-Max","tags":["craft","badge:企业版:#3B82F6"]},{"id":"gpt-5.1-codex-mini","name":"GPT-5.1-Codex-Mini","tags":["badge:企业版:#3B82F6"]},{"id":"gpt-5","name":"GPT-5","tags":["badge:企业版:#3B82F6"]},{"id":"gpt-5-codex","name":"GPT-5-Codex","tags":["badge:企业版:#3B82F6"]},{"id":"gpt-5-mini","name":"GPT-5-Mini","tags":["badge:企业版:#3B82F6"]},{"id":"gpt-5-nano","name":"GPT-5-nano","tags":["badge:企业版:#3B82F6"]},{"id":"o4-mini","name":"GPT-4o-Mini","tags":["badge:企业版:#3B82F6"]},{"id":"deepseek-v3-1-volc","name":"DeepSeek-V3-1-Terminus"},{"id":"deepseek-v3-0324-lkeap","name":"DeepSeek-V3-0324"},{"id":"deepseek-r1-0528-lkeap","name":"DeepSeek-R1-0528"},{"id":"deepseek-v3-0324-gf","name":"DeepSeek-V3-0324"},{"id":"deepseek-r1-0528-gf","name":"DeepSeek-R1-0528"},{"id":"completion-gf","name":"completion-gf"},{"id":"nes-gf","name":"nes-gf"},{"id":"hunyuan-3b","name":"hunyuan-3b"},{"id":"hunyuan-7b-dense","name":"hunyuan-7b"},{"id":"deepseek-r1-0528","name":"deepseek-r1"},{"id":"deepseek-v3-0324-taco-completion","name":"deepseek-v3-0324"},{"id":"deepseek-v3-0324-taco","name":"deepseek-v3-taco"},{"id":"deepseek-v3-0324","name":"deepseek-v3"},{"id":"default-1.2","name":"Claude-4.0-Sonnet"},{"id":"gemini-3.5-flash","name":"Gemini-3.5-Flash","tags":["badge:企业版:#3B82F6"]},{"id":"gemini-3.1-flash-lite","name":"Gemini-3.1-flash-lite","tags":["craft","badge:企业版:#3B82F6"]},{"id":"gemini-3.0-pro","name":"Gemini-3.0-Pro","tags":["craft","badge:企业版:#3B82F6"]},{"id":"gemini-3.0-flash","name":"Gemini-3.0-Flash","tags":["craft","badge:企业版:#3B82F6"]},{"id":"gemini-2.5-flash","name":"Gemini-2.5-Flash","tags":["badge:企业版:#3B82F6"]},{"id":"gemini-2.5-pro","name":"Gemini-2.5-Pro","tags":["badge:企业版:#3B82F6"]},{"id":"deepseek-v3-2-volc-ioa","name":"DeepSeek-V3.2","tags":["craft"]},{"id":"hunyuan-2.0-thinking-ioa","name":"Hunyuan-2.0-Thinking","tags":["craft"]},{"id":"hunyuan-2.0-instruct-ioa","name":"Hunyuan-2.0-Instruct","tags":["craft"]},{"id":"hunyuan-chat","name":"Hunyuan-Turbos"},{"id":"default-image-generation","name":"default-image","tags":["text-to-image"]},{"id":"wb-lite","name":"wb-lite","disabled":true},{"id":"kling-video-v3","name":"Kling-Video-V3","tags":["text-to-video","image-to-video"]},{"id":"hunyuan-image-alpha","name":"Hunyuan Image Alpha","tags":["text-to-image"]},{"id":"hunyuan-image-alpha-edit","name":"Hunyuan Image Alpha Edit","tags":["image-to-image"]},{"id":"claude-sonnet-5.5","name":"Claude-Sonnet-5.5","tags":["badge:企业版:#3B82F6"]},{"id":"gpt-6.1-sol","name":"GPT-6.1-Sol","tags":["badge:企业版:#3B82F6"]},{"id":"minimax-video-h3","name":"MiniMax-H3","tags":["text-to-video","image-to-video"]},{"id":"minimax-m3.1-flash","name":"MiniMax-M3.1-Flash"},{"id":"mimo-v2.6-pro","name":"Xiaomi MiMo-V2.6-Pro"}]};
