import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createNativeMcpService } = require('../src/native-mcp-service.cjs');
const contract = JSON.parse(fs.readFileSync(new URL('./fixtures/native-mcp-591-contract.json', import.meta.url)));
const stdioContract = JSON.parse(fs.readFileSync(new URL('./fixtures/native-mcp-stdio-591.source.json', import.meta.url)));
function consumers() {
  const context = vm.createContext({ at: crypto, vd: new Set(), z: { yt: id => id.replace(/^(?:connector|custom-mcp):/, '') }, serverNameOf: item => item.id.replace(/^(?:connector|custom-mcp):/, '') });
  for (const name of ['isBlocked', 'isConnectorEnabledForContext', 'isFirstPartyEnabledForContext', 'isMcpItemVisibleInSession']) {
    const slice = contract.slices[name]; assert.equal(crypto.createHash('sha256').update(slice.code).digest('hex'), slice.sha256); vm.runInContext(slice.code, context);
  }
  const methods = {};
  const fingerprint = stdioContract.slices.find(slice => slice.name === 'connectionFingerprint');
  assert.equal(crypto.createHash('sha256').update(fingerprint.source).digest('hex'), fingerprint.sha256);
  vm.runInContext(fingerprint.source, context); methods.fingerprint = vm.runInContext('computeConnectionFingerprint', context);
  for (const name of ['computeContext', 'toRowTools']) {
    const slice = contract.slices[name]; assert.equal(crypto.createHash('sha256').update(slice.code).digest('hex'), slice.sha256);
    methods[name] = vm.runInContext('({' + slice.code + '})', context)[name];
  }
  return methods;
}
const identity = uid => ({ account: { uid, enterpriseId: 'fixture-enterprise', type: 'ultimate' }, auth: { accessToken: 'fixture-token', domain: 'fixture.domain' } });
const schema = () => ({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false });
function setup(options = {}) {
  let session = identity('fixture-user'); const calls = [], contexts = [], disabled = new Map();
  const rows = [{ id: 'connector:finance', origin: { kind: 'connector', connectorId: 'finance' }, enabled: true, trusted: true, transport: { kind: 'http', url: 'https://fixture.invalid/mcp' } }];
  const tools = [{ name: 'lookup', description: 'Fixture finance lookup', inputSchema: schema(), _meta: { token: 'not-exported' } }];
  const controller = { state: 'ready', pendingOperations: 0, disposed: false, identityKey: 'fixture-user', transport: rows[0].transport,
    ownsIdentity(key) { return this.identityKey === key; }, listTools: () => tools,
    requestContext: { run(context, callback) { contexts.push(context); return callback(); } },
    session: { async callTool(name, args) { calls.push({ name, args }); return options.execute ? options.execute(name, args) : { content: [{ type: 'text', text: 'fixture result' }], isError: false }; } },
    callTool() { throw Error('Must not use controller auth retry'); },
  };
  Object.defineProperty(controller.transport, 'headers', { get() { throw Error('Do not read remote headers'); } });
  Object.defineProperty(controller, 'configuration', { get() { throw Error('Do not read credentials/config'); } });
  const native = consumers();
  Object.defineProperty(controller, 'connectionFingerprint', { configurable: true, get: () => native.fingerprint({ ...rows[0], transport: controller.transport }) });
  const manager = { identityKey: 'fixture-user', controllers: new Map([['connector:finance', controller]]),
    toolPolicy: { async load() {}, getDisabledTools(name) { return disabled.get(name) || []; } },
    resolveProviders() { return new Map(rows.map(row => [row.id, row])); }, isProbedUnauthorized() { return false; },
    computeContext: native.computeContext, toRowTools: native.toRowTools, async whenSettled() {},
    resolveStdioRuntimeCommand: command => command, resolveStdioRuntimePathEnv: () => ({ PATH: '/fixture/native/bin' }),
    activate() { throw Error('Must not auto-activate'); }, ensureStarted() { throw Error('Must not auto-start'); },
  };
  const states = { finance: { configId: 'finance', bound: true, enabled: true, connected: true } };
  const auth = { currentSessionSubject: { getValue: () => session }, async waitForSessionRefresh() {} };
  const connectorService = { async getStates(params) { assert.deepEqual(params, { buddyAppScope: 'ignore' }); return states; } };
  const service = createNativeMcpService({ mcpManager: manager, connectorService, authenticationManager: auth, ...options.serviceOptions });
  const params = { threadId: 'fixture-thread', cwd: '/fixture/workspace', connectors: [{ name: 'finance', displayName: 'Finance UI name' }] };
  const call = extra => service.call({ ...params, serverId: 'connector:finance', rawName: 'lookup', arguments: { query: 'fixture' }, ...extra });
  return { service, params, call, calls, contexts, manager, states, auth, connectorService, controller, rows, tools, disabled, native, setSession: next => { session = next; } };
}
const codeIs = code => error => error.code === code;

