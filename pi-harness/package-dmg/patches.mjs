export const WORKBUDDY_VERSION = '5.11.1';
export const ORIGINAL_ASAR_SHA256 = 'f0414d122ead12f3e997bb2e3d7811f35213fbd5b92063fab7361691b82253d6';
export const ORIGINAL_592_ASAR_SHA256 = '0b79c0358c129749bc3355f52bbae13f115577ab37c082a76dfdc54f66fd3f79';
export const LEGACY_ORIGINAL_ASAR_SHA256 = '1fc0a56ddec5437d4dc55a55ba1c028b291ab29cb17306500827015987424233';
export const ORIGINAL_RENDERER = Object.freeze({ files: 3872, sha256: 'b1483aef401475951a36df33ea5d74ccfeb389b6ddd75da84616de8df575df2c' });
export const REMOVED_ENGINE_TREES = ['cli/bin', 'cli/dist', 'cli/node_modules', 'node_modules/@genie/agent-harness'];
export const nativeDisabled = "throw Object.assign(Error('此 Pi 版本不含 CodeBuddy 执行器；请使用 Pi 会话。'),{code:'PI_ONLY_NATIVE_HARNESS_DISABLED'});";
export const OFFICIAL_BRIDGE_CORE_PREFIX = 'async function createWorkbuddyAppServerCoreServices({celljs:e,platform:t,runtimeManager:n,agentSettings:r,host:i,serverFetch:a,adapters:o,logger:s=console}){return Promise.resolve(e).then(e=>{let c=a;';
const OFFICE_RUNTIME_ADAPTER = 'adapters:{resolveBundledAsset:d.I,resolveChannelBranding:_.S,designFeatureKey:Dl,';
export const STDIO_COMMAND_SOURCE = 'function resolveStdioRuntimeCommand(e){let t=e.trim().toLowerCase();return t!==`node`&&t!==`node.exe`?e:R.F()??process.execPath}';
export const STDIO_PATH_SOURCE = 'function buildStdioRuntimePathEnv(){let e=R.n(),t=Object.keys(e).find(e=>e.toLowerCase()===`path`),n=t?e[t]:void 0;return t&&n?{PATH:n}:{}}';
export const STDIO_COMMAND_REPLACEMENT = "function resolveStdioRuntimeCommand(e){let t=e.trim().toLowerCase();return t!==`node`&&t!==`node.exe`?e:process.env.WORKBUDDY_PI_OFFICIAL_BUILD==='1'?require('node:path').join(process.env.WORKBUDDY_RESOURCES_PATH,'PiEngine','runtime','node'):R.F()??process.execPath}";
export const STDIO_PATH_REPLACEMENT = "function buildStdioRuntimePathEnv(){let e=R.n(),t=Object.keys(e).find(e=>e.toLowerCase()===`path`),n=t?e[t]:void 0;if(process.env.WORKBUDDY_PI_OFFICIAL_BUILD==='1')return {PATH:[require('node:path').join(process.env.WORKBUDDY_RESOURCES_PATH,'PiEngine','runtime'),n||process.env.PATH].filter(Boolean).join(require('node:path').delimiter)};return t&&n?{PATH:n}:{}}";
export const officialBridgeMount = "if(process.env.WORKBUDDY_PI_OFFICIAL_BUILD==='1'){require(require('node:path').join(process.env.WORKBUDDY_RESOURCES_PATH,'pi-harness','src','official-model-bridge.cjs')).installOfficialModelBridge({authenticationManager:e.authenticationManager,productManager:e.productManager,restOperations:e.restOperations,configService:e.configService,documentService:o?.documentService,nativeMcp:require(require('node:path').join(process.env.WORKBUDDY_RESOURCES_PATH,'pi-harness','src','native-mcp-service.cjs')).createNativeMcpService({mcpManager:e.mcpManager,connectorService:e.connectorService,authenticationManager:e.authenticationManager,stdioNodeCommand:require('node:path').join(process.env.WORKBUDDY_RESOURCES_PATH,'PiEngine','runtime','node')}),bridgeDir:process.env.WORKBUDDY_PI_MODEL_BRIDGE_DIR}).catch(()=>{e.logger?.warn?.('[PiOfficialBridge] initialization failed')})}";

const NATIVE_HARNESS_WARMUP = ',st=Date.now();rt.getClient().then(()=>{M.info(`[BootstrapServer] Harness connected elapsedMs=${Date.now()-st}`)}).catch(e=>{M.warn?.(`[BootstrapServer] Harness startup failed; session acquisition will retry lazily`,e)});';
const ORPHAN_ACP_RECLAIM = ',setImmediate(()=>{N.D({log:(e,t)=>M.warn?.(`[BootstrapServer] ${e}`,t)}).then(e=>{(e.signaled>0||e.forced>0)&&M.warn?.(`[BootstrapServer] reclaimed orphaned ACP workers from dead WorkBuddy instances`,{...e})},e=>{M.warn?.(`[BootstrapServer] orphaned ACP worker reclamation skipped`,{error:e instanceof Error?e.message:String(e)})})}),bootstrapProbe(`afterReclaimOrphanAcpKickoff`,`fire-and-forget`)';

function once(source, before, after, label) {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) throw Error('Unrecognized or ambiguous WorkBuddy patch: ' + label);
  return source.slice(0, at) + after + source.slice(at + before.length);
}

