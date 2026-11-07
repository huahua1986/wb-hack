import fs from 'node:fs';
import vm from 'node:vm';

export const nativeArtifactEnvironmentFixture = JSON.parse(fs.readFileSync(new URL('./native-artifact-environment-592.source.json', import.meta.url)));
const source = name => {
  const slice = nativeArtifactEnvironmentFixture.slices.find(value => value.name === name);
  if (!slice) throw Error('Missing native artifact environment slice: ' + name);
  return slice.source;
};
const jsx = (type, props) => ({ type, props });
const hooks = { useMemo: fn => fn(), useCallback: fn => fn, useRef: value => ({ current: value }), useEffect() {} };

function findElement(element, type) {
  if (element?.type === type) return element;
  for (const child of Array.isArray(element?.props?.children) ? element.props.children : [element?.props?.children]) {
    if (child && typeof child === 'object') { const found = findElement(child, type); if (found) return found; }
  }
}

/** The actual project-page component supplies forceCloudEnvironment:true. */
export function replayNativeProjectDetailPanelOptions() {
  const context = vm.createContext({ Dr: () => ({ showDetailPanel: true }),
    useProjectConversationStore: () => ({ detailPanelWidth: 800, isPreviewFullscreen: false, handleSashMouseDown() {}, togglePreviewFullscreen() {} }),
    Bp: hooks, Vp: { jsx, jsxs: jsx, Fragment: 'Fragment' }, Gc: 'DetailPanelWrapper', CloudSidebarPanel: 'CloudSidebarPanel' });
  return findElement(vm.runInContext(`(${source('TaskChatDetailPanel')})`, context)({ canSaveArtifactToLibrary: false }), 'DetailPanelWrapper').props;
}

function createReplay(info, options) {
  const adapter = options.adapter ?? { environmentType: options.adapterEnvironment ?? 'local' };
  const state = { currentConversation: info, conversations: info ? [info] : [], artifacts: [] };
  const projectPlugin = options.projectSandbox === undefined ? undefined : { projectChat: { getSandboxId: () => options.projectSandbox } };
  const context = vm.createContext({
    H: hooks, ni: () => projectPlugin, jt: () => undefined, ri: () => ({ params: { projectId: options.routeProjectId } }), Ba: () => () => {},
    // These stand-ins cover unrelated panel memoization, terminal/browser UI,
    // plan actions and binary writing. The complete native function reads its
    // actual currentConversation input and decides every environment branch.
    useArtifactRuntimeBinding: () => ({}), createArtifactPlanActions: () => ({}),
    Et: () => false, writeArtifactBinaryFile() {}, P: value => ({ current: value }), pe: () => false,
    mt: () => ({}), ao() {}, kt: value => value, C: value => value, Dt() {}, Rt() {}, console,
  });
  for (const name of ['artifactPanelStateKeys', 'pickArtifactPanelState', 'reuseArtifactPanelState', 'bindArtifactFileAccess', 'resolveProjectUploadId', 'useStableArtifactPanelState', 'useStableStringArray', 'useConversationArtifactBinding']) {
    vm.runInContext(source(name), context);
  }
  context._i = context.reuseArtifactPanelState;
  const forceCloud = options.projectDetailPage ? replayNativeProjectDetailPanelOptions().forceCloudEnvironment : options.forceCloud === true;
  return { context, state, adapter, forceCloud };
}

/** Accepts the *actual* controller.info object emitted by renderer source.js. */
export function replayNativeArtifactBinding(info, options = {}) {
  const { context, state, adapter, forceCloud } = createReplay(info, options);
  return context.useConversationArtifactBinding(state, adapter, options.scopeKey ?? 'native-scope', options.input, forceCloud, options.homeContext);
}

/** Actual info-to-sidebar field projection; unrelated title/status renderers are inert. */
export function replayNativeSidebarConversation(info) {
  const context = vm.createContext({ Date, resolveSidebarDisplayTitle: value => value, mapConversationInfoToSidebarStatus: () => 'completed',
    mapIsUserDefinedTitle: value => value === 1 || value === 2 ? value : value === true ? 1 : undefined });
  vm.runInContext(source('mapConversationInfoToSidebar'), context);
  return context.mapConversationInfoToSidebar(info);
}

/** Real renderer controller.info -> original sidebar projection -> original host. */
export function replayNativeArtifactBindingFromInfo(info, options = {}) {
  return replayNativeArtifactBinding(replayNativeSidebarConversation(info), options);
}

/** Replays the production bridge's injected-host/conversation fallback choice. */
export function replayNativeArtifactBridge(info, options = {}) {
  const { context, state, adapter, forceCloud } = createReplay(info, options);
  const Ae = {}, Wt = {}, es = {}, Tn = {}, noArtifactActions = {}, contextMap = new Map([[Ae, options.artifactPanelContext], [Wt, state], [Tn, options.homeContext]]);
  Object.assign(context, { Ae, Wt, es, Tn, Jt: noArtifactActions, Gs: { ...hooks, useId: () => 'inert-react-id', useContext: key => contextMap.get(key) },
    _r: () => noArtifactActions, za: () => adapter, useArtifactInputBinding: () => options.input,
    Ks: { jsxs: jsx, jsx, Fragment: 'Fragment' }, EmbeddedBrowserSessionScope: 'EmbeddedBrowserSessionScope' });
  let result;
  vm.runInContext(source('ConversationArtifactPanelBridge'), context);
  context.ConversationArtifactPanelBridge({ children: host => { result = host; return host; }, injectedHost: options.injectedHost, forceCloudEnvironment: forceCloud });
  return result;
}

/** Replays the final DetailPanelContent promotion using original expressions. */
export function replayNativeFinalEnvironment(host, options = {}) {
  const b = options.projectDetailPage ? replayNativeProjectDetailPanelOptions().forceCloudEnvironment : options.forceCloud === true;
  const context = vm.createContext({ e: host, b });
  return vm.runInContext(`const rr=(${source('finalBinding_rr')}),sr=(${source('finalBinding_sr')});(${source('finalEnvironment')})`, context);
}