test('service creation is lazy and unavailable services do not break official bridge installation', async () => {
  const service = createNativeMcpService({}); assert.equal(typeof service.list, 'function');
  await assert.rejects(service.list({}), codeIs('NATIVE_MCP_UNAVAILABLE'));
});

test('raw 5.9.1 consumer filters selected connectors and row projection lacks the schema needed by Pi', async () => {
  const f = setup(), result = await f.service.list(f.params);
  assert.deepEqual(result, [{ serverId: 'connector:finance', connectorId: 'finance', sourceType: 'connector', rawName: 'lookup', description: 'Fixture finance lookup', inputSchema: schema() }]);
  const rows = f.manager.toRowTools(f.rows[0], f.controller);
  assert.equal(rows[0].inputSchema, undefined); assert.equal(result[0].inputSchema.type, 'object');
  assert.equal(JSON.stringify(result).includes('not-exported'), false); assert.equal(JSON.stringify(result).includes('fixture-token'), false);
  assert.deepEqual(await f.service.list({ ...f.params, connectors: [] }), []);
});

test('cancel while waiting for the native lifecycle fence returns immediately without invoking a tool', async () => {
  const f = setup(), abort = new AbortController(); let release;
  f.manager.whenSettled = () => new Promise(resolve => { release = resolve; });
  const pending = f.service.list({ ...f.params, signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve)); abort.abort();
  await assert.rejects(pending, codeIs('NATIVE_MCP_CANCELLED'));
  release(); assert.equal(f.calls.length, 0);
});

test('selected facade name is config ID and is normalized separately from MCP server ID', async () => {
  const f = setup();
  assert.equal((await f.service.list({ ...f.params, connectors: ['finance'] })).length, 1);
  assert.equal((await f.service.list({ ...f.params, connectors: ['connector:finance'] })).length, 1);
  assert.deepEqual(await f.service.list({ ...f.params, connectors: ['Finance UI name'] }), []);
});

test('remote invocation uses exact server/raw tool and one existing session call without auth retry', async () => {
  const f = setup(), result = await f.call();
  assert.equal(result.content[0].text, 'fixture result'); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.contexts, [{ sessionId: 'fixture-thread' }]);
  await assert.rejects(f.call({ serverId: 'connector:other' }), codeIs('NATIVE_MCP_TOOL_NOT_ALLOWED'));
  await assert.rejects(f.call({ rawName: 'unlisted' }), codeIs('NATIVE_MCP_TOOL_NOT_ALLOWED'));
  assert.equal(f.calls.length, 1);
});

test('trust, enabled, native tool policy, binding and connection are rechecked at each call', async () => {
  const f = setup(); assert.equal((await f.service.list(f.params)).length, 1);
  f.disabled.set('finance', ['lookup']); await assert.rejects(f.call(), codeIs('NATIVE_MCP_TOOL_NOT_ALLOWED'));
  f.disabled.clear(); f.rows[0].trusted = false; assert.deepEqual(await f.service.list(f.params), []);
  f.rows[0].trusted = true; f.rows[0].enabled = false; assert.deepEqual(await f.service.list(f.params), []);
  f.rows[0].enabled = true;
  for (const change of [{ bound: false }, { enabled: false }, { connected: false }, { connecting: true }, { reason: { code: 'auth-required' } }]) {
    f.states.finance = { bound: true, enabled: true, connected: true, ...change };
    assert.deepEqual(await f.service.list(f.params), []);
  }
  assert.equal(f.calls.length, 0);
});

test('stdio, idle and foreign owner controllers are never offered or auto-connected', async () => {
  const f = setup();
  for (const change of [{ transport: { kind: 'stdio' } }, { state: 'idle' }, { identityKey: 'old-user' }, { pendingOperations: 1 }, { disposed: true }]) {
    const old = { transport: f.controller.transport, state: f.controller.state, identityKey: f.controller.identityKey, pendingOperations: f.controller.pendingOperations, disposed: f.controller.disposed };
    Object.assign(f.controller, change); assert.deepEqual(await f.service.list(f.params), []); Object.assign(f.controller, old);
  }
});

