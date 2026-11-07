import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

export const nativeExpertFixture = JSON.parse(fs.readFileSync(new URL('./native-expert-592.source.json', import.meta.url)));
const sha = value => createHash('sha256').update(value).digest('hex');
const source = name => {
  const slice = nativeExpertFixture.slices.find(value => value.name === name);
  if (!slice || sha(slice.source) !== slice.sha256) throw Error('Native Expert slice pin differs: ' + name);
  return slice.source;
};

/** Original producers/consumers only; caches, UI and all transports are inert. */
export function createNativeExpertReplay() {
  const context = vm.createContext({ Set, Map, WeakMap, Date, JSON, Number, String,
    console: { log() {}, warn() {}, error() {} },
    jDe: new WeakMap(), MDe: 'data:image/', NDe: /\/(?:expert-marketplace|experts)\/?$/,
    WorkbuddyAgentAdapterNext: { PENDING_EXPERT_SESSION_KEY: nativeExpertFixture.constants.pendingExpertKey },
  });
  for (const slice of nativeExpertFixture.slices) if (slice.kind === 'FunctionDeclaration') vm.runInContext(source(slice.name), context);
  vm.runInContext(source('runtimeIdentityPrefix'), context);
  vm.runInContext(source('clientRuntimeIdentityPrefix'), context);
  context.yc = context.isPersistedExpertSource; context.dc = context.attachExpertSourceToRuntimeIdentity;
  context.or = context.mapInputExpertSelection; context.st = context.looksLikeOfficialMarketExpertId;
  context.throwIfApiError = result => { if (result?.errorCode) throw Error(result.message ?? 'synthetic API error'); };
  const NativeLaunch = vm.runInContext(`(class {
    ${['getPendingExpert', 'getSelectedExpertForSession', 'readExpertRuntimeIdentityField', 'buildExpertRuntimeIdentity',
      'resolveLaunchConfig', 'buildDesiredConfigPatchFromLaunchConfig'].map(source).join('\n')}
  })`, context);
  const method = name => vm.runInContext(`(class { ${source(name)} })`, context);
  const launch = (params, state = {}) => {
    const adapter = new NativeLaunch();
    adapter.sessionLaunchConfig = new Map(state.sessionId ? [[state.sessionId, state.launchConfig ?? {}]] : []);
    adapter.selectedExpertBySession = new Map();
    if (state.pendingExpert) adapter.selectedExpertBySession.set(nativeExpertFixture.constants.pendingExpertKey, state.pendingExpert);
    if (state.sessionId && state.selectedExpert) adapter.selectedExpertBySession.set(state.sessionId, state.selectedExpert);
    // Canonical modes/permissions suffice for these identity projections. No
    // permission-changing behavior or runtime plugin code is executed.
    adapter.normalizeSceneMode = value => value;
    adapter.normalizeNonPlanPermissionMode = value => value;
    return { adapter, config: adapter.resolveLaunchConfig({ ...params, ...(state.sessionId ? { sessionId: state.sessionId } : {}) }) };
  };
  return {
    mapExpertInfo: (info, locale = 'zh') => context.mapExpertInfo(info, locale),
    inputSelection: expert => context.mapInputExpertSelection(expert),
    homeSelection: expert => context.mapHomeExpertSelection(expert),
    identityKey: expert => context.getExpertIdentityKey(expert),
    identityAliases: expert => context.getExpertIdentityAliases(expert),
    resolveSelected: options => context.resolveSelectedExpert(options),
    readRuntimeField: (identity, field) => context.readExpertV2Field(identity, field),
    fromSessionDetail: detail => context.expertSelectionFromDetail(detail),
    persistPatch: (id, options) => context.expertPatchFromPersistOptions(id, options),
    homeCreateParams(expert, options = {}) {
      const c = { blocks: [], interactionMode: 'craft', ...options, expert };
      const bindings = { c, b: options.title ?? 'Synthetic Expert Task', l: options.cwd ?? '/synthetic/workspace',
        x: false, S: options.sceneId, C: expert ? context.mapHomeExpertSelection(expert) : undefined,
        w: options.welcomeMode, T: options.sessionSettings, v: options.createIntent ?? {}, t: options.taskTarget === 'cloud', a: undefined };
      // Evaluate the unchanged complete Home create object; only unrelated
      // title/workspace/Buddy/project inputs are supplied as inert values.
      const createContext = vm.createContext(bindings);
      vm.runInContext(source('homeCreateTagsInit') + ';' + source('homeCreateExpertTags') + ';', createContext);
      return vm.runInContext(`(${source('homeCreateParamsObject')})`, createContext);
    },
    embedCreateParams(expert, options = {}) {
      const bindings = { e: options.conversationId, S: options.cwd ?? '/synthetic/workspace', h: options.title ?? 'Synthetic Expert Task',
        n: false, d: options.welcomeMode, f: undefined, r: undefined, s: options.mode ?? 'craft',
        a: { selections: {} }, p: expert, m: expert ? context.mapInputExpertSelection(expert) : undefined,
        u: options.permissionMode ?? 'bypassPermissions', v: [], mergeEmbedBuddyCreate: () => ({}) };
      return vm.runInContext(`(${source('embedCreateParamsObject')})`, vm.createContext(bindings));
    },
    legacyLaunchConfig(params, state) { return launch(params, state).config; },
    legacyDesiredConfig(params, state) { const { adapter, config } = launch(params, state); return adapter.buildDesiredConfigPatchFromLaunchConfig(config); },
    runtimeIdentity(expert) { return new NativeLaunch().buildExpertRuntimeIdentity(expert); },
    async bindOptions(input, options = {}) {
      const calls = [], modes = [], config = { mode: options.mode ?? 'code',
        setExpertId: async (expertId, values) => { calls.push({ expertId, options: values }); return {}; },
        setMode: async mode => { modes.push(mode); return {}; } };
      await context.bindExpertToConversation({ get: async () => ({ configManager: config }) }, 'synthetic-session', input, { commandSurface: 'core' });
      return { ...calls[0], modes };
    },
    async officialGetQuery(input) {
      const Native = method('baseExpertFacadeGet'), instance = new Native();
      instance.loadExpert = async request => ({ expert: request }); return instance.get(input);
    },
    async enterpriseQuery(input) {
      const Native = method('cloudLoadExpert'), instance = new Native(), calls = [];
      instance.resolveEnterpriseId = () => 'synthetic-enterprise'; instance._routePrefix = '/portal';
      instance._http = { post: async (path, body) => { calls.push({ path, body }); return { code: 0, data: { items: [{ expert_id: input.marketExpertId ?? input.expertId }] } }; } };
      instance.mapMarketItemToExpert = async item => item;
      await instance.loadExpert(input); return calls[0];
    },
    async readTextCall(filePath, options = {}) {
      const Native = method('adapterReadFile'), instance = new Native(), calls = [];
      instance.requireDaemonClient = () => ({ fileRead: async (...args) => { calls.push(args); return 'synthetic agent body'; } });
      const result = await instance.readFile(options.sessionId, filePath, 'text', { allowedDirs: options.allowedDirs ?? [] });
      return { result, args: calls[0] };
    },
    async sendGate(expert, options = {}) {
      const calls = [], cleared = [], run = vm.runInContext(`(async(D,R,x)=>{${source('sendCachedOrLocalExpertGate')}return {expert:D,prompt:Re};})`, context);
      const result = await run(expert, { activateExpertPlugin: async (...args) => { calls.push(args); return options.activationResult ?? { success: false, error: 'synthetic unavailable' }; },
        setSelectedExpertForSession: async () => {}, clearSelectedExpertForSession: async id => { cleared.push(id); } }, { id: 'synthetic-session' });
      return { ...result, activationCalls: calls, cleared };
    },
  };
}
