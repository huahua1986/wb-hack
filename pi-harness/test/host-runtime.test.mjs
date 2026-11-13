import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PiHostRuntime } from '../src/host-runtime.mjs';
import { ElectronDebuggerClient, createPiElectronHost } from '../src/electron-host.mjs';
import { normalizePiHarness, verifyPiRuntime, piRuntimeScript } from '../../auth-gateway/src/runtime-pi.mjs';
import { readPiConfig } from '../src/config.mjs';
import { WorkBuddyCdpController } from '../src/electron-controller.mjs';

function state(t) { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pi-host-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function adapter() { let listener; return { id: 'pi', subscribe(fn) { listener = fn; return () => { listener = undefined; }; }, emit(e) { listener?.(e); }, describe() { return { id: 'pi' }; }, snapshot() { return { id: 'pi', threads: [] }; }, async createThread(p) { return { id: 'one', ...p }; }, async listThreads() { return []; }, async startTurn(p) { return { id: 'turn', ...p }; }, async close() {} }; }

test('Host expert resolution is available before task creation and cannot choose filesystem roots', async t => {
  const a = adapter(), calls = [];
  a.resolveExpertSelection = async ({ expert }) => { calls.push(expert); return expert.id === 'installed' ? { ...expert, prompt: 'SYNTHETIC_PERSONA' } : null; };
  a.createThread = async () => { throw Error('Resolution must not create tasks'); };
  const runtime = new PiHostRuntime(a, { stateDir: state(t) }); t.after(() => runtime.close());
  const identity = { id: 'installed', source: 'builtin', marketExpertId: 'ex_SYNTHETIC', runtimeIdentity: 'expert-v2:synthetic' };
  assert.deepEqual((await runtime.dispatch('expert.resolve', { expert: identity })).expert, { ...identity, prompt: 'SYNTHETIC_PERSONA' });
  assert.deepEqual(await runtime.dispatch('expert.resolve', { expert: { id: 'missing' } }), { expert: null });
  assert.deepEqual(calls, [identity, { id: 'missing' }]);
  for (const extra of [{ configDir: '/untrusted' }, { threadId: 'existing' }, { filePath: '/untrusted/secret' }]) {
    await assert.rejects(runtime.dispatch('expert.resolve', { expert: identity, ...extra }), /Unknown expert resolution field/);
  }
  assert.equal(calls.length, 2);
});

test('Host persists only valid UI state, restores it and routes bounded Pi operations', async t => {
  const dir = state(t), a = adapter(), runtime = new PiHostRuntime(a, { stateDir: dir });
  assert.equal((await runtime.dispatch('thread.create', { title: 'test' })).thread.title, 'test');
  await runtime.dispatch('ui.update', { active: true, activeThreadId: 'one', selectedHarnessId: 'pi' });
  assert.equal(fs.statSync(path.join(dir, 'ui.json')).mode & 0o777, 0o600);
  for (const params of [{ unknown: true }, { active: 'yes' }, { selectedHarnessId: 'foreign' }, { activeThreadId: [] }]) await assert.rejects(runtime.dispatch('ui.update', params));
  await assert.rejects(runtime.dispatch('turn.start', { threadId: 'one', prompt: 'x'.repeat(60001) }));
  await assert.rejects(runtime.dispatch('shell.execute'));
  let event; runtime.subscribe(e => { event = e; }); a.emit({ type: 'message.delta', harnessId: 'pi', payload: { delta: 'hi' } });
  assert.equal(event.seq, 1); assert.equal(runtime.snapshot().harnesses[0].id, 'pi');
  await runtime.close(); const restored = new PiHostRuntime(adapter(), { stateDir: dir });
  assert.equal((await restored.dispatch('ui.snapshot')).uiState.activeThreadId, 'one'); await restored.close();
});

test('Electron transport uses local WebContents debugger ownership and detaches, without a TCP server', async () => {
  const debuggerApi = new EventEmitter(); debuggerApi.isAttached = () => false; const calls = [];
  debuggerApi.attach = version => calls.push(['attach', version]); debuggerApi.detach = () => debuggerApi.emit('detach');
  debuggerApi.sendCommand = async (method, params) => { calls.push([method, params]); return { ok: true }; };
  const contents = { debugger: debuggerApi, isDestroyed: () => false }, client = new ElectronDebuggerClient(contents);
  let received; client.on('Runtime.bindingCalled', e => { received = e; }); debuggerApi.emit('message', null, 'Runtime.bindingCalled', { name: 'own' });
  assert.equal(received.name, 'own'); assert.equal((await client.request('Page.enable')).ok, true);
  client.close(); assert.equal(client.isClosed, true); assert.equal(debuggerApi.listenerCount('message'), 0);
  await assert.rejects(client.request('Runtime.enable'));
  assert.deepEqual(calls[0], ['attach', '1.3']);
  debuggerApi.isAttached = () => true; assert.throws(() => new ElectronDebuggerClient(contents), /already in use/);
});

test('Electron host attaches to the 5.11.1 main renderer, excluding other apps that share index.html', async t => {
  const dir = state(t), configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ command: process.execPath, cwd: dir, stateDir: 'state', agentDir: 'agent', provider: 'ollama', model: 'qwen' }));
  const appAsarPath = '/original/app.asar', entry = `file://${appAsarPath}/renderer/index.html`;
  const consulted = [], attached = [];
  const windows = [entry + '?windowAppId=settings', entry + '?windowKind=conversation',
    'file://other-host/original/app.asar/renderer/index.html', entry + '?windowAppId=main&windowKind=settings'];
  const contents = windows.map((url, id) => {
    const view = new EventEmitter(), debuggerApi = new EventEmitter();
    Object.assign(debuggerApi, {
      isAttached: () => false, attach: () => attached.push(id), detach: () => debuggerApi.emit('detach'),
      async sendCommand(method, params) {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
        if (method === 'Page.addScriptToEvaluateOnNewDocument') {
          assert.match(params.source, /"supportedAppVersions":\["5\.11\.1"\]/);
          return { identifier: 'main-script' };
        }
        return { result: { value: { status: 'ready' } } };
      },
    });
    return Object.assign(view, {
      id, debugger: debuggerApi, getURL: () => url, isDestroyed: () => false, isLoadingMainFrame: () => false,
      async executeJavaScript(source) { consulted.push(id); assert.match(source, /workbuddyDesktop\?\.appVersion/); return { name: 'workbuddy', desktop: 'true', version: '5.11.1' }; },
    });
  });
  const electron = { app: new EventEmitter(), webContents: { getAllWebContents: () => contents } };
  const host = createPiElectronHost({ electron, appAsarPath, configFile });
  t.after(() => host.close());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(consulted, [3]);
  assert.deepEqual(attached, [3]);
  assert.equal(host.snapshot().attached, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state/bridge-status.json'), 'utf8')).phase, 'ready');
  await host.close();
});

