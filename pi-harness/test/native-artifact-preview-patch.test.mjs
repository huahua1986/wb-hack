import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inspectAsar } from '../package-dmg/asar.mjs';
import { nativeArtifacts } from '../src/file-resources.mjs';
import {
  NATIVE_ARTIFACT_PREVIEW_PINS, NATIVE_ARTIFACT_PREVIEW_EVENT, NATIVE_ARTIFACT_PREVIEW_STATUS_EVENT,
  nativeArtifactPreviewSource, patchNativeArtifactPreviewBytes, applyNativeArtifactPreviewPatch,
} from '../package-dmg/native-artifact-preview-patch.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/native-artifact-preview-5111.source.json', import.meta.url)));
const abiFixture = JSON.parse(fs.readFileSync(new URL('./fixtures/native-artifact-preview-abi-592.source.json', import.meta.url)));
const resourceFixture = JSON.parse(fs.readFileSync(new URL('./fixtures/p0-native-592.source.json', import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const byMember = member => fixture.members.find(value => value.member === member);
const nativeSlice = (index, name) => fixture.members[index].slices.find(value => value.name === name).source;
const abiSlice = (index, name) => abiFixture.members[index].slices.find(value => value.name === name).source;
const fragment = index => {
  const member = fixture.members[index], slices = member.slices;
  const source = slices.map(value => `/*PI_SLICE:${value.name}*/` + value.source).join('\n');
  const patched = nativeArtifactPreviewSource(member.member, source);
  return Object.fromEntries(patched.split(/\/\*PI_SLICE:([^*]+)\*\//).slice(1).reduce((all, value, i, values) => {
    if (i % 2 === 0) all.push([value, values[i + 1].trim()]); return all;
  }, []));
};

// The renderer/bridge/session methods below are exact shipped consumer slices.
// Only React scheduling, parser I/O and files are synthetic; this is not proof
// that a particular GUI route is mounted. The diagnostic event covers that in
// the separately authorized desktop acceptance run.
function pipeline() {
  const parsers = [], commits = [], resets = [], timers = new Map(), clock = { now: 1000 };
  let timerId = 0;
  const editor = { rootId: 'root', text: 'FIRST', isDestroyed: false,
    load(records, rootId) { this.rootId = rootId; this.text = records.block.root.text; commits.push(this.text); } };
  const parser = text => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const loader = { chunks: [text], total: 1, disposed: false,
      loadFirst: () => promise, loadNext: async () => [], prefetch() {}, dispose() { this.disposed = true; } };
    parsers.push({ text, loader, complete: () => resolve({ rootId: 'root', records: { block: { root: { text, children: [] } } } }), reject });
    return loader;
  };
  const context = vm.createContext({ TextEncoder, console, Promise, Date: { now: () => clock.now },
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    B: parser, R: parser, r: () => ({}), k: class extends Error {},
    l: class { constructor(editor, loader) { this.editor = editor; this.loader = loader; } resetCache() {} getValue() { return this.editor.text; } dispose() {} },
  });
  const slices = fragment(3);
  const H = vm.runInContext(`(${slices.H})`, context); context.H = H;
  const U = vm.runInContext(`(${slices.U})`, context); context.U = U;
  const Session = vm.runInContext(`(${slices.MarkdownDocumentSession})`, context);
  const adapter = new U({ editor, worker: { disable: true } });
  const oldLoader = { disposed: false, dispose() { this.disposed = true; } };
  adapter.loadOrchestrator.loader = oldLoader;
  adapter.loadOrchestrator.originalChunks = ['original'];
  adapter.loadOrchestrator.rootId = 'root';
  const session = new Session(editor, {
    getValue: () => adapter.getValue(), load: text => adapter.load(text),
    loadIfClean: (text, guard, commit) => adapter.loadIfClean(text, undefined, guard, commit), dispose: () => adapter.dispose(),
  }, () => ({ readOnly: false }), () => { resets.push(editor.text); });
  session.loadedContent = 'FIRST'; session.loadedOnce = true;
  return { session, adapter, oldLoader, editor, parsers, commits, resets, clock, timers,
    update: next => session.updateContentIfClean('FIRST', next, clock.now + 1000),
    edit(text, source = 'user') { editor.text = text; session.contentChanged(source, 1); },
  };
}

function mount({ api, read, probe, contextValues = {} } = {}) {
  const cells = [], pendingEffects = [], listeners = new Map(), timers = new Map(), statuses = [], reads = [], probes = [];
  let cursor = 0, nextTimer = 0, output, watchCallback;
  const env = { content: 'FIRST', artifact: { id: 'pi-file-0123456789abcdef01234567', sessionId: 'session-a', url: '/workspace/report.md', title: 'report.md' },
    environmentType: 'local', extension: 'md', theme: 'dark', resolveMarkdownGuestUrl: async () => 'file:///native/markdown-shared-guest.html',
    readFile: async (path, format) => { reads.push({ path, format }); return read ? read(path, format) : 'SECOND'; },
    probeLocalFileSize: async path => { probes.push(path); return { success: true, size: probe ? await probe(path) : 6 }; },
    onSaveFile: async () => {}, subscribeFileChange(path, callback) { watchCallback = callback; return () => { watchCallback = undefined; }; },
    ...contextValues };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const hooks = {
    useRef(value) { const i = cursor++; return cells[i] ??= { current: value }; },
    useState(value) { const i = cursor++; cells[i] ??= { value }; return [cells[i].value, next => { cells[i].value = next; }]; },
    useCallback(fn, deps) { const i = cursor++, old = cells[i]; if (old && same(old.deps, deps)) return old.value; cells[i] = { deps, value: fn }; return fn; },
    useMemo(fn, deps) { const i = cursor++, old = cells[i]; if (old && same(old.deps, deps)) return old.value; cells[i] = { deps, value: fn() }; return cells[i].value; },
    useEffect(fn, deps) { const i = cursor++, old = cells[i]; if (old && same(old.deps, deps)) return; cells[i] = { deps, cleanup: old?.cleanup }; pendingEffects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = fn(); }); },
  };
  const window = {
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
    dispatchEvent(event) { if (event.type === NATIVE_ARTIFACT_PREVIEW_STATUS_EVENT) statuses.push(event.detail.reason); for (const fn of listeners.get(event.type) ?? []) fn(event); },
  };
  const context = vm.createContext({ TextEncoder, URL, console: { info() {}, warn() {}, error() {} }, Date, Promise,
    navigator: { platform: 'MacIntel' }, window, CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    l: hooks, u: { jsx: (type, props) => ({ type, props }) }, ae: () => env, ne: () => value => value,
    de: () => ({ settled: true }), fe: () => true, ue() {}, le() {}, ce() {}, ee: value => value ?? '', f: new Map(),
    me: 'MarkdownEditorModule', he: 10, ge: 15000, r: value => value, a: 'NativeMarkdownEditorCore', pe: 'NativeMarkdownPreview', te: { error() {} },
    ie: () => ({ isOversized: false }), se() {},
    v: 5000, o: 'Loading',
  });
  vm.runInContext(nativeSlice(0, 'decodeFilePath'), context);
  vm.runInContext(nativeSlice(5, 'isProbeableLocalPath') + ';' + nativeSlice(5, 'probeFileSize') + ';var oe=probeFileSize;', context);
  const Editor = vm.runInContext(`(${fragment(0).MarkdownEditor})`, context);
  function render() {
    cursor = 0; output = Editor({});
    if (output.props?.ref) output.props.ref.current = api;
    for (const effect of pendingEffects.splice(0)) effect();
    return output;
  }
  render();
  return { env, reads, probes, statuses, timers, render, get output() { return output; },
    emit(detail = { files: [{ path: env.artifact.url, size: 6 }] }) { window.dispatchEvent({ type: NATIVE_ARTIFACT_PREVIEW_EVENT, detail }); },
    watch() { watchCallback?.(); },
    async flushNative() { for (const [id, timer] of [...timers]) if (timer.ms === 250) { timers.delete(id); timer.fn(); } await tick(); },
    async flush() { for (const [id, timer] of [...timers]) if (timer.ms === 80) { timers.delete(id); timer.fn(); } for (let i = 0; i < 12; i++) await tick(); },
    async timeouts() { for (const [id, timer] of [...timers]) if (timer.ms === 1500) { timers.delete(id); timer.fn(); } await tick(); },
    unmount() { for (const cell of cells) cell?.cleanup?.(); },
    listenerCount: () => listeners.get(NATIVE_ARTIFACT_PREVIEW_EVENT)?.size ?? 0,
  };
}