test('buddy/plugin/user/first-party sources do not become connector privileges', async () => {
  const f = setup();
  for (const origin of [{ kind: 'buddy', applicationId: 'finance-buddy' }, { kind: 'plugin', pluginId: 'finance-plugin' }, { kind: 'user' }, { kind: 'first-party', key: 'finance' }]) {
    f.rows[0].origin = origin; assert.deepEqual(await f.service.list(f.params), []);
  }
});

test('new auth account with old manager owner is rejected even when that mismatched tuple remains stable', async () => {
  const f = setup(); f.setSession(identity('new-user'));
  await assert.rejects(f.service.list(f.params), codeIs('NATIVE_MCP_ACCOUNT_NOT_READY'));
  await assert.rejects(f.call(), codeIs('NATIVE_MCP_ACCOUNT_NOT_READY')); assert.equal(f.calls.length, 0);
  f.manager.identityKey = 'new-user'; assert.deepEqual(await f.service.list(f.params), []);
  f.controller.identityKey = 'new-user'; f.controller.pendingOperations = 1;
  assert.deepEqual(await f.service.list(f.params), []);
  f.controller.pendingOperations = 0; assert.equal((await f.service.list(f.params)).length, 1);
});

test('identity change during native policy/state resolution drops the stale catalog', async () => {
  const f = setup(); f.connectorService.getStates = async () => { f.setSession(identity('new-user')); return f.states; };
  await assert.rejects(f.service.list(f.params), codeIs('NATIVE_MCP_ACCOUNT_CHANGED'));
});

test('already-aborted list or call performs no native dispatch', async () => {
  const f = setup(), abort = new AbortController(); abort.abort();
  await assert.rejects(f.service.list({ ...f.params, signal: abort.signal }), codeIs('NATIVE_MCP_CANCELLED'));
  await assert.rejects(f.call({ signal: abort.signal }), error => error.code === 'NATIVE_MCP_CANCELLED' && error.mayHaveExecuted === false);
  assert.equal(f.calls.length, 0);
});

test('cancel after dispatch discards the result and explicitly admits remote effects may already exist', async () => {
  let complete; const pending = new Promise(resolve => { complete = resolve; });
  const f = setup({ execute: () => pending }), abort = new AbortController(), call = f.call({ signal: abort.signal });
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve)); abort.abort();
  await assert.rejects(call, error => error.code === 'NATIVE_MCP_CANCELLED' && error.mayHaveExecuted === true);
  complete({ content: [{ type: 'text', text: 'late result' }] }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
});

test('account change during one dispatched call suppresses its output without retrying', async () => {
  const f = setup({ execute: async () => { f.setSession(identity('new-user')); return { content: [{ type: 'text', text: 'old account data' }] }; } });
  await assert.rejects(f.call(), error => error.code === 'NATIVE_MCP_ACCOUNT_CHANGED' && error.mayHaveExecuted === true);
  assert.equal(f.calls.length, 1);
});

test('native failures are sanitized and are not automatically retried', async () => {
  const f = setup({ execute: async () => { throw Error('secret header fixture-token'); } });
  await assert.rejects(f.call(), error => error.code === 'NATIVE_MCP_CALL_FAILED' && !error.message.includes('fixture-token'));
  assert.equal(f.calls.length, 1);
});

test('malformed, oversized or missing-schema tools and non-JSON arguments fail closed', async () => {
  const f = setup();
  for (const inputSchema of [undefined, { type: 'array' }, { type: 'object', description: 'x'.repeat(65536) }]) {
    f.tools[0].inputSchema = inputSchema; assert.deepEqual(await f.service.list(f.params), []);
  }
  f.tools[0].inputSchema = schema();
  await assert.rejects(f.call({ arguments: { query: 'x'.repeat(65536) } }), codeIs('NATIVE_MCP_ARGUMENTS_INVALID'));
  await assert.rejects(f.call({ arguments: { query() {} } }), codeIs('NATIVE_MCP_ARGUMENTS_INVALID'));
  assert.equal(f.calls.length, 0);
});

function stdioSetup(extraOptions = {}) {
  const launches = [], f = setup({ serviceOptions: { stdioNodeCommand: process.execPath, stdioCaller: async launch => { launches.push(launch); return { content: [{ type: 'text', text: 'stdio fixture' }] }; }, ...extraOptions } });
  f.rows[0].transport = { kind: 'stdio', command: 'node', args: ['/fixture/mcp.cjs'], env: { MCP_FIXTURE_SECRET: 'fixture-secret-only-for-mcp', PATH: '/fixture/mcp/bin', NODE_OPTIONS: '--bad-option' } };
  f.controller.transport = f.rows[0].transport; delete f.controller.identityKey; f.controller.ownsIdentity = () => true;
  delete f.controller.session; delete f.controller.requestContext;
  return { ...f, launches };
}

