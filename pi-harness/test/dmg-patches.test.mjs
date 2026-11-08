import test from 'node:test';
import assert from 'node:assert/strict';
import { patchMembers, removeEngine, WORKBUDDY_VERSION, ORIGINAL_ASAR_SHA256, OFFICIAL_BRIDGE_CORE_PREFIX, officialBridgeMount, nativeDisabled, STDIO_COMMAND_REPLACEMENT, STDIO_PATH_REPLACEMENT } from '../package-dmg/patches.mjs';
import { inspectAsar } from '../package-dmg/asar.mjs';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import path from 'node:path';

test('engine removal preserves official metadata and host safety/search helpers', () => {
  for (const name of ['cli/bin/codebuddy', 'cli/dist/codebuddy-lite-wb.mjs', 'cli/node_modules/x', 'node_modules/@genie/agent-harness/cli/a.js']) assert.equal(removeEngine(name), true);
  for (const name of ['cli/product.json', 'cli/package.json', 'cli/vendor/sandbox/a', 'cli/vendor/ripgrep/rg', 'main/server.js', 'node_modules/better-sqlite3/a.node']) assert.equal(removeEngine(name), false);
});

const installedOriginal = process.env.WORKBUDDY_TEST_SOURCE_ASAR ?? '/Applications/WorkBuddy.app/Contents/Resources/app.asar';
const hasOriginal = fs.existsSync(installedOriginal) && JSON.parse(inspectAsar(installedOriginal).read('package.json')).version === WORKBUDDY_VERSION;
test('exact original 5.11.1 patches isolate authentication and block native execution, startup and updater paths', { skip: hasOriginal ? false : 'The pinned WorkBuddy 5.11.1 ASAR is unavailable' }, async () => {
  const filename = installedOriginal;
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  assert.equal(hash.digest('hex'), ORIGINAL_ASAR_SHA256);
  const source = inspectAsar(filename), result = patchMembers(source, Buffer.from('/* candidate entry */'));
  const pkg = JSON.parse(result.replacements.get('package.json'));
  assert.equal(result.replacements.size, 8);
  assert.equal(pkg.main, 'main/pi-entry.cjs');
  assert.equal(pkg.version, WORKBUDDY_VERSION);
  assert.equal(pkg.dependencies['@genie/agent-harness'], undefined);
  assert.equal([...result.replacements.keys()].some(name => name.startsWith('renderer/')), false);
  const auth = result.replacements.get('main/file-authentication-storage.js').toString();
  assert.ok(auth.includes('async migrateLegacySession(){return;')); assert.ok(auth.includes('workbuddy-desktop-pi.info'));
  const server = result.replacements.get('main/server.js').toString();
  assert.ok(server.includes('let Ae=0,H=D.n()'));
  assert.ok(server.includes('ct={read:async t=>e.configService.get(t),write:async(t,n)=>e.configService.set(t,n)}'));
  assert.ok(!server.includes('rt.getClient().then(()=>{M.info(`[BootstrapServer] Harness connected'));
  assert.ok(!server.includes('afterReclaimOrphanAcpKickoff'));
  assert.ok(server.includes(STDIO_COMMAND_REPLACEMENT));
  assert.ok(server.includes(STDIO_PATH_REPLACEMENT));
  for (const entry of ['async initializeInternal(e){', 'function resolveWorkbuddyAppServerCodeCliPath(e){', 'function resolveCLIPath(e={}){', 'function createResolveLocalConnectionWorkerCommandPath(e){return()=>{', 'function loadHarnessLibrary(){']) {
    assert.ok(server.includes(entry + nativeDisabled), entry);
  }
  assert.ok(result.replacements.get('main/node.js').toString().includes('function spawnWorker(e){' + nativeDisabled));
  assert.ok(result.replacements.get('main/sidecar-manager.js').toString().includes('function resolveCLIPath(e={}){' + nativeDisabled));
  assert.equal(server.split(OFFICIAL_BRIDGE_CORE_PREFIX + officialBridgeMount).length - 1, 1);
  const bootstrap = result.replacements.get('main/daemon-bootstrap.js').toString();
  assert.equal(bootstrap.split('designFeatureKey:Dl,documentService:P?.documentService,').length - 1, 1);
  assert.equal(result.replacements.has('cli/product.json'), false);
  assert.ok(result.replacements.get('main/main-bootstrap.js').toString().includes('PI_CUSTOM_BUILD_UPDATES_DISABLED'));
  assert.ok(result.replacements.get('main/index.js').toString().includes('async function tryEarlySilentStartupUpdate(e){return false;'));
  for (const [name, bytes] of result.replacements) if (name.endsWith('.js')) {
    assert.doesNotThrow(() => new vm.Script(bytes.toString('utf8'), { filename: name }), name);
  }
});