function bridge(pipeline) {
  let host, guest;
  const sent = [], parent = { postMessage(data) { sent.push({ direction: 'guest-to-host', data }); queueMicrotask(() => host.handleMessage({ source: frame, origin: 'https://guest.test', data })); } };
  const frame = { postMessage(data) { sent.push({ direction: 'host-to-guest', data }); queueMicrotask(() => guest.handleMessage({ source: parent, data })); } };
  const globals = { URL, console, Promise, setTimeout, clearTimeout };
  const protocol = fixture.members[6].slices.map(value => value.name === 'MarkdownGuestRequestTracker'
    ? `var MarkdownGuestRequestTracker=${value.source};` : value.source).join(';');
  const hostContext = vm.createContext({ ...globals, window: { addEventListener() {}, removeEventListener() {} }, r: 10000 });
  vm.runInContext(protocol + ';var _=MarkdownGuestRequestTracker,h="workbuddy-markdown-host",g=isMarkdownGuestMessage,p=isCompatibleProtocolVersion;', hostContext);
  host = new (vm.runInContext(`(${fragment(1).MarkdownGuestHostBridge})`, hostContext))();
  host.attach({ src: 'https://guest.test/frame.html', contentWindow: frame }, {});
  const guestContext = vm.createContext({ ...globals, window: { parent, addEventListener() {}, removeEventListener() {} }, r: 10000, noop() {},
    n: { current: { getContent: () => pipeline.session.getContent(), isDirty: async () => pipeline.session.isDirty(),
      updateContentIfClean: (...args) => pipeline.session.updateContentIfClean(...args), updateContent: text => pipeline.session.load(text) } },
    s() {}, o() {}, i() {},
  });
  vm.runInContext(protocol + ';var u=MarkdownGuestRequestTracker,c="workbuddy-markdown-guest",l=isMarkdownHostMessage;', guestContext);
  vm.runInContext(nativeSlice(2, 'structuredCloneSafe'), guestContext);
  guest = new (vm.runInContext(`(${fragment(2).MarkdownGuestBridge})`, guestContext))();
  guest.setHandlers(vm.runInContext(`(${fragment(2).guestHandlers})`, guestContext));
  const ref = { current: null }, latestContent = { current: 'FIRST' };
  Object.assign(hostContext, { t: ref, A: latestContent, u: host, j: { current: null }, v: { useImperativeHandle: (target, create) => { target.current = create(); } } });
  vm.runInContext(fragment(1).imperativeHandle, hostContext);
  return { host, guest, ref, latestContent, sent, frame, parent, close() { host.detach(); guest.dispose(); } };
}

