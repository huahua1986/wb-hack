import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inspectAsar } from '../package-dmg/asar.mjs';
import {
  NATIVE_PREVIEW_MEMBER, NATIVE_PREVIEW_ORIGINAL_SHA256, NATIVE_PREVIEW_PATCHED_SHA256,
  NATIVE_PREVIEW_EVENT, nativePreviewFunctionSource, patchNativePreviewBytes, applyNativePreviewPatch,
} from '../package-dmg/native-preview-patch.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/native-preview-5111.source.json', import.meta.url)));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const tab = (values = {}) => ({ id: '/workspace/report.md', filePath: '/workspace/report.md', fileName: 'report.md',
  viewMode: 'rendered', content: 'FIRST', loadingState: 'loaded', ...values });

function mount({ tabs = [tab()], activeId = tabs[0]?.id, read, probe, sessionId = 'session-a' } = {}) {
  const state = { tabs, activeId }, cells = [], effects = [], listeners = new Map(), timers = new Map();
  const reads = [], probes = [], updates = [], errors = [];
  let cursor = 0, nextTimer = 0, dead = false, api;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const mutate = (filename, callback) => {
    state.tabs = state.tabs.map(value => value.filePath === filename ? callback(value) : value);
    if (!dead) render();
  };
  const nativeTabs = {
    setTabLoading: filename => mutate(filename, value => ({ ...value, loadingState: 'loading' })),
    updateTabContent: (filename, content, loadingState, sniffedExtension) => {
      updates.push({ filename, content, loadingState });
      mutate(filename, value => ({ ...value, content: content ?? undefined, file: undefined, loadingState, sniffedExtension, oversized: undefined }));
    },
    updateTabFile: (filename, file, loadingState) => mutate(filename, value => ({ ...value, file, content: undefined, loadingState })),
    setTabOversized: (filename, oversized) => mutate(filename, value => ({ ...value, content: undefined, file: undefined, oversized, loadingState: 'loaded' })),
  };
  const props = {
    sessionId,
    readFileWithFormat: async (filename, format) => { reads.push({ filename, format }); return read ? read(filename, format) : 'SECOND'; },
    probeLocalFileSize: async filename => { probes.push(filename); return { success: true, size: probe ? await probe(filename) : 20 }; },
  };
  const context = vm.createContext({
    URL, Blob, Uint8Array, ArrayBuffer, navigator: { platform: 'MacIntel' },
    console: { error: (...args) => errors.push(args), warn: (...args) => errors.push(args) },
    window: {
      addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
      removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
    },
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    ar: {
      useRef(value) { const index = cursor++; return cells[index] ??= { current: value }; },
      useCallback(fn, deps) { const index = cursor++, old = cells[index]; if (old && same(old.deps, deps)) return old.value; cells[index] = { deps, value: fn }; return fn; },
      useEffect(fn, deps) {
        const index = cursor++, old = cells[index];
        if (old && same(old.deps, deps)) return;
        cells[index] = { deps, cleanup: old?.cleanup }; effects.push(() => { cells[index].cleanup?.(); cells[index].cleanup = fn(); });
      },
    },
    useTabsContext: () => ({ ...nativeTabs, tabs: state.tabs, activeTabId: state.activeId }),
    Ln: () => ({ contentType: 'document', extension: 'md', mimeContentType: 'text/markdown' }),
    Jn: () => 'text',
    Fn: ({ size }) => ({ isOversized: size > 100, limit: 100 }),
  });
  for (const helper of fixture.helpers) vm.runInContext(helper.source, context);
  const useLoader = vm.runInContext(`(${nativePreviewFunctionSource()})`, context);
  function render() {
    cursor = 0; api = useLoader(props);
    for (const effect of effects.splice(0)) effect();
    return api;
  }
  render();
  return {
    state, props, reads, probes, updates, errors, timers, render,
    dispatch(detail) { for (const fn of listeners.get(NATIVE_PREVIEW_EVENT) ?? []) fn({ detail }); },
    async flush() { const batch = [...timers.values()]; timers.clear(); for (const fn of batch) fn(); await tick(); await tick(); },
    listenerCount: () => listeners.get(NATIVE_PREVIEW_EVENT)?.size ?? 0,
    unmount() { dead = true; for (const cell of cells) cell?.cleanup?.(); },
    get api() { return api; },
  };
}