test('Pi startup is opt-in, accepts a regular bounded config and rejects unknown target artifacts', t => {
  const dir = state(t), filename = path.join(dir, 'config.json'); fs.writeFileSync(filename, '{}');
  assert.equal(normalizePiHarness(undefined), undefined); assert.deepEqual(normalizePiHarness({ enabled: false }), { enabled: false });
  const enabled = normalizePiHarness({ enabled: true, configFile: 'config.json' }, dir);
  assert.equal(enabled.configFile, filename); assert.equal(piRuntimeScript('/original/app.asar', undefined), '');
  assert.match(piRuntimeScript('/original/app.asar', enabled), /electron-runtime\.cjs/);
  assert.throws(() => normalizePiHarness({ enabled: true, configFile: filename, command: 'arbitrary' }));
  const link = path.join(dir, 'link'); fs.symlinkSync(filename, link); assert.throws(() => normalizePiHarness({ enabled: true, configFile: link }));
  assert.throws(() => verifyPiRuntime(filename), /verified WorkBuddy/);
  assert.throws(() => verifyPiRuntime(filename, { transport: 'ssh' }), /verified WorkBuddy artifacts \(5\.11\.2, 5\.11\.3\)/);
  assert.throws(() => verifyPiRuntime(filename, { transport: 'http' }), /Unknown Pi Harness transport/);
});

for (const [version, env, sha256] of [
  ['5.11.2', 'WORKBUDDY_TEST_ASAR_5112', '6d6ec0fc44a312249837385014205ecfcacc7ca457dba29ec9afcd7d0e19233d'],
  ['5.11.3', 'WORKBUDDY_TEST_ASAR_5113', '45965c389b9674ef359fb5fc331a40ca0c0777c8380104f2e9ea8950bced614f'],
]) {
  test(`SSH Pi startup pins the exact WorkBuddy ${version} artifact`, { skip: !process.env[env] }, () => {
    const asarPath = process.env[env];
    assert.deepEqual(verifyPiRuntime(asarPath, { transport: 'ssh' }), { version, sha256 });
    assert.throws(() => verifyPiRuntime(asarPath), /verified WorkBuddy artifacts \(5\.9\.1\)/);
  });
}