function coreRef(pipeline) {
  const source = fragment(4).imperativeHandle;
  const ref = { current: null }, context = vm.createContext({ te: ref, ee: {}, me: pipeline.editor,
    Ac: { useImperativeHandle(target, create) { target.current = create(); } },
    ge: () => pipeline.session.getContent(), _e: () => pipeline.session.isDirty(), be: () => pipeline.session.save(true),
    he: text => pipeline.session.load(text), ve: () => pipeline.session.getDiskBaseline(), xe() {}, Se: {},
    wbPiAtomicUpdate: (...args) => pipeline.session.updateContentIfClean(...args),
  });
  vm.runInContext(source, context);
  return ref;
}

function projectedArtifact() {
  const context = vm.createContext({ URL, Set, Map, WeakMap, Date, decodeURIComponent, console,
    isMcpAppOrArdotRawArtifact: () => false, isWbAppGenieMarkerRecord: () => false, _he: () => false });
  for (const slice of resourceFixture.slices) if (slice.kind === 'constant-assignment' || slice.kind === 'FunctionDeclaration' && slice.name !== 'useConversationRewind') vm.runInContext(slice.source, context);
  const raw = nativeArtifacts([{ threadId: 'host-thread', turnId: 'host-turn', path: '/workspace/report.md', name: 'report.md', exists: true,
    size: 6, mimeType: 'text/markdown', createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:01:00Z' }])[0];
  return { raw, projected: context.toConversationArtifactItem(raw, 'native-thread') };
}

function findElement(element, type) {
  if (!element || typeof element !== 'object') return;
  if (element.type === type) return element;
  for (const child of Array.isArray(element.props?.children) ? element.props.children : [element.props?.children]) {
    const found = findElement(child, type); if (found) return found;
  }
}

function nativeMediaChain(projected, probe) {
  const jsx = (type, props) => ({ type, props }), hooks = { useMemo: fn => fn(), useCallback: fn => fn,
    useState: value => [typeof value === 'function' ? value() : value, () => {}], useRef: value => ({ current: value }), useEffect() {} };
  const read = async () => 'FIRST';
  // These stand-ins are unrelated toolbar/extension gates and React elements;
  // the complete original functions perform every artifact/reader projection.
  const watch = () => () => {};
  const rendererContext = vm.createContext({ ar: { ...hooks, Suspense: 'Suspense', memo: fn => fn }, or: { jsx }, ye: 'Boundary',
    ChunkLoadErrorFallback: 'ErrorFallback', It: { container: 'container' }, Wo: 'MediaPreview',
    bindOfficeWindowOpen: () => undefined, Kn: () => false, shouldRenderHtmlPreview: () => false, isMioraArtifact: () => false,
    Qt: value => value.split('/').pop(), Zt: value => value, URL, console,
  });
  vm.runInContext(nativeSlice(8, 'shouldRemountMediaArtifactOnRefresh'), rendererContext);
  const renderArtifact = vm.runInContext(`(${nativeSlice(8, 'ArtifactContentRenderer')})`, rendererContext);
  const media = findElement(renderArtifact({ artifact: projected, environmentType: 'local', readFileWithFormat: read, probeLocalFileSize: probe, subscribeFileChange: watch }), 'MediaPreview');
  assert.ok(media, 'actual native ArtifactContentRenderer must select MediaPreview');
  const mediaContext = vm.createContext({ J: hooks, Y: { jsx, jsxs: jsx }, Ze: 'ContextProvider', et: { Provider: 'HtmlEditProvider' },
    Z: { mediaPreview: 'preview', toolbar: 'toolbar', body: 'body' }, TopOverlayLayer: 'TopOverlayLayer', MarkdownZoomIndicator: 'ZoomIndicator',
    MediaPreviewHeader: 'Header', Body: 'Body', OnlineVersionSavedBanner: 'SavedBanner', ce: value => value, Ye: () => ({ suffix: 'md' }),
    l: 'MediaBoundary', MediaPreviewFallback: 'MediaFallback', console });
  const renderMedia = vm.runInContext(`(${nativeSlice(7, 'MediaPreviewContent')})`, mediaContext), provider = renderMedia(media.props);
  const readerInputs = [], providerHooks = { ...hooks, useState: () => [{ url: projected.url, nonce: 0, size: projected.size }, () => {}] };
  const providerContext = vm.createContext({ d: providerHooks, O: { jsx, jsxs: jsx }, k: { Provider: 'NativeContextProvider' }, MarkdownZoomProvider: 'ZoomProvider', MarkdownZoomChangeBridge: 'ZoomBridge',
    l: () => false, c: () => ({ isOversized: false }), useChangedFileTooLargeToast() {}, useArtifactOpenTelemetry() {},
    useLiveArtifactSize: artifact => ({ pending: false, artifact }), fileTypeDetector: () => ({ extension: 'md' }), safeDecodeURI: value => value,
    resolveArtifactOpenDescriptor: () => ({ suffix: 'md', isPreviewable: true, oversized: { isOversized: false } }),
    useArtifactReader(input) { readerInputs.push(input); return { content: 'FIRST', extension: 'md', artifactType: 'document', dataURI: input.uri, isLoading: false }; },
    URL, decodeURIComponent, console });
  const renderProvider = vm.runInContext(`(${nativeSlice(5, 'MediaPreviewContextProvider')})`, providerContext), nativeContext = renderProvider(provider.props).props.value;
  return { media, provider, nativeContext, readerInputs, read, watch };
}

test('fixture pins actual Media MarkdownEditor, native ref, authenticated bridge and core commit consumers', () => {
  assert.equal(fixture.sourceAsarSHA256, 'f0414d122ead12f3e997bb2e3d7811f35213fbd5b92063fab7361691b82253d6');
  for (const member of fixture.members) for (const slice of member.slices) {
    assert.equal(hash(slice.source), slice.sha256); assert.equal(Buffer.byteLength(slice.source), slice.end - slice.start);
  }
  for (const pin of NATIVE_ARTIFACT_PREVIEW_PINS) assert.equal(byMember(pin.member).sha256, pin.originalSHA256);
  assert.match(nativeSlice(0, 'MarkdownEditor'), /ref:H,resolveGuestUrl:M/);
  assert.match(nativeSlice(0, 'MarkdownEditor'), /content:c,artifact:d,subscribeFileChange:p/);
  assert.match(nativeSlice(2, 'MarkdownGuestBridge'), /e.source!==window.parent/);
  assert.match(nativeSlice(1, 'MarkdownGuestHostBridge'), /e.source!==this.iframe.contentWindow/);
});

test('raw Host artifact reaches actual native MediaPreview context with absolute URL, stable id/session and native reader/probe', () => {
  for (const member of abiFixture.members) for (const slice of member.slices) {
    assert.equal(hash(slice.source), slice.sha256); assert.equal(Buffer.byteLength(slice.source), slice.end - slice.start);
  }
  const { raw, projected } = projectedArtifact(), probe = async () => ({ success: true, size: 6 }), chain = nativeMediaChain(projected, probe);
  assert.equal(raw.uri, '/workspace/report.md'); assert.equal(raw.conversationId, 'host-thread');
  assert.equal(projected.url, raw.uri); assert.equal(projected.id, raw.id); assert.equal(projected.sessionId, raw.conversationId);
  assert.equal(chain.media.props.artifact, projected); assert.equal(chain.provider.props.artifact, projected);
  assert.equal(chain.nativeContext.artifact.url, raw.uri); assert.equal(chain.nativeContext.artifact.id, raw.id);
  assert.equal(chain.nativeContext.artifact.sessionId, raw.conversationId); assert.equal(chain.nativeContext.extension, 'md');
  assert.equal(chain.nativeContext.readFile, chain.read); assert.equal(chain.nativeContext.probeLocalFileSize, probe);
  assert.equal(chain.nativeContext.subscribeFileChange, chain.watch); assert.equal(chain.readerInputs[0].updatedAt, undefined);
  assert.equal(chain.nativeContext.environmentType, 'local'); assert.equal(chain.readerInputs[0].uri, raw.uri);
  const missing = nativeMediaChain(projected, undefined); assert.equal(missing.nativeContext.probeLocalFileSize, undefined);
  const api = { isDirty: async () => false, getContent: async () => 'FIRST', updateContentIfClean: async () => true };
  const mounted = mount({ api, contextValues: chain.nativeContext }); mounted.emit();
  assert.deepEqual(mounted.statuses, ['mounted', 'event', 'matched']); mounted.unmount();
  const noProbe = mount({ api, contextValues: missing.nativeContext }); noProbe.emit();
  assert.deepEqual(noProbe.statuses, ['mounted', 'event', 'probe-skipped']); noProbe.unmount();
});

test('5.9.2 adapter stat fixture retains its historical daemon allowedDirs contract', async () => {
  const calls = [], context = vm.createContext({ FileOperationsAdapter: undefined, e: {}, o: { daemonClient: { async fileGetInfo(path, options) { calls.push({ path, options }); return { size: 6, isFile: true, isDirectory: false }; } } } });
  const FileOperations = vm.runInContext(`(class { constructor(options){this.daemonClient=options.daemonClient;} ${abiSlice(4, 'fileOpsStat')} })`, context);
  context.FileOperationsAdapter = FileOperations;
  const Next = vm.runInContext(`(class { ${abiSlice(4, 'adapterEnvironment')} ${abiSlice(4, 'adapterStat')} })`, context), adapter = new Next();
  adapter.fileOps = vm.runInContext(abiSlice(4, 'adapterFileOps'), context); assert.equal(adapter.environmentType, 'local');
  const factoryContext = vm.createContext({ T: adapter, wr: value => value });
  const probe = vm.runInContext(`(${abiSlice(3, 'detailProbeFactory')})`, factoryContext)();
  const result = await probe('/workspace/report.md'); assert.equal(result.success, true); assert.equal(result.size, 6);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ path: '/workspace/report.md', options: { allowedDirs: ['/workspace/report.md'] } }]);
  adapter.fileOps.daemonClient = undefined; assert.equal((await probe('/workspace/report.md')).success, false);
  factoryContext.T = {}; assert.equal(vm.runInContext(`(${abiSlice(3, 'detailProbeFactory')})`, factoryContext)(), undefined);
});