test('plain native stdio uses fixed packaged Node and native runtime environment only inside owned launch', async () => {
  const f = stdioSetup(); f.manager.resolveStdioRuntimeCommand = () => '/Applications/WorkBuddy.app/Contents/MacOS/Electron';
  const catalog = await f.service.list(f.params); assert.equal(catalog.length, 1);
  assert.equal(JSON.stringify(catalog).includes('fixture-secret'), false); assert.equal(JSON.stringify(catalog).includes('/fixture/mcp.cjs'), false);
  assert.equal(f.launches.length, 0);
  const result = await f.call(); assert.equal(result.content[0].text, 'stdio fixture'); assert.equal(f.launches.length, 1);
  const launch = f.launches[0]; assert.equal(launch.command, process.execPath); assert.deepEqual(launch.args, ['/fixture/mcp.cjs']);
  assert.equal(launch.cwd, '/fixture/workspace'); assert.equal(launch.env.MCP_FIXTURE_SECRET, 'fixture-secret-only-for-mcp');
  assert.equal(launch.env.NODE_OPTIONS, ''); assert.equal(launch.env.PATH, [process.execPath.slice(0, process.execPath.lastIndexOf('/')), '/fixture/mcp/bin'].join(':'));
  assert.equal(launch.toolName, 'lookup'); assert.deepEqual(launch.arguments, { query: 'fixture' });
});

test('stdio localRoute fails closed instead of minting a probe context for business calls', async () => {
  const f = stdioSetup(); f.rows[0].transport.localRoute = { path: '/fixture/local-mcp', routeKey: 'private-native-route' };
  f.manager.resolveStdioProbeTransport = () => { throw Error('Never use probe grant'); };
  assert.deepEqual(await f.service.list(f.params), []);
  await assert.rejects(f.call(), codeIs('NATIVE_MCP_TOOL_NOT_ALLOWED')); assert.equal(f.launches.length, 0);
});

test('stdio base ownsIdentity true never bypasses account UID/fence or fingerprint checks', async () => {
  const f = stdioSetup(); f.setSession(identity('new-user'));
  await assert.rejects(f.call(), codeIs('NATIVE_MCP_ACCOUNT_NOT_READY')); assert.equal(f.launches.length, 0);
  f.setSession(identity('fixture-user'));
  Object.defineProperty(f.controller, 'connectionFingerprint', { get: () => 'old-config' });
  assert.deepEqual(await f.service.list(f.params), []); assert.equal(f.launches.length, 0);
});

test('stdio configuration mutation between authorization and dispatch is refused', async () => {
  const f = stdioSetup(), original = f.manager.computeContext; let projections = 0;
  f.manager.computeContext = function(context) { const result = original.call(this, context); if (++projections === 2) f.rows[0].transport.args.push('--changed-after-check'); return result; };
  await assert.rejects(f.call(), codeIs('NATIVE_MCP_TOOL_NOT_ALLOWED')); assert.equal(f.launches.length, 0);
});

test('unresolved Node-to-Electron fallback is never spawned as a native stdio call', async () => {
  const f = stdioSetup({ stdioNodeCommand: undefined });
  f.manager.resolveStdioRuntimeCommand = () => '/Applications/WorkBuddy.app/Contents/MacOS/Electron';
  await assert.rejects(f.call(), codeIs('NATIVE_MCP_STDIO_NODE_UNAVAILABLE')); assert.equal(f.launches.length, 0);
});

test('stdio cancel before launch performs no spawn and a dispatched call receives the original signal', async () => {
  const f = stdioSetup(), abort = new AbortController(); abort.abort();
  await assert.rejects(f.call({ signal: abort.signal }), codeIs('NATIVE_MCP_CANCELLED')); assert.equal(f.launches.length, 0);
  const controller = new AbortController(); await f.call({ signal: controller.signal }); assert.equal(f.launches[0].signal, controller.signal);
});

function userSetup(stdio = false) {
  const f = stdio ? stdioSetup() : setup();
  f.manager.controllers.delete('connector:finance'); f.rows[0].id = 'custom-mcp:finance'; f.rows[0].origin = { kind: 'user' }; f.rows[0].configHash = 'fixture-approved-config';
  f.manager.controllers.set('custom-mcp:finance', f.controller); f.params.connectors = [];
  f.connectorService.getStates = async () => { throw Error('User MCP has no managed binding state'); };
  const call = extra => f.service.call({ ...f.params, serverId: 'custom-mcp:finance', rawName: 'lookup', arguments: { query: 'fixture' }, ...extra });
  return { ...f, call };
}