test('Pi config validates its executable and keeps isolated data outside symlinks', t => {
  const dir = state(t), filename = path.join(dir, 'config.json');
  const config = { command: process.execPath, cwd: dir, stateDir: 'state', agentDir: 'agent', provider: 'ollama', model: 'qwen3.8:27b' };
  fs.writeFileSync(filename, JSON.stringify(config)); const read = readPiConfig(filename);
  assert.equal(read.stateDir, path.join(dir, 'state')); assert.equal(fs.statSync(read.agentDir).mode & 0o777, 0o700);
  fs.writeFileSync(filename, JSON.stringify({ ...config, apiKey: 'not-allowed' })); assert.throws(() => readPiConfig(filename), /Unknown/);
  fs.symlinkSync(read.agentDir, path.join(dir, 'linked')); fs.writeFileSync(filename, JSON.stringify({ ...config, agentDir: 'linked' })); assert.throws(() => readPiConfig(filename), /symlink/);
});

test('bundled Pi accepts explicit Node argv and finite tool selection without shell interpretation', t => {
  const dir = state(t), filename = path.join(dir, 'pi.json');
  const config = { command: process.execPath, args: ['/bundle/pi/cli.js'], cwd: dir, stateDir: 'state', agentDir: 'agent', provider: 'ollama', model: 'qwen', tools: ['read', 'write', 'bash'] };
  fs.writeFileSync(filename, JSON.stringify(config)); const parsed = readPiConfig(filename);
  assert.deepEqual(parsed.args, config.args); assert.deepEqual(parsed.tools, config.tools);
  for (const bad of [{ tools: ['arbitrary'] }, { args: ['bad\narg'] }, { args: Array(9).fill('x') }]) { fs.writeFileSync(filename, JSON.stringify({ ...config, ...bad })); assert.throws(() => readPiConfig(filename)); }
});

test('Pi Host state is single-owner and closing releases its lease without launching a task', async t => {
  const dir = state(t), configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ command: process.execPath, cwd: dir, stateDir: 'state', agentDir: 'agent', provider: 'ollama', model: 'qwen' }));
  const app = new EventEmitter(), electron = { app, webContents: { getAllWebContents: () => [] } };
  const options = { electron, appAsarPath: '/original/app.asar', configFile };
  const host = createPiElectronHost(options);
  assert.equal(host.snapshot().attached, 0);
  assert.throws(() => createPiElectronHost(options), /already in use/);
  await host.close(); assert.equal(fs.existsSync(path.join(dir, 'state/host.lock')), false);
  const next = createPiElectronHost(options); await next.close();
});

test('normal application shutdown forwards preserveUiState to renderer disposal', async () => {
  const calls = [], client = { isClosed: false, on() { return () => {}; }, async request(method, params) { calls.push({ method, params }); if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }; if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'one' }; return { result: { value: true } }; } };
  const controller = new WorkBuddyCdpController(client, { rendererSource: 'true' });
  await controller.install(); await controller.dispose({ preserveUiState: true });
  const dispose = calls.find(c => c.method === 'Runtime.evaluate' && c.params.expression.includes('dispose'));
  assert.ok(dispose.params.expression.includes('preserveUiState'));
  assert.ok(dispose.params.expression.includes('true'));
});

test('Host awaits authoritative official model refresh for catalog and generation but never for stop', async t => {
  const dir = state(t), a = adapter(), calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  a.refreshOfficialModels = async () => { calls.push('refresh'); await gate; };
  a.createThread = async () => { calls.push('create'); return { id: 'official' }; };
  a.cancelTurn = async () => { calls.push('cancel'); return { status: 'cancelled' }; };
  const runtime = new PiHostRuntime(a, { stateDir: dir });
  const pending = runtime.dispatch('thread.create');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['refresh']);
  await runtime.dispatch('turn.cancel', { threadId: 'official' });
  assert.deepEqual(calls, ['refresh', 'cancel']);
  release(); await pending;
  assert.deepEqual(calls, ['refresh', 'cancel', 'create']);
  await runtime.close();
});