test('native editor.load and record-store commit are synchronous in the pinned editor dependency', () => {
  const events = [], context = vm.createContext({ ue() { events.push('reset'); }, Q: { info() { events.push('log'); } } });
  const store = { ...vm.runInContext(`({${nativeSlice(3, 'recordStoreSetRecords')}})`, context), rebuildView() { events.push('view'); }, emit() { events.push('store-event'); } };
  const editor = { ...vm.runInContext(`({${nativeSlice(3, 'editorLoad')}})`, context), undoManager: { clear() { events.push('undo'); } }, recordStore: store, emitHistoryChange() { events.push('history'); } };
  const records = { block: { root: {} } }; assert.equal(editor.load(records, 'root'), undefined);
  assert.equal(store.records, records); assert.equal(editor._rootId, 'root'); assert.deepEqual(events, ['reset', 'undo', 'view', 'store-event', 'history', 'log']);
  assert.ok(!nativeSlice(3, 'editorLoad').includes('await')); assert.ok(!nativeSlice(3, 'recordStoreSetRecords').includes('await'));
});

test('clean update commits only after native staged parser and keeps exporter bound to original loader object', async () => {
  const p = pipeline(), originalLoader = p.adapter.loadOrchestrator, originalExporter = p.adapter.exportOrchestrator;
  const result = p.update('SECOND'); await tick();
  assert.equal(p.editor.text, 'FIRST'); assert.equal(p.session.loadedContent, 'FIRST'); assert.equal(p.session.generation, 0);
  assert.equal(p.oldLoader.disposed, false); p.parsers[0].complete(); assert.equal(await result, true);
  assert.equal(p.editor.text, 'SECOND'); assert.equal(p.session.loadedContent, 'SECOND'); assert.equal(p.session.isDirty(), false);
  assert.equal(p.oldLoader.disposed, true); assert.equal(p.parsers[0].loader.disposed, false);
  assert.equal(p.adapter.loadOrchestrator, originalLoader); assert.equal(originalExporter.loader, originalLoader);
  assert.equal(p.adapter.loadOrchestrator.loader, p.parsers[0].loader);
  assert.deepEqual(p.resets, ['FIRST']);
});