test('fixture pins exact 5.11.1 loader and the native hard-coded readonly Markdown route', () => {
  assert.equal(fixture.member, NATIVE_PREVIEW_MEMBER);
  assert.equal(fixture.memberSHA256, NATIVE_PREVIEW_ORIGINAL_SHA256);
  assert.equal(fixture.function.sha256, sha256(fixture.function.source));
  assert.equal(Buffer.byteLength(fixture.function.source), fixture.function.range.end - fixture.function.range.start);
  assert.equal(fixture.readonly.function.sha256, sha256(fixture.readonly.function.source));
  assert.equal((fixture.readonly.function.source.match(/readOnly:!0/g) ?? []).length, 2);
  for (const helper of fixture.helpers) assert.equal(sha256(helper.source), helper.sha256);
  assert.doesNotThrow(() => new vm.Script(`(${nativePreviewFunctionSource()})`));
});

test('byte patch rejects unknown or drifted source', () => {
  assert.throws(() => patchNativePreviewBytes(Buffer.from(fixture.function.source)), /pinned original/);
  assert.throws(() => patchNativePreviewBytes('not a Buffer'), /pinned original/);
  assert.throws(() => applyNativePreviewPatch({ read: () => Buffer.from('changed readonly route') }), /pinned original/);
});

test('matching file change reloads the active readonly preview using native probe, read and tab update', async () => {
  const f = mount();
  f.dispatch({ paths: ['/workspace/report.md'] }); await f.flush();
  assert.deepEqual(f.probes, ['/workspace/report.md']);
  assert.deepEqual(f.reads, [{ filename: '/workspace/report.md', format: 'text' }]);
  assert.equal(f.state.tabs[0].content, 'SECOND'); assert.equal(f.state.tabs[0].loadingState, 'loaded');
  f.unmount();
});

test('unmatched or arbitrary event paths are never used as filesystem arguments', async () => {
  const f = mount();
  for (const detail of [undefined, {}, { paths: ['/private/arbitrary-secret.md'] }, { paths: ['\0'] }, { paths: 'wrong' }, { paths: [null, {}] }]) f.dispatch(detail);
  await f.flush(); assert.deepEqual(f.reads, []); assert.deepEqual(f.probes, []);
  assert.equal(f.state.tabs[0].content, 'FIRST'); f.unmount();
});

test('invalidateAll reloads only the already-open active readonly tab and preserves its real path', async () => {
  const f = mount({ tabs: [tab({ id: 'active', filePath: '/workspace/Report.md' }), tab({ id: 'inactive', filePath: '/workspace/inactive.md' })], activeId: 'active' });
  f.dispatch({ invalidateAll: true }); await f.flush();
  assert.deepEqual(f.reads.map(read => read.filename), ['/workspace/Report.md']);
  assert.equal(f.state.tabs[1].content, 'FIRST');
  f.dispatch({ paths: ['/WORKSPACE/REPORT.MD'] }); await f.flush();
  assert.equal(f.reads[1].filename, '/workspace/Report.md'); f.unmount();
});

test('source, unknown editing states, empty content and non-Markdown tabs are skipped', async () => {
  for (const values of [{ viewMode: 'source' }, { viewMode: undefined }, { loadingState: 'unknown' }, { content: '' },
    { content: undefined }, { fileName: 'report.html', filePath: '/workspace/report.html' }, { file: new Blob(['unknown']) }, { oversized: { size: 200 } }]) {
    const f = mount({ tabs: [tab(values)] }); f.dispatch({ invalidateAll: true }); await f.flush();
    assert.deepEqual(f.reads, []); assert.deepEqual(f.probes, []); assert.deepEqual(f.updates, []); f.unmount();
  }
});

test('native oversize path prevents reads and retains its native oversized state', async () => {
  const f = mount({ probe: () => 200 }); f.dispatch({ invalidateAll: true }); await f.flush();
  assert.deepEqual(f.reads, []); assert.equal(f.state.tabs[0].oversized.size, 200); assert.equal(f.state.tabs[0].oversized.limit, 100); f.unmount();
});

test('native read errors use the original error state and do not fabricate fresh content', async () => {
  const f = mount({ read: () => { throw new Error('synthetic read failure'); } }); f.dispatch({ invalidateAll: true }); await f.flush();
  assert.equal(f.state.tabs[0].loadingState, 'error'); assert.equal(f.state.tabs[0].content, undefined); assert.equal(f.errors.length, 1); f.unmount();
});