test('native globally enabled/trusted user MCP works with no invented per-thread picker selection', async () => {
  const f = userSetup(), list = await f.service.list(f.params);
  assert.equal(list.length, 1); assert.equal(list[0].sourceType, 'user'); assert.equal(list[0].selectedGlobally, true);
  assert.equal(list[0].serverId, 'custom-mcp:finance'); assert.equal(list[0].connectorId, 'custom-mcp:finance');
  assert.equal((await f.call()).content[0].text, 'fixture result'); assert.equal(f.calls.length, 1);
});

test('user MCP requires actual user origin, canonical ID, native approval and live state', async () => {
  const f = userSetup();
  for (const [key, value] of [['enabled', false], ['trusted', false], ['configHash', undefined], ['id', 'user:finance']]) {
    const previous = f.rows[0][key]; f.rows[0][key] = value;
    assert.deepEqual(await f.service.list(f.params), []); f.rows[0][key] = previous;
  }
  for (const origin of [{ kind: 'plugin' }, { kind: 'first-party', key: 'finance' }, { kind: 'buddy', applicationId: 'finance' }]) {
    f.rows[0].origin = origin; assert.deepEqual(await f.service.list(f.params), []);
  }
  assert.equal(f.calls.length, 0);
});

test('same-name managed and user MCP remain distinct by full origin ID', async () => {
  const f = userSetup(), managedItem = { id: 'connector:finance', origin: { kind: 'connector', connectorId: 'finance' }, enabled: true, trusted: true, transport: { kind: 'http', url: 'https://fixture.invalid/managed' } };
  const managed = { ...f.controller, transport: managedItem.transport, session: { async callTool() { return { content: [{ type: 'text', text: 'managed result' }] }; } } };
  Object.defineProperty(managed, 'connectionFingerprint', { get: () => f.native.fingerprint(managedItem) });
  f.rows.push(managedItem); f.manager.controllers.set(managedItem.id, managed);
  f.connectorService.getStates = async () => f.states;
  assert.deepEqual((await f.service.list(f.params)).map(row => row.serverId), ['custom-mcp:finance']);
  await assert.rejects(f.call({ serverId: 'connector:finance' }), codeIs('NATIVE_MCP_TOOL_NOT_ALLOWED'));
  const both = await f.service.list({ ...f.params, connectors: ['finance'] });
  assert.deepEqual(both.map(row => row.serverId), ['custom-mcp:finance', 'connector:finance']);
  assert.equal((await f.call({ connectors: ['finance'], serverId: 'connector:finance' })).content[0].text, 'managed result');
  assert.equal((await f.call({ connectors: ['finance'], serverId: 'custom-mcp:finance' })).content[0].text, 'fixture result');
});

test('user origin or approval changes after catalog authorization cannot reuse a same-ID controller', async () => {
  for (const change of [row => { row.origin = { kind: 'plugin' }; }, row => { row.configHash = 'changed-approval'; }]) {
    const f = userSetup(), original = f.manager.computeContext; let count = 0;
    f.manager.computeContext = function(context) { const result = original.call(this, context); if (++count === 2) change(f.rows[0]); return result; };
    await assert.rejects(f.call(), codeIs('NATIVE_MCP_TOOL_NOT_ALLOWED')); assert.equal(f.calls.length, 0);
  }
});

test('user stdio inherits native project placeholders without passing launch credentials to Pi', async () => {
  const f = userSetup(true);
  f.rows[0].transport.args = ['${CODEBUDDY_PROJECT_DIR}/mcp.cjs', '--workspace=${CLAUDE_PROJECT_DIR}'];
  f.rows[0].transport.cwd = '${CODEBUDDY_PROJECT_DIR}';
  f.rows[0].transport.env.ROOT = '${CLAUDE_PROJECT_DIR}';
  assert.equal((await f.service.list(f.params)).length, 1);
  await f.call(); assert.equal(f.launches.length, 1);
  const launch = f.launches[0]; assert.deepEqual(launch.args, ['/fixture/workspace/mcp.cjs', '--workspace=/fixture/workspace']);
  assert.equal(launch.cwd, '/fixture/workspace'); assert.equal(launch.env.ROOT, '/fixture/workspace');
  assert.equal(launch.env.CODEBUDDY_PROJECT_DIR, '/fixture/workspace'); assert.equal(launch.env.CLAUDE_PROJECT_DIR, '/fixture/workspace');
});