test('typing during asynchronous parse refuses at final native commit and preserves dirty bytes/baseline/old lazy loader', async () => {
  const p = pipeline(), oldMaps = p.adapter.loadOrchestrator.chunkToBlocks;
  const result = p.update('SECOND'); await tick(); p.edit('UNSAVED'); p.parsers[0].complete();
  assert.equal(await result, false); assert.deepEqual(p.commits, []); assert.equal(p.editor.text, 'UNSAVED');
  assert.equal(p.session.loadedContent, 'FIRST'); assert.equal(p.session.editRevision, 1); assert.equal(p.session.savedRevision, 0);
  assert.equal(p.oldLoader.disposed, false); assert.equal(p.adapter.loadOrchestrator.chunkToBlocks, oldMaps);
  assert.equal(p.parsers[0].loader.disposed, true);
  assert.deepEqual(p.resets, []);
});

test('new conditional request invalidates older parse without changing baseline; newest request can commit', async () => {
  const p = pipeline(), first = p.update('OLDER'); await tick();
  const second = p.update('NEWEST'); p.parsers[0].complete(); assert.equal(await first, false); await tick();
  assert.equal(p.editor.text, 'FIRST'); assert.equal(p.oldLoader.disposed, false); p.parsers[1].complete();
  assert.equal(await second, true); assert.deepEqual(p.commits, ['NEWEST']); assert.equal(p.session.loadedContent, 'NEWEST');
});

test('programmatic content changes, expired deadline, disposed loader and missing atomic API all refuse safely', async () => {
  for (const mutate of [p => p.edit('PROGRAM', 'program'), p => { p.clock.now += 1001; }, p => p.adapter.loadOrchestrator.dispose()]) {
    const p = pipeline(), result = p.update('SECOND'); await tick(); mutate(p); p.parsers[0].complete();
    assert.equal(await result, false); assert.equal(p.session.loadedContent, 'FIRST'); assert.equal(p.commits.length, 0);
  }
  const p = pipeline(); delete p.session.adapter.loadIfClean; assert.equal(await p.update('SECOND'), false); assert.equal(p.parsers.length, 0);
  assert.equal(await p.session.updateContentIfClean('FIRST', 'SECOND'), false);
});

test('legacy native load and close invalidate pending conditional parse; old update behavior remains available', async () => {
  const p = pipeline(), conditional = p.update('SECOND'); await tick();
  const native = p.session.load('NATIVE'); p.parsers[0].complete(); assert.equal(await conditional, false); await tick();
  p.parsers[1].complete(); await native; assert.equal(p.editor.text, 'NATIVE');
  const q = pipeline(), update = q.update('SECOND'); await tick(); const closed = q.session.close(); q.parsers[0].complete();
  assert.equal(await update, false); await closed; assert.equal(q.editor.text, 'FIRST'); assert.equal(q.commits.length, 0);
});

