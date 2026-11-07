import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

export const nativeDiffFixture = JSON.parse(fs.readFileSync(new URL('./native-diff-592.source.json', import.meta.url)));
const sha = value => createHash('sha256').update(value).digest('hex');
const source = name => {
  const slice = nativeDiffFixture.slices.find(value => value.name === name);
  if (!slice || sha(slice.source) !== slice.sha256) throw Error('Native Diff slice pin differs: ' + name);
  return slice.source;
};

/** Inert original-source replay: no application, account, model or filesystem reads. */
export function createNativeDiffReplay() {
  const context = vm.createContext({ console, Set, Map, WeakMap, Date,
    e: initialize => { let done = false; return () => { if (!done) { done = true; initialize(); } }; },
    b9t: new WeakMap(), mZ: { windowStartAt: 0, calls: 0, hits: 0 }, pZ: 'native-resource', x9t: [],
    il() {}, scheduleChangeArtifactsDiagFlush() {}, dl: value => value,
    hl: initialize => { let state; const set = patch => { state = { ...state, ...patch }; }; const get = () => state; state = initialize(set, get); return { getState: get }; },
  });
  const library = nativeDiffFixture.library.source;
  if (sha(library) !== nativeDiffFixture.library.memberSHA256 || !library.startsWith('import{n as e}from"./rolldown-runtime-BJCASTsb.js";')) throw Error('Native Diff library pin differs');
  vm.runInContext(library.slice(library.indexOf(';') + 1, library.lastIndexOf('export{')) + ';u();var Ct=parsePatch,Tt=applyPatch;', context);
  for (const slice of nativeDiffFixture.slices) if (slice.source.startsWith('function ')) vm.runInContext(source(slice.name), context);
  return {
    project(manifests, sessionId = 'native-session') { return context.toLegacyConversationChangeArtifacts(manifests, sessionId); },
    cachedSides(content, diff, changeType = 'modified') { return context.resolveCachedDiffSides(content, diff, changeType); },
    currentSides(content, diff) { return context.diffSidesFromUnifiedDiff(content, diff); },
    mergeDetail(manifests, detailRef, detail) {
      const store = context.createConversationResourcesStore('native-session'); store.getState().setResources({ changes: manifests });
      store.getState().setChangeDetail(detailRef, detail); return store.getState().changes;
    },
    async view(artifact, options = {}) {
      const cells = [], effects = []; let cursor = 0, pending = false, result;
      const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
      const hooks = {
        useRef(value) { const i = cursor++; return cells[i] ??= { current: value }; },
        useState(value) { const i = cursor++; cells[i] ??= { value }; return [cells[i].value, next => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next; pending = true; }]; },
        useCallback(fn, deps) { const i = cursor++, old = cells[i]; if (old && same(old.deps, deps)) return old.value; cells[i] = { deps, value: fn }; return fn; },
        useMemo(fn, deps) { const i = cursor++, old = cells[i]; if (old && same(old.deps, deps)) return old.value; cells[i] = { deps, value: fn() }; return cells[i].value; },
        useDeferredValue(value) { cursor++; return value; },
        useEffect(fn, deps) { const i = cursor++, old = cells[i]; if (old && same(old.deps, deps)) return; cells[i] = { deps }; effects.push(fn); },
      };
      const jsx = (type, props) => ({ type, props });
      const viewerContext = vm.createContext({ ...context, cl: { ...hooks, Suspense: 'Suspense' }, tl: hooks, ll: { jsx, jsxs: jsx }, ze: () => value => value,
        mn: value => value.split('/').pop(), or: 'NativeOversizePlaceholder', dl: 'NativeDiffEditor', Fe: 'Boundary', ChunkLoadErrorFallback: 'Fallback' });
      for (const slice of nativeDiffFixture.slices) if (slice.member === 'renderer/assets/src-C0qgplVo.js' && slice.source.startsWith('function ')) vm.runInContext(source(slice.name), viewerContext);
      const Viewer = vm.runInContext(`(${source('FileChangesArtifactViewer')})`, viewerContext);
      const render = () => { cursor = 0; pending = false; result = Viewer({ artifact, readFile: options.readFile ?? (options.currentText === undefined ? undefined : async () => options.currentText), currentTheme: 'dark' }); for (const effect of effects.splice(0)) effect(); };
      render();
      for (let i = 0; i < 8; i++) { await new Promise(resolve => setImmediate(resolve)); if (pending) render(); }
      return result;
    },
  };
}

export function findNativeDiffView(element, type = 'NativeDiffEditor') {
  if (element?.type === type) return element;
  for (const child of Array.isArray(element?.props?.children) ? element.props.children : [element?.props?.children]) {
    if (child && typeof child === 'object') { const found = findNativeDiffView(child, type); if (found) return found; }
  }
}