test('changing to source mode while a read is pending prevents its commit', async () => {
  let release;
  const f = mount({ read: () => new Promise(resolve => { release = resolve; }) }); f.dispatch({ invalidateAll: true }); await f.flush();
  f.state.tabs = [tab({ viewMode: 'source', content: 'USER-SOURCE-CONTENT' })]; f.render();
  release('LATE-DISK-CONTENT'); await tick();
  assert.equal(f.state.tabs[0].content, 'USER-SOURCE-CONTENT'); assert.deepEqual(f.updates, []); f.unmount();
});

test('a user or another editor changing content while a read is pending is never overwritten', async () => {
  let release;
  const f = mount({ read: () => new Promise(resolve => { release = resolve; }) }); f.dispatch({ invalidateAll: true }); await f.flush();
  f.state.tabs = [tab({ content: 'USER-CHANGED-CONTENT' })]; f.render(); release('LATE-DISK-CONTENT'); await tick();
  assert.equal(f.state.tabs[0].content, 'USER-CHANGED-CONTENT'); assert.deepEqual(f.updates, []); f.unmount();
});

test('switching tab or session while a read is pending prevents stale results', async () => {
  for (const change of ['tab', 'session']) {
    let release;
    const f = mount({ tabs: [tab(), tab({ id: 'other', filePath: '/workspace/other.md' })], read: () => new Promise(resolve => { release = resolve; }) });
    f.dispatch({ invalidateAll: true }); await f.flush();
    if (change === 'tab') f.state.activeId = 'other'; else f.props.sessionId = 'session-b';
    f.render(); release('STALE'); await tick(); assert.deepEqual(f.updates, []); f.unmount();
  }
});

test('repeated events fence an earlier asynchronous result even when it completes last', async () => {
  const pending = [];
  const f = mount({ read: () => new Promise(resolve => pending.push(resolve)) });
  f.dispatch({ invalidateAll: true }); await f.flush();
  f.dispatch({ invalidateAll: true }); await f.flush(); assert.equal(pending.length, 2);
  pending[1]('LATEST'); await tick(); pending[0]('EARLIER'); await tick();
  assert.equal(f.state.tabs[0].content, 'LATEST'); assert.equal(f.updates.length, 1); f.unmount();
});

test('subscription cleanup removes timers and invalidates an already pending read', async () => {
  const queued = mount(); queued.dispatch({ invalidateAll: true }); assert.equal(queued.listenerCount(), 1); assert.equal(queued.timers.size, 1);
  queued.unmount(); assert.equal(queued.listenerCount(), 0); assert.equal(queued.timers.size, 0); await queued.flush(); assert.deepEqual(queued.reads, []);
  let release;
  const pending = mount({ read: () => new Promise(resolve => { release = resolve; }) }); pending.dispatch({ invalidateAll: true }); await pending.flush();
  pending.unmount(); release('AFTER-UNMOUNT'); await tick(); assert.deepEqual(pending.updates, []);
});

test('the existing explicit native load method retains its original behavior', async () => {
  const f = mount({ tabs: [tab({ viewMode: 'source' })] });
  await f.api.loadFileContent('/workspace/report.md');
  assert.equal(f.state.tabs[0].content, 'SECOND'); assert.equal(f.reads.length, 1); f.unmount();
});

test('exact original member patches once and only the pinned function range changes', { skip: !process.env.NATIVE_PREVIEW_5111_TEST_ASAR }, () => {
  const archive = inspectAsar(process.env.NATIVE_PREVIEW_5111_TEST_ASAR), original = archive.read(NATIVE_PREVIEW_MEMBER);
  const { bytes, metadata } = applyNativePreviewPatch(archive);
  assert.equal(sha256(original), NATIVE_PREVIEW_ORIGINAL_SHA256); assert.equal(sha256(bytes), NATIVE_PREVIEW_PATCHED_SHA256);
  assert.deepEqual(original.subarray(metadata.readonlyDependency.start, metadata.readonlyDependency.end), Buffer.from(fixture.readonly.function.source));
  assert.deepEqual(bytes.subarray(0, metadata.patchedFunction.start), original.subarray(0, metadata.originalFunction.start));
  assert.deepEqual(bytes.subarray(metadata.patchedFunction.end), original.subarray(metadata.originalFunction.end));
  assert.throws(() => patchNativePreviewBytes(bytes), /already patched/);
  const changed = Buffer.from(original); changed[0] ^= 1;
  assert.throws(() => patchNativePreviewBytes(changed), /pinned original/);
  const parsed = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: bytes, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
});