test('a native save started during conditional parse refuses the reload without resetting pending edits or baseline', async () => {
  const p = pipeline(), result = p.update('SECOND'); await tick();
  const saved = p.session.save(true); p.parsers[0].complete(); assert.equal(await result, false); await saved;
  assert.equal(p.editor.text, 'FIRST'); assert.equal(p.session.loadedContent, 'FIRST'); assert.equal(p.session.generation, 0);
  assert.equal(p.oldLoader.disposed, false);
});

test('parser error and unexpected expected content leave original loader/session unmodified', async () => {
  const p = pipeline(), result = p.update('SECOND'); await tick(); p.parsers[0].reject(Error('synthetic parser failure'));
  await assert.rejects(result, /synthetic parser/); assert.equal(p.oldLoader.disposed, false); assert.equal(p.session.loadedContent, 'FIRST');
  const q = pipeline(); q.editor.text = 'OTHER'; assert.equal(await q.update('SECOND'), false); assert.equal(q.parsers.length, 0);
  assert.equal(await q.update('x'.repeat(1048577)), false);
});

test('actual MarkdownEditor hook mounts, reads only its opened URL, and uses atomic ref rather than old updateContent', async () => {
  const calls = [], api = { isDirty: async () => false, getContent: async () => 'FIRST',
    updateContent: () => { throw Error('unsafe legacy API called'); }, updateContentIfClean: async (...args) => { calls.push(args); return true; } };
  const m = mount({ api }); assert.equal(m.output.type, 'NativeMarkdownPreview'); assert.equal(m.output.props.readOnly, false);
  assert.ok(m.statuses.includes('mounted')); m.emit(); await m.flush();
  assert.deepEqual(m.reads, [{ path: '/workspace/report.md', format: 'text' }]); assert.equal(calls[0][0], 'FIRST'); assert.equal(calls[0][1], 'SECOND');
  assert.ok(Number.isSafeInteger(calls[0][2])); assert.ok(m.statuses.includes('reloaded'));
});

test('native watch and updatedAt changes for Pi artifacts require the same atomic commit and native size probe', async () => {
  for (const trigger of [m => m.watch(), m => { m.env.artifact = { ...m.env.artifact, updatedAt: 2 }; m.render(); }]) {
    const calls = [], api = { isDirty: async () => false, getContent: async () => 'FIRST',
      updateContent() { throw Error('native watch must not bypass atomic commit'); },
      updateContentIfClean: async (expected, next) => { calls.push([expected, next]); return true; } };
    const m = mount({ api }); m.env.artifact = { ...m.env.artifact, updatedAt: 1 }; m.render();
    trigger(m); await m.flushNative(); await m.flush();
    assert.deepEqual(calls, [['FIRST', 'SECOND']]);
    assert.deepEqual(m.probes, ['/workspace/report.md', '/workspace/report.md']);
    assert.ok(m.statuses.includes('reloaded'));
    m.unmount();
  }
  for (const [dirty, probe, reason] of [[true, () => 6, 'dirty-skipped'], [false, () => undefined, 'size-skipped']]) {
    const api = { isDirty: async () => dirty, getContent: async () => 'FIRST',
      updateContent() { throw Error('native watch must not bypass atomic commit'); },
      updateContentIfClean() { throw Error('unsafe candidate was accepted'); } };
    const m = mount({ api, probe }); m.watch(); await m.flushNative(); await m.flush();
    assert.deepEqual(m.reads, []); assert.ok(m.statuses.includes(reason)); m.unmount();
  }
});

test('ordinary WorkBuddy artifact retains original native watcher and ignores Pi file events', async () => {
  const updates = [], api = { updateContent: async next => updates.push(next) };
  const artifact = { id: 'ordinary-native-id', sessionId: 'native-session', url: '/workspace/report.md' };
  const m = mount({ api, contextValues: { artifact } });
  m.emit(); await m.flush(); assert.deepEqual(m.reads, []);
  m.watch(); await m.flushNative(); await m.flush();
  assert.deepEqual(updates, ['SECOND']); m.unmount();
});

test('actual MarkdownEditor to native Host ref to authenticated guest to atomic session chain acknowledges the committed content', async () => {
  const p = pipeline(); p.clock.now = Date.now(); const b = bridge(p), m = mount({ api: b.ref.current });
  try {
    m.emit(); await m.flush(); assert.equal(p.parsers.length, 1); assert.equal(p.editor.text, 'FIRST');
    assert.ok(!m.statuses.includes('reloaded')); p.parsers[0].complete(); for (let i = 0; i < 10; i++) await tick();
    assert.equal(p.editor.text, 'SECOND'); assert.equal(b.latestContent.current, 'SECOND'); assert.ok(m.statuses.includes('reloaded'));
    const request = b.sent.find(value => value.direction === 'host-to-guest' && value.data.type === 'updateContentIfClean').data;
    assert.equal(request.expected, 'FIRST'); assert.equal(request.content, 'SECOND'); assert.ok(Number.isSafeInteger(request.deadline));
    const ack = b.sent.find(value => value.direction === 'guest-to-host' && value.data.type === 'response' && value.data.requestId === request.requestId).data;
    assert.equal(ack.ok, true); assert.equal(ack.value, true);
  } finally { m.unmount(); b.close(); }
});