export function patchMembers(archive, bootstrap) {
  const replacements = new Map(), report = [];
  const edit = (filename, change) => {
    const before = archive.read(filename), after = Buffer.from(change(before.toString('utf8')));
    replacements.set(filename, after); report.push({ file: filename, beforeBytes: before.length, afterBytes: after.length });
  };
  edit('package.json', source => {
    const pkg = JSON.parse(source);
    if (pkg.version !== WORKBUDDY_VERSION || pkg.main !== 'main/index.js') throw Error(`Unsupported package entry: expected original WorkBuddy ${WORKBUDDY_VERSION}`);
    pkg.main = 'main/pi-entry.cjs';
    if (pkg.dependencies) delete pkg.dependencies['@genie/agent-harness'];
    return JSON.stringify(pkg, null, 2) + '\n';
  });
  edit('main/server.js', source => {
    source = once(source, OFFICIAL_BRIDGE_CORE_PREFIX, OFFICIAL_BRIDGE_CORE_PREFIX + officialBridgeMount, 'official model bridge daemon core');
    source = once(source, STDIO_COMMAND_SOURCE, STDIO_COMMAND_REPLACEMENT, 'MCP probe pinned Node');
    source = once(source, STDIO_PATH_SOURCE, STDIO_PATH_REPLACEMENT, 'MCP probe pinned Node PATH');
    source = once(source, 'async initializeInternal(e){', 'async initializeInternal(e){' + nativeDisabled, 'native session');
    for (const start of ['function resolveWorkbuddyAppServerCodeCliPath(e){', 'function resolveCLIPath(e={}){']) source = once(source, start, start + nativeDisabled, start);
    source = once(source, 'function createResolveLocalConnectionWorkerCommandPath(e){return()=>{', 'function createResolveLocalConnectionWorkerCommandPath(e){return()=>{' + nativeDisabled, 'ACP fallback');
    source = once(source, 'function loadHarnessLibrary(){return import(`@genie/agent-harness`)}', 'function loadHarnessLibrary(){' + nativeDisabled + '}', 'hidden harness SDK');
    source = once(source, 'ct=createHarnessSettings(()=>rt.getClient())', 'ct={read:async t=>e.configService.get(t),write:async(t,n)=>e.configService.set(t,n)}', 'settings without engine');
    source = once(source, 'let Ae=ke.size,H=D.n()', 'let Ae=0,H=D.n()', 'CLI prewarm');
    source = once(source, NATIVE_HARNESS_WARMUP, ';', 'native Harness startup warmup');
    // This native-only reaper scans ACP workers across WorkBuddy profiles.
    return once(source, ORPHAN_ACP_RECLAIM, '', 'unscoped orphan ACP reclamation');
  });
  // Both desktop and child daemons supply tencentDocsRuntime as P in bootstrapDaemon.
  edit('main/daemon-bootstrap.js', source => once(source, OFFICE_RUNTIME_ADAPTER,
    OFFICE_RUNTIME_ADAPTER + 'documentService:P?.documentService,', 'desktop Office runtime for Pi bridge'));
  edit('main/node.js', source => once(source, 'function spawnWorker(e){', 'function spawnWorker(e){' + nativeDisabled, 'native worker'));
  edit('main/sidecar-manager.js', source => once(source, 'function resolveCLIPath(e={}){', 'function resolveCLIPath(e={}){' + nativeDisabled, 'sidecar CLI'));
  edit('main/file-authentication-storage.js', source => {
    source = once(source, 'async getAuthSavePath(){let e=getWorkbuddyAuthenticationConfiguration()?.id??this.productManager.configuration.getValue()?.authentication?.id??`auth`;return s.join(this.filePathService.sharedDataPath,`auth`,`${e}.info`)}', 'async getAuthSavePath(){if(!process.env.WORKBUDDY_CONFIG_DIR)throw Error("Missing Pi build config directory");return s.join(process.env.WORKBUDDY_CONFIG_DIR,`auth`,`workbuddy-desktop-pi.info`)}', 'isolated official auth cache');
    return once(source, 'async migrateLegacySession(){', 'async migrateLegacySession(){return;', 'no stock credential import');
  });
  edit('main/main-bootstrap.js', source => once(source, 'function createDesktopUpdateService(e){', `function createDesktopUpdateService(e){return {check:async manual=>{if(manual)await electron.dialog.showMessageBox({type:'info',message:'Pi 测试版使用独立安装包升级',detail:'此版本停用了会覆盖 Pi 执行器的原版自动更新。'})},checkForceUpgrade:async()=>{},getState:async()=>({state:'idle',reason:'PI_CUSTOM_BUILD_UPDATES_DISABLED'}),quitAndInstall:async()=>{},getDmgLaunchPrompt:()=>({show:false}),runDmgPromptAction:async()=>{},downloadArchMismatchGuide:async()=>{},installArchMismatchGuide:async()=>{},start:async()=>{}};`, 'candidate updater'));
  edit('main/index.js', source => once(source, 'async function tryEarlySilentStartupUpdate(e){', 'async function tryEarlySilentStartupUpdate(e){return false;', 'early candidate updater'));
  return { replacements, additions: new Map([['main/pi-entry.cjs', bootstrap]]), report };
}

export function removeEngine(filename) { return REMOVED_ENGINE_TREES.some(root => filename === root || filename.startsWith(root + '/')); }