test('official bridge mount is limited to the isolated build and receives authoritative daemon services', async () => {
  const calls = [], nativeCalls = [], authoritative = { authenticationManager: {}, productManager: {}, restOperations: {}, configService: {}, mcpManager: {}, connectorService: {} };
  const adapters = { documentService: {} };
  const env = { WORKBUDDY_RESOURCES_PATH: '/candidate/Resources', WORKBUDDY_PI_MODEL_BRIDGE_DIR: '/private/bridge' };
  const invoke = () => vm.runInNewContext(officialBridgeMount, { process: { env }, e: authoritative, o: adapters, require: name => {
    if (name === 'node:path') return path;
    if (name === '/candidate/Resources/pi-harness/src/native-mcp-service.cjs') return { createNativeMcpService(options) { nativeCalls.push(options); return 'fixture-native-service'; } };
    assert.equal(name, '/candidate/Resources/pi-harness/src/official-model-bridge.cjs');
    return { installOfficialModelBridge: options => { calls.push(options); return Promise.resolve(); } };
  } });
  invoke(); assert.equal(calls.length, 0);
  env.WORKBUDDY_PI_OFFICIAL_BUILD = '1'; invoke(); await Promise.resolve();
  assert.equal(calls.length, 1);
  for (const key of ['authenticationManager', 'productManager', 'restOperations', 'configService']) assert.equal(calls[0][key], authoritative[key]);
  assert.equal(calls[0].documentService, adapters.documentService);
  assert.equal(calls[0].bridgeDir, '/private/bridge');
  assert.equal(calls[0].nativeMcp, 'fixture-native-service');
  for (const key of ['authenticationManager', 'mcpManager', 'connectorService']) assert.equal(nativeCalls[0][key], authoritative[key]);
  assert.equal(nativeCalls[0].stdioNodeCommand, '/candidate/Resources/PiEngine/runtime/node');
});

test('unexpected source fails before generating a speculative patch', () => {
  assert.throws(() => patchMembers({ read: () => Buffer.from('{}') }, Buffer.from('entry')), /Unsupported package/);
  assert.throws(() => patchMembers({ read: () => Buffer.from(JSON.stringify({ version: '5.9.2', main: 'main/index.js' })) }, Buffer.from('entry')), /original WorkBuddy 5\.11\.1/);
  assert.throws(() => patchMembers({ read: () => Buffer.from(JSON.stringify({ version: WORKBUDDY_VERSION, main: 'main/pi-entry.cjs' })) }, Buffer.from('entry')), /original WorkBuddy 5\.11\.1/);
});

test('the authenticated bridge anchor rejects absent and ambiguous daemon startup hooks', () => {
  for (const source of ['', OFFICIAL_BRIDGE_CORE_PREFIX.repeat(2)]) {
    const read = name => {
      if (name === 'package.json') return Buffer.from(JSON.stringify({ version: WORKBUDDY_VERSION, main: 'main/index.js' }));
      assert.equal(name, 'main/server.js');
      return Buffer.from(source);
    };
    assert.throws(() => patchMembers({ read }, Buffer.from('entry')), /Unrecognized or ambiguous WorkBuddy patch: official model bridge daemon core/);
  }
});

test('native MCP probe resolves Node and PATH to the pinned Pi runtime without an Electron fallback', () => {
  const context = vm.createContext({ process: { env: { WORKBUDDY_PI_OFFICIAL_BUILD: '1', WORKBUDDY_RESOURCES_PATH: '/candidate/Resources', PATH: '/system/bin' }, execPath: '/candidate/Electron' },
    R: { F: () => undefined, n: () => ({ Path: '/native/bin' }) }, require: name => { assert.equal(name, 'node:path'); return path; } });
  vm.runInContext(STDIO_COMMAND_REPLACEMENT + ';' + STDIO_PATH_REPLACEMENT, context);
  for (const name of ['node', ' NODE ', 'node.exe']) assert.equal(vm.runInContext(`resolveStdioRuntimeCommand(${JSON.stringify(name)})`, context), '/candidate/Resources/PiEngine/runtime/node');
  assert.equal(vm.runInContext('resolveStdioRuntimeCommand("npx")', context), 'npx');
  assert.equal(vm.runInContext('buildStdioRuntimePathEnv().PATH', context), '/candidate/Resources/PiEngine/runtime:/native/bin');
  context.process.env.WORKBUDDY_PI_OFFICIAL_BUILD = undefined;
  assert.equal(vm.runInContext('resolveStdioRuntimeCommand("node")', context), '/candidate/Electron');
  assert.equal(vm.runInContext('buildStdioRuntimePathEnv().PATH', context), '/native/bin');
});
