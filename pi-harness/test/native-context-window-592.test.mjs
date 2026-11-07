import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { inspectAsar } from '../package-dmg/asar.mjs';
import { sha256File } from '../package-dmg/build.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/native-context-window-592.source.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
function source(name) {
  const value = fixture.slices.find(entry => entry.name === name);
  assert.ok(value, `Missing native source: ${name}`);
  return value.source;
}
const callable = (name, context = {}) => vm.runInNewContext(`(${source(name)})`, context);
const method = (name, context = {}) => vm.runInNewContext(`({${source(name)}}).setContextWindow`, context);
function deferred() {
  let resolve, reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function nativeModelMetadata() {
  const context = vm.createContext({
    getModelDisplayName: model => model.name,
    getModelIconValue() {}, getModelGroupId() {}, getModelDescription() {},
    isCustomModel: () => false, resolveModelReasoning() {},
    isExternalModelForIoa: () => false, resolveModelBadges: () => [],
  });
  vm.runInContext(source('adapt-model') + ';' + source('model-options') + ';globalThis.api={adapt:adaptModelInfoToInternal,options:convertInternalModelToOptions}', context);
  return context.api;
}

function nativeConfigEvents({ skip = false } = {}) {
  const handlers = new Map(), updates = [], forwarded = [];
  const context = vm.createContext({
    n: { on: (event, handler) => handlers.set(event, handler) },
    Zo: { ConfigUpdate: 'configUpdate' }, shouldSkip: () => skip,
    a: { getState: () => ({ setContextWindow: value => updates.push(value) }) },
    readThoughtLevel() {}, readExpertId() {}, readSceneMode() {}, readAcpPermissionMode() {}, readConnectors() {},
    s: { emit: (event, payload) => forwarded.push({ event, payload }) },
  });
  vm.runInContext(source('read-window') + ';' + source('config-update'), context);
  return { handlers, updates, forwarded };
}

function nativeCapability(initial, setContextWindow, { throwApiError = () => {} } = {}) {
  let value = initial;
  const updates = [];
  const owner = {
    revisions: { contextWindow: 0 },
    getConversation: () => ({ configManager: { setContextWindow } }),
    sessionStore: { getState: () => ({ contextWindow: value, setContextWindow(next) { value = next; updates.push(next); } }) },
    enqueueCoreMutation: mutation => mutation(),
    isStale: (key, revision) => owner.revisions[key] !== revision,
  };
  const set = method('capability-setter', { throwConversationApiError: throwApiError });
  return { set: input => set.call(owner, input), value: () => value, updates, owner };
}

function nativeSdk(initial, configSetContextWindow) {
  const context = vm.createContext({ e: { configSetContextWindow }, t: 'fixture-conversation', initial });
  vm.runInContext(`let d=initial;globalThis.api={${source('sdk-setter')},getContextWindow:()=>d}`, context);
  return context.api;
}

function nativeHome({ selected, temporary, perModel, saved, remote = false, setContextWindow = async () => {} } = {}) {
  const calls = [], warnings = [];
  const context = vm.createContext({
    t: remote, n: { accountInfo: { userId: 'fixture-user' } },
    c: { modelId: 'fixture-model', selectedContextWindow: selected },
    Fa: () => saved, sa: () => ({ buddyAppScopeKey: 'fixture-app' }), tn: () => perModel,
    li: { getSnapshot: () => temporary, clear: () => calls.push('clear') },
    D: { configManager: { setContextWindow(value) { calls.push(['setContextWindow', value]); return setContextWindow(value); } } },
    isApiError: value => !!value?.errorCode,
    console: { warn: (...args) => warnings.push(args) },
  });
  vm.runInContext(`globalThis.run=async()=>{${source('home-local-window')}}`, context);
  return { run: context.run, calls, warnings };
}

test('native context-window fixture pins original 5.9.2 artifact, members and exact UTF-8 byte ranges', () => {
  assert.equal(fixture.workbuddyVersion, '5.9.2');
  assert.equal(fixture.artifactSHA256, '0b79c0358c129749bc3355f52bbae13f115577ab37c082a76dfdc54f66fd3f79');
  const members = {
    'renderer/assets/src-C-yvPLiT.js': '7e4438995d9f67ac10a67b964bfdad2a543def60a7df06f708df2ed41454a1f8',
    'renderer/assets/contexts-Qs-ojFS9.js': '3e6df25ee2c417f9c791ab3e0ca8c7bad50987c5b294c12a7d6000fc618f71ac',
    'renderer/assets/wb-DkFLYXY0.js': '1f0175d71409396bb408f72450f9ca09c8d9fcdc66ed58d3a0dc618e8e3f0c5c',
    'renderer/assets/home-BPWB0jVF.js': 'bb156840b3edfa26640b8d4eae544d0f7eeef23f42e72eb3b5d6e35de19180cb',
  };
  assert.equal(fixture.slices.length, 11);
  assert.deepEqual(Object.fromEntries(fixture.members.map(value => [value.member, value.sha256])), members);
  for (const entry of fixture.slices) {
    assert.equal(entry.memberSHA256, members[entry.member], entry.name);
    assert.equal(entry.range.encoding, 'UTF-8');
    assert.equal(hash(entry.source), entry.sha256, entry.name);
    assert.equal(Buffer.byteLength(entry.source), entry.bytes, entry.name);
    assert.equal(entry.bytes, entry.range.end - entry.range.start, entry.name);
  }
});

test('native model metadata maps raw contextWindow lengths into selectable and default context windows', () => {
  const api = nativeModelMetadata();
  const raw = {
    id: 'fixture-model', name: 'Fixture model', maxInputTokens: 131072,
    contextWindow: { defaultLength: 65536, supportedLengths: [16384, 65536, 131072] },
    supportedContextWindows: [1, 2], defaultContextWindow: 1,
  };
  const internal = api.adapt(raw);
  assert.equal(internal.maxInputTokens, 131072);
  assert.equal(internal.contextWindow, raw.contextWindow);
  const options = api.options(internal, {});
  assert.equal(options.length, 1);
  const option = options[0];
  assert.equal(option.maxInputTokens, 131072);
  assert.equal(option.supportedContextWindows, raw.contextWindow.supportedLengths);
  assert.equal(option.defaultContextWindow, 65536);
  const supported = Array.from(callable('supported-windows')(option));
  assert.deepEqual(supported, [16384, 65536, 131072]);
  assert.equal(vm.runInNewContext(source('default-window'), { n: option, D: supported }), 65536);
});

test('native raw-model adapter discards top-level supportedContextWindows and defaultContextWindow aliases', () => {
  const api = nativeModelMetadata();
  const raw = {
    id: 'fixture-model', name: 'Fixture model', maxInputTokens: 131072,
    supportedContextWindows: [16384, 65536, 131072], defaultContextWindow: 65536,
  };
  const internal = api.adapt(raw);
  assert.equal(Object.hasOwn(internal, 'supportedContextWindows'), false);
  assert.equal(Object.hasOwn(internal, 'defaultContextWindow'), false);
  assert.equal(internal.maxInputTokens, 131072);
  const [option] = api.options(internal, {});
  assert.equal(option.supportedContextWindows, undefined);
  assert.equal(option.defaultContextWindow, undefined);
  assert.deepEqual(Array.from(callable('supported-windows')(option)), []);
});

test('native context-window options deduplicate, sort, reject invalid values and respect the input limit', () => {
  const supported = callable('supported-windows');
  const input = [128000, 32000, 64000, 32000, 0, -1, 1.5, '16000', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
  assert.deepEqual(Array.from(supported({ supportedContextWindows: input, maxInputTokens: 64000 })), [32000, 64000]);
  assert.deepEqual(Array.from(supported({ supportedContextWindows: input })), [32000, 64000, 128000]);
  assert.deepEqual(Array.from(supported({ maxInputTokens: 64000 })), []);
});

test('native window selection prefers a supported selection, then supported default, then the first option', () => {
  const pick = n => vm.runInNewContext(source('default-window'), { n, D: [32000, 64000, 128000] });
  assert.equal(pick({ selectedContextWindow: 128000, defaultContextWindow: 64000 }), 128000);
  assert.equal(pick({ selectedContextWindow: 96000, defaultContextWindow: 64000 }), 64000);
  assert.equal(pick({ selectedContextWindow: '128000', defaultContextWindow: '64000' }), 32000);
  assert.equal(vm.runInNewContext(source('default-window'), { n: {}, D: [] }), undefined);
});

test('native preference clamp requires at least two distinct supported positive safe-integer windows', () => {
  const clamp = callable('clamp-window');
  assert.equal(clamp(64000, [128000, 64000, 64000, 0, '32000', 1.5]), 64000);
  assert.equal(clamp(64000, [64000, 64000, 0, '32000']), undefined);
  assert.equal(clamp(32000, [64000, 128000]), undefined);
  for (const value of [undefined, '64000', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(clamp(value, [64000, 128000]), undefined);
  }
});

test('native slider starts a model switch before callbacks and does not await its completion', async () => {
  const pending = deferred(), calls = [], next = { id: 'next' };
  const change = callable('window-change', {
    n: {
      options: [next], onChange: value => calls.push(['onChange', value]),
      onContextWindowChange: (...args) => calls.push(['onContextWindowChange', ...args]),
    },
    m: { id: 'current' }, p: { api: { setModel: value => { calls.push(['setModel', value]); return pending.promise; } } },
    createModelSelection: model => ({ id: model.id, isThinking: true }), getDefaultIsThinking: () => true,
  });
  assert.equal(change('next', 64000), undefined);
  assert.deepEqual(calls.map(value => value[0]), ['setModel', 'onChange', 'onContextWindowChange']);
  assert.equal(calls[0][1], calls[1][1]);
  assert.deepEqual(calls[2], ['onContextWindowChange', 'next', 64000]);
  pending.resolve();
  await pending.promise;
});

test('native slider retains the window callback when the model is unchanged or absent', () => {
  const calls = [];
  const change = callable('window-change', {
    n: { options: [{ id: 'current' }], onContextWindowChange: (...args) => calls.push(args) },
    m: { id: 'current' },
  });
  change('current', 32000);
  change('missing', 64000);
  assert.deepEqual(calls, [['current', 32000], ['missing', 64000]]);
});

test('native context-window config accepts positive safe-integer strings after Number conversion', () => {
  const read = callable('read-window');
  for (const [value, expected] of [['64000', 64000], [' 32000 ', 32000], ['1e3', 1000]]) {
    assert.equal(read({ options: [{ key: 'context_window', value }] }), expected);
  }
  for (const value of ['', ' \t', '0', '-1', '1.5', 'Infinity', 'NaN', '9007199254740992', 64000, undefined]) {
    assert.equal(read({ options: [{ key: 'context_window', value }] }), undefined);
  }
  assert.equal(read({ options: [{ key: 'contextWindow', value: '64000' }] }), undefined);
  assert.equal(read({}), undefined);
});

test('native subscription applies context_window through configUpdate and forwards that event', () => {
  const native = nativeConfigEvents();
  assert.deepEqual([...native.handlers.keys()], ['configUpdate']);
  const valid = { options: [{ key: 'context_window', value: '64000' }] };
  native.handlers.get('configUpdate')(valid);
  assert.deepEqual(native.updates, [64000]);
  assert.equal(native.forwarded[0].event, 'configUpdate');
  assert.equal(native.forwarded[0].payload.payload, valid);
  native.handlers.get('configUpdate')({ options: [{ key: 'context_window', value: 128000 }] });
  assert.deepEqual(native.updates, [64000]);
  assert.equal(native.forwarded.length, 2);
  const skipped = nativeConfigEvents({ skip: true });
  skipped.handlers.get('configUpdate')(valid);
  assert.deepEqual(skipped.updates, []);
  assert.deepEqual(skipped.forwarded, []);
});

test('native capability optimistically updates a numeric window, preserves wire strings and resets with empty string', async () => {
  const pending = deferred(), calls = [];
  const native = nativeCapability(32000, value => { calls.push(value); return pending.promise; });
  const setting = native.set('64000');
  assert.equal(native.value(), 64000);
  assert.deepEqual(calls, ['64000']);
  pending.resolve();
  await setting;
  assert.deepEqual(native.updates, [64000]);
  await native.set('');
  assert.equal(native.value(), undefined);
  assert.deepEqual(calls, ['64000', '']);
});

test('native capability rolls back rejected or returned API errors and keeps newer revisions intact', async () => {
  const rejection = new Error('core rejected');
  const native = nativeCapability(32000, async () => { throw rejection; });
  await assert.rejects(native.set('64000'), error => error === rejection);
  assert.equal(native.value(), 32000);
  assert.deepEqual(native.updates, [64000, 32000]);
  const apiError = { errorCode: 'REJECTED' };
  const returned = nativeCapability(32000, async () => apiError, { throwApiError: result => { assert.equal(result, apiError); throw rejection; } });
  await assert.rejects(returned.set('64000'), error => error === rejection);
  assert.equal(returned.value(), 32000);
  const first = deferred();
  const concurrent = nativeCapability(32000, value => value === '64000' ? first.promise : undefined);
  const stale = concurrent.set('64000');
  await concurrent.set('128000');
  first.reject(rejection);
  await assert.rejects(stale, error => error === rejection);
  assert.equal(concurrent.value(), 128000);
  assert.deepEqual(concurrent.updates, [64000, 128000]);
});

test('native SDK caches successful wire strings only after acknowledgement and resets to undefined', async () => {
  const pending = deferred(), calls = [];
  const sdk = nativeSdk('32000', (...args) => { calls.push(args); return pending.promise; });
  const setting = sdk.setContextWindow('64000');
  assert.equal(sdk.getContextWindow(), '32000');
  assert.deepEqual(calls, [['fixture-conversation', '64000']]);
  pending.resolve({ accepted: true });
  assert.equal((await setting).accepted, true);
  assert.equal(sdk.getContextWindow(), '64000');
  await sdk.setContextWindow('');
  assert.equal(sdk.getContextWindow(), undefined);
  assert.deepEqual(calls[1], ['fixture-conversation', '']);
});

test('native SDK preserves its prior window on an error response or a rejected request', async () => {
  const apiError = { errorCode: 'REJECTED', message: 'unsupported window' };
  const sdk = nativeSdk('32000', async () => apiError);
  assert.equal(await sdk.setContextWindow('64000'), apiError);
  assert.equal(sdk.getContextWindow(), '32000');
  const rejection = new Error('transport rejected');
  const rejected = nativeSdk('32000', async () => { throw rejection; });
  await assert.rejects(rejected.setContextWindow(''), error => error === rejection);
  assert.equal(rejected.getContextWindow(), '32000');
});

test('native home uses selected, temporary, per-model and saved window precedence for local tasks', async () => {
  const cases = [
    [{ selected: 128000, temporary: 64000, perModel: 32000, saved: { contextWindow: 16000 } }, '128000'],
    [{ temporary: 64000, perModel: 32000, saved: { contextWindow: 16000 } }, '64000'],
    [{ perModel: 32000, saved: { contextWindow: 16000 } }, '32000'],
    [{ saved: { contextWindow: 16000 } }, '16000'],
  ];
  for (const [input, expected] of cases) {
    const native = nativeHome(input);
    await native.run();
    assert.deepEqual(native.calls, [['setContextWindow', expected], 'clear', 'clear']);
  }
  const empty = nativeHome();
  await empty.run();
  assert.deepEqual(empty.calls, ['clear', 'clear']);
  const remote = nativeHome({ selected: 64000, remote: true });
  await remote.run();
  assert.deepEqual(remote.calls, []);
});

test('native home configuration block awaits the setter and propagates rejection before continuation', async () => {
  const pending = deferred();
  const native = nativeHome({ selected: 64000, setContextWindow: () => pending.promise });
  let continued = false;
  const setting = native.run().then(() => { continued = true; });
  assert.deepEqual(native.calls, [['setContextWindow', '64000']]);
  assert.equal(continued, false);
  pending.resolve();
  await setting;
  assert.equal(continued, true);
  assert.deepEqual(native.calls, [['setContextWindow', '64000'], 'clear', 'clear']);
  const rejection = new Error('window rejected');
  const rejected = nativeHome({ selected: 64000, setContextWindow: async () => { throw rejection; } });
  await assert.rejects(rejected.run().then(() => assert.fail('Rejected configuration reached continuation')), error => error === rejection);
  assert.deepEqual(rejected.calls, [['setContextWindow', '64000']]);
});

test('native home warns and continues when the setter resolves to an API error', async () => {
  const native = nativeHome({ selected: 64000, setContextWindow: async () => ({ errorCode: 'REJECTED', message: 'unsupported window' }) });
  await native.run();
  assert.deepEqual(native.calls, [['setContextWindow', '64000'], 'clear', 'clear']);
  assert.deepEqual(native.warnings, [['[Home] Failed to apply new-task context window:', 'unsupported window']]);
});

const installed = process.env.WORKBUDDY_TEST_SOURCE_ASAR_592 ?? process.env.WORKBUDDY_TEST_SOURCE_ASAR ?? '/Applications/WorkBuddy.app/Contents/Resources/app.asar';
const hasOriginal592 = fs.existsSync(installed) && JSON.parse(inspectAsar(installed).read('package.json')).version === '5.9.2';
test('selected pinned 5.9.2 artifact matches all native context-window fixture members and slices', {
  skip: hasOriginal592 ? false : 'The pinned WorkBuddy 5.9.2 ASAR is unavailable; fixture replay remains available',
}, () => {
  assert.equal(sha256File(installed), fixture.artifactSHA256);
  const archive = inspectAsar(installed);
  const members = new Map(fixture.members.map(entry => [entry.member, archive.read(entry.member)]));
  for (const entry of fixture.members) assert.equal(hash(members.get(entry.member)), entry.sha256, entry.member);
  for (const entry of fixture.slices) {
    assert.equal(members.get(entry.member).subarray(entry.range.start, entry.range.end).toString('utf8'), entry.source, entry.name);
  }
});