test('native in-process core imperative ref exposes the same atomic method and receives the actual MarkdownEditor fallback route', async () => {
  const p = pipeline(); p.clock.now = Date.now(); const ref = coreRef(p), m = mount({ api: ref.current, contextValues: { resolveMarkdownGuestUrl: undefined } });
  try {
    assert.equal(m.output.type, 'NativeMarkdownEditorCore'); m.emit(); await m.flush();
    assert.equal(p.parsers.length, 1); p.parsers[0].complete(); for (let i = 0; i < 10; i++) await tick();
    assert.equal(p.editor.text, 'SECOND'); assert.ok(m.statuses.includes('reloaded'));
    assert.match(fragment(3).useMarkdownDocument, /updateContentIfClean:\(0,\$.useCallback\)\(async\(expected,next,deadline\)=>P.current\?\.updateContentIfClean\(expected,next,deadline\)/);
  } finally { m.unmount(); }
});

test('authenticated new guest request rejects forged source/origin ACKs and preserves edits made during parse', async () => {
  const p = pipeline(); p.clock.now = Date.now(); const b = bridge(p);
  try {
    b.guest.handleMessage({ source: {}, data: { source: 'workbuddy-markdown-host', type: 'updateContentIfClean', expected: 'FIRST', content: 'BAD', deadline: p.clock.now + 1000, requestId: 999 } });
    assert.equal(p.parsers.length, 0);
    let settled = false; const request = b.ref.current.updateContentIfClean('FIRST', 'SECOND', p.clock.now + 1000).then(value => { settled = true; return value; });
    await tick(); const packet = b.sent.find(value => value.direction === 'host-to-guest').data;
    const forged = { source: 'workbuddy-markdown-guest', type: 'response', requestId: packet.requestId, ok: true, value: true };
    b.host.handleMessage({ source: b.frame, origin: 'https://attacker.test', data: forged });
    b.host.handleMessage({ source: {}, origin: 'https://guest.test', data: forged }); await tick(); assert.equal(settled, false);
    p.edit('UNSAVED'); p.parsers[0].complete(); assert.equal(await request, false);
    assert.equal(p.editor.text, 'UNSAVED'); assert.equal(b.latestContent.current, 'FIRST'); assert.equal(p.session.isDirty(), true);
  } finally { b.close(); }
});

test('unknown/missing size, oversized event/probe/text, remote paths and unknown atomic capability never update', async () => {
  const good = { isDirty: async () => false, getContent: async () => 'FIRST', updateContentIfClean: async () => { throw Error('must not update'); } };
  for (const size of [null, undefined, -1, 1.5, 1048577]) {
    const m = mount({ api: good }); m.emit({ files: [{ path: '/workspace/report.md', size }] }); await m.flush();
    assert.equal(m.reads.length, 0); assert.ok(m.statuses.includes('size-skipped'));
  }
  for (const options of [{ probe: () => 1048577 }, { probe: () => undefined }, { read: () => 'x'.repeat(1048577) }, { read: () => '中'.repeat(400000) }]) {
    const m = mount({ api: good, ...options }); m.emit(); await m.flush(); assert.ok(m.statuses.includes('size-skipped'));
  }
  const missing = mount({ api: { ...good, updateContentIfClean: undefined } }); missing.emit(); await missing.flush();
  assert.equal(missing.reads.length, 0); assert.ok(missing.statuses.includes('ref-skipped'));
  const remote = mount({ api: good, contextValues: { artifact: { url: 'https://example.test/report.md', sessionId: 'a' } } });
  remote.emit(); await remote.flush(); assert.equal(remote.reads.length, 0);
});

test('every entry guard emits event then a fixed non-content reason rather than silently ignoring the event', () => {
  const api = { isDirty: async () => false, getContent: async () => 'FIRST', updateContentIfClean: async () => true };
  for (const [values, reason] of [
    [{ environmentType: 'cloud' }, 'nonlocal-skipped'], [{ extension: 'txt' }, 'extension-skipped'],
    [{ artifact: { url: '/workspace/report.md', id: 'pi-file-0123456789abcdef01234567' } }, 'session-skipped'], [{ content: undefined }, 'content-skipped'],
    [{ readFile: undefined }, 'reader-skipped'], [{ probeLocalFileSize: undefined }, 'probe-skipped'],
    [{ artifact: { url: 'agent://session/report.md', id: 'pi-file-0123456789abcdef01234567', sessionId: 'session-a' } }, 'url-skipped'],
  ]) {
    const m = mount({ api, contextValues: values }); m.emit(); assert.deepEqual(m.statuses, ['mounted', 'event', reason]);
    assert.equal(m.reads.length, 0); m.unmount();
  }
  const missing = mount({ api: {} }); missing.emit(); assert.deepEqual(missing.statuses, ['mounted', 'event', 'matched', 'ref-skipped']); missing.unmount();
});

test('dirty/unknown editor and changed content never update; artifact/session/ref changes cancel pending reads', async () => {
  for (const dirty of [true, undefined, 'false']) {
    const m = mount({ api: { isDirty: async () => dirty, getContent: async () => 'FIRST', updateContentIfClean: async () => true } });
    m.emit(); await m.flush(); assert.equal(m.reads.length, 0); assert.ok(m.statuses.includes(dirty === true ? 'dirty-skipped' : 'unknown-skipped'));
  }
  for (const change of [m => { m.env.artifact = { ...m.env.artifact, url: '/workspace/other.md' }; },
    m => { m.env.artifact = { ...m.env.artifact, sessionId: 'session-b' }; }, m => { m.env.content = 'USER'; },
    m => { m.output.props.ref.current = {}; }]) {
    let resolveRead, updates = 0; const pending = new Promise(resolve => { resolveRead = resolve; });
    const m = mount({ read: () => pending, api: { isDirty: async () => false, getContent: async () => 'FIRST', updateContentIfClean: async () => { updates++; return true; } } });
    m.emit(); await m.flush(); change(m); if (m.env.content !== 'FIRST' || m.env.artifact.url !== '/workspace/report.md' || m.env.artifact.sessionId !== 'session-a') m.render();
    resolveRead('SECOND'); await tick(); await tick(); assert.equal(updates, 0); assert.ok(m.statuses.includes('stale-skipped'));
  }
  let exports = 0, updates = 0;
  const m = mount({ api: { isDirty: async () => false, getContent: async () => exports++ === 0 ? 'FIRST' : 'USER', updateContentIfClean: async () => { updates++; return true; } } });
  m.emit(); await m.flush(); assert.equal(updates, 0); assert.ok(m.statuses.includes('stale-skipped'));
});

test('read errors, timeouts, path mismatch, event replacement and cleanup remain bounded without diagnostics containing content', async () => {
  let updates = 0;
  const api = { isDirty: async () => false, getContent: async () => 'FIRST', updateContentIfClean: async () => { updates++; return true; } };
  const fail = mount({ api, read: () => { throw Error('sensitive content is never in status'); } }); fail.emit(); await fail.flush(); assert.ok(fail.statuses.includes('read-failed'));
  const timeout = mount({ api, read: () => new Promise(() => {}) }); timeout.emit(); await timeout.flush(); await timeout.timeouts(); assert.ok(timeout.statuses.includes('read-failed'));
  const m = mount({ api }); m.emit({ files: [{ path: '/other/file.md', size: 6 }] }); await m.flush(); assert.equal(m.reads.length, 0);
  m.emit(); m.emit(); await m.flush(); assert.equal(m.reads.length, 1); assert.equal(updates, 1);
  m.emit(); m.unmount(); await m.flush(); assert.equal(m.listenerCount(), 0); assert.equal(m.reads.length, 1);
  const allowed = new Set(['mounted', 'event', 'matched', 'dirty-skipped', 'unknown-skipped', 'stale-skipped', 'reloaded', 'read-failed', 'size-skipped',
    'nonlocal-skipped', 'extension-skipped', 'session-skipped', 'content-skipped', 'reader-skipped', 'probe-skipped', 'url-skipped', 'ref-skipped']);
  for (const reason of [...m.statuses, ...fail.statuses, ...timeout.statuses]) assert.ok(allowed.has(reason));
});

test('a newer event fences an older read; a size change while reading skips the snapshot', async () => {
  const reads = [], updates = [], api = { isDirty: async () => false, getContent: async () => 'FIRST', updateContentIfClean: async (_, next) => { updates.push(next); return true; } };
  const m = mount({ api, read: () => new Promise(resolve => reads.push(resolve)) });
  m.emit(); await m.flush(); m.emit(); await m.flush(); assert.equal(reads.length, 2);
  reads[1]('NEWEST'); await tick(); await tick(); reads[0]('OLDER'); for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual(updates, ['NEWEST']); assert.ok(m.statuses.includes('stale-skipped'));
  let probes = 0; const changed = mount({ api, probe: () => probes++ === 0 ? 6 : 7 }); changed.emit(); await changed.flush();
  assert.ok(changed.statuses.includes('stale-skipped')); assert.deepEqual(updates, ['NEWEST']);
});

test('full pinned native members parse, patch strictly once, preserve original source handlers and reject dependency drift', { skip: !process.env.NATIVE_PREVIEW_5111_TEST_ASAR }, () => {
  const archive = inspectAsar(process.env.NATIVE_PREVIEW_5111_TEST_ASAR), applied = applyNativeArtifactPreviewPatch(archive);
  for (const member of fixture.members) {
    const original = archive.read(member.member); assert.equal(hash(original), member.sha256);
    for (const slice of member.slices) assert.deepEqual(original.subarray(slice.start, slice.end), Buffer.from(slice.source));
  }
  assert.equal(applied.patches.length, 5);
  for (const patch of applied.patches) {
    const pin = NATIVE_ARTIFACT_PREVIEW_PINS.find(value => value.member === patch.member);
    assert.equal(hash(patch.bytes), pin.patchedSHA256); assert.equal(patch.metadata.nonatomicFallback, false);
    const parse = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: patch.bytes }); assert.equal(parse.status, 0, parse.stderr.toString());
    assert.throws(() => patchNativeArtifactPreviewBytes(patch.member, patch.bytes), /pinned original/);
    const damaged = Buffer.from(archive.read(patch.member)); damaged[0] ^= 1;
    assert.throws(() => patchNativeArtifactPreviewBytes(patch.member, damaged), /pinned original/);
  }
  assert.throws(() => applyNativeArtifactPreviewPatch({ read: () => Buffer.from('drift') }), /dependency differs/);
  const guest = applied.patches.find(value => value.member.includes('/guest-')).bytes.toString();
  assert.ok(guest.indexOf('e.source!==window.parent') < guest.indexOf('case`updateContentIfClean`'));
  assert.ok(guest.includes('case`updateContent`:Promise.resolve(t.onUpdateContent(e.content))'));
});