test('Host forwards native home workspace and selected model without discarding send intent', async t => {
  const dir = state(t), a = adapter(), runtime = new PiHostRuntime(a, { stateDir: dir });
  const created = (await runtime.dispatch('thread.create', { title: 'native home', cwd: '', model: 'hy4-preview-ioa', workspaceAutoGenerated: true })).thread;
  assert.equal(created.model, 'hy4-preview-ioa');
  assert.equal(created.cwd, '');
  assert.equal(created.workspaceAutoGenerated, true);
  const turn = (await runtime.dispatch('turn.start', { threadId: 'one', prompt: 'test', model: 'hy4-preview-ioa' })).turn;
  assert.equal(turn.model, 'hy4-preview-ioa');
  await assert.rejects(runtime.dispatch('thread.create', { workspaceAutoGenerated: 'yes' }));
  await assert.rejects(runtime.dispatch('thread.create', { model: '' }));
  await runtime.close();
});

test('Host forwards approval policy and persists only recognized preference migration markers', async t => {
  const dir = state(t), a = adapter(), calls = [];
  a.setApprovalMode = async params => { calls.push(params); return { id: params.threadId, approvalMode: params.approvalMode }; };
  const runtime = new PiHostRuntime(a, { stateDir: dir });
  assert.equal((await runtime.dispatch('thread.create', { approvalMode: 'auto' })).thread.approvalMode, 'auto');
  assert.equal((await runtime.dispatch('thread.approval.set', { threadId: 'one', approvalMode: 'manual' })).thread.approvalMode, 'manual');
  assert.deepEqual(calls, [{ threadId: 'one', approvalMode: 'manual' }]);
  for (const params of [{ threadId: '', approvalMode: 'auto' }, { threadId: 'one', approvalMode: '' }, { threadId: 'one', approvalMode: 'x'.repeat(17) }]) {
    await assert.rejects(runtime.dispatch('thread.approval.set', params));
  }
  await runtime.dispatch('ui.update', { approvalPreferenceSeed: 'pi-040-auto' });
  await assert.rejects(runtime.dispatch('ui.update', { approvalPreferenceSeed: 'unrecognized' }));
  await runtime.close();
  const restored = new PiHostRuntime(adapter(), { stateDir: dir });
  assert.equal((await restored.dispatch('ui.snapshot')).uiState.approvalPreferenceSeed, 'pi-040-auto');
  await restored.close();
});

test('Pi config accepts a configurable task root without allocating tasks and validates approval policy', t => {
  const dir = state(t), filename = path.join(dir, 'config.json');
  const config = { command: process.execPath, cwd: dir, workspaceRoot: 'new-tasks', approvalMode: 'auto', stateDir: 'state', agentDir: 'agent', provider: 'ollama', model: 'qwen' };
  fs.writeFileSync(filename, JSON.stringify(config));
  const parsed = readPiConfig(filename);
  assert.equal(parsed.workspaceRoot, path.join(dir, 'new-tasks')); assert.equal(parsed.approvalMode, 'auto');
  assert.equal(fs.existsSync(parsed.workspaceRoot), false);
  for (const bad of [{ approvalMode: 'always' }, { workspaceRoot: '' }, { workspaceRoot: 'bad\nroot' }]) {
    fs.writeFileSync(filename, JSON.stringify({ ...config, ...bad })); assert.throws(() => readPiConfig(filename));
  }
});

test('Host validates context-window transport types and forwards reset as null', async t => {
  const dir = state(t), a = adapter(), changes = [];
  a.setContextWindow = async params => { changes.push(params); return { id: params.threadId, contextWindow: params.contextWindow ?? 300000 }; };
  const runtime = new PiHostRuntime(a, { stateDir: dir });
  assert.equal((await runtime.dispatch('thread.context.window.set', { threadId: 'one', contextWindow: 960000 })).thread.contextWindow, 960000);
  assert.equal((await runtime.dispatch('thread.context.window.set', { threadId: 'one', contextWindow: null })).thread.contextWindow, 300000);
  for (const value of ['960000', {}, [], true, NaN, undefined]) await assert.rejects(runtime.dispatch('thread.context.window.set', { threadId: 'one', contextWindow: value }));
  assert.deepEqual(changes, [{ threadId: 'one', contextWindow: 960000 }, { threadId: 'one', contextWindow: null }]);
  await runtime.close();
});
