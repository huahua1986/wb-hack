import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const source = fs.readFileSync(new URL('../package-dmg/bootstrap.cjs', import.meta.url), 'utf8');
const nativeRequire = createRequire(import.meta.url);
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pi-dmg-boot-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], env = { WORKBUDDY_DEV_ENDPOINT_OVERRIDE: 'https://private.invalid', ACC_PRODUCT_CONFIG_V3: 'private fixture', CODEBUDDY_CODE_PATH: '/other/cbc', NODE_OPTIONS: '--invalid-fixture' };
  const start = (appPath = '/bundle/Contents/Resources/app.asar') => {
    const app = { getPath: name => { assert.ok(['appData', 'home'].includes(name)); return root; }, getVersion: () => '5.9.2', getAppPath: () => appPath, setPath: (name, value) => calls.push({ name, value }) };
    vm.runInNewContext(source, { process: { env, pid: process.pid }, require: name => {
      if (name === 'electron') return { app };
      if (name === './index.js') { calls.push('original-entry'); return {}; }
      if (name.endsWith('/branding.cjs')) return { installBranding: options => calls.push({ brandingPath: options.appAsarPath }) };
      if (name.endsWith('/electron-runtime.cjs')) return { install: options => calls.push({ install: structuredClone(options) }) };
      return nativeRequire(name);
    } });
  };
  return { root, calls, env, start, config: path.join(root, 'WorkBuddy-Pi-5.9.1/pi/pi-config.json') };
}

test('packaged bootstrap retains production login routing and uses independent candidate data', t => {
  const f = fixture(t); f.start();
  assert.equal(f.env.NODE_ENV, 'production'); assert.equal(f.env.WORKBUDDY_DEV_ENDPOINT_OVERRIDE, undefined);
  assert.equal(f.env.ACC_PRODUCT_CONFIG_V3, undefined); assert.equal(f.env.NODE_OPTIONS, undefined); assert.equal(f.env.CODEBUDDY_CODE_PATH, undefined);
  assert.equal(f.env.WORKBUDDY_CLI_PREWARM_POOL_SIZE, '0');
  assert.equal(f.env.WORKBUDDY_CONFIG_DIR, path.join(f.root, 'WorkBuddy-Pi-5.9.1/config'));
  const config = JSON.parse(fs.readFileSync(f.config));
  assert.equal(config.command, '/bundle/Contents/Resources/PiEngine/runtime/node');
  assert.equal(config.args[0], '/bundle/Contents/Resources/PiEngine/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
  assert.equal(config.provider, 'workbuddy-official'); assert.equal(config.model, 'hy4'); assert.equal(config.officialOnly, true);
  assert.equal(config.officialBridgeDir, path.join(f.root, 'WorkBuddy-Pi-5.9.1/pi/bridge'));
  assert.equal(f.env.WORKBUDDY_PI_MODEL_BRIDGE_DIR, config.officialBridgeDir); assert.equal(f.env.WORKBUDDY_PI_OFFICIAL_BUILD, '1');
  assert.equal(fs.statSync(config.officialBridgeDir).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(config.agentDir, 'models.json'))), { providers: {} });
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.agentDir, 'settings.json'))).defaultProvider, 'workbuddy-official');
  assert.deepEqual(config.tools, ['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls']);
  assert.equal(config.workspaceRoot, path.join(f.root, 'WorkBuddy'));
  assert.equal(config.approvalMode, 'auto');
  assert.equal(f.env.WORKBUDDY_APP_VERSION, '5.9.2');
  assert.equal(f.env.PATH.split(path.delimiter)[0], '/bundle/Contents/Resources/PiEngine/tools');
  assert.equal(f.calls.at(-2).install.exclusive, true); assert.equal(f.calls.at(-1), 'original-entry');
  assert.equal(f.calls.at(-2).install.nativeUi, true);
  assert.equal(f.calls[0].brandingPath, '/bundle/Contents/Resources/app.asar');
  assert.equal(fs.statSync(f.config).mode & 0o777, 0o600);
});

test('official-only migration privately backs up old direct models and preserves thread/account files', t => {
  const f = fixture(t); f.start(); const config = JSON.parse(fs.readFileSync(f.config));
  config.provider = 'my-intranet'; config.model = 'my-model'; config.officialOnly = false; config.command = '/stale/binary'; fs.writeFileSync(f.config, JSON.stringify(config));
  const originalConfig = fs.readFileSync(f.config);
  const modelFile = path.join(config.agentDir, 'models.json'), custom = '{"providers":{"my-intranet":{"baseUrl":"https://model.invalid"}}}'; fs.writeFileSync(modelFile, custom);
  const settings = path.join(config.agentDir, 'settings.json'), originalSettings = '{"defaultProvider":"my-intranet","defaultModel":"my-model"}'; fs.writeFileSync(settings, originalSettings);
  fs.writeFileSync(path.join(config.stateDir, 'threads.json'), '{"threads":["keep"]}');
  const auth = path.join(f.root, 'WorkBuddy-Pi-5.9.1/config/auth'); fs.mkdirSync(auth); fs.writeFileSync(path.join(auth, 'workbuddy-desktop-pi.info'), 'account-fixture');
  f.start('/moved/Contents/Resources/app.asar'); const moved = JSON.parse(fs.readFileSync(f.config));
  assert.equal(moved.command, '/moved/Contents/Resources/PiEngine/runtime/node'); assert.equal(moved.provider, 'workbuddy-official'); assert.equal(moved.model, 'hy4');
  assert.deepEqual(JSON.parse(fs.readFileSync(modelFile)), { providers: {} });
  const backups = path.join(f.root, 'WorkBuddy-Pi-5.9.1/pi/migration-backups'), saved = fs.readdirSync(backups);
  assert.equal(saved.length, 1); const backup = path.join(backups, saved[0]);
  assert.match(saved[0], /^configuration-0\.4\.2-/);
  assert.deepEqual(fs.readFileSync(path.join(backup, 'pi-config.json')), originalConfig);
  assert.equal(fs.readFileSync(path.join(backup, 'models.json'), 'utf8'), custom);
  assert.equal(fs.readFileSync(path.join(backup, 'settings.json'), 'utf8'), originalSettings);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
  for (const name of fs.readdirSync(backup)) assert.equal(fs.statSync(path.join(backup, name)).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(config.stateDir, 'threads.json'), 'utf8'), '{"threads":["keep"]}');
  assert.equal(fs.readFileSync(path.join(auth, 'workbuddy-desktop-pi.info'), 'utf8'), 'account-fixture');
  f.start('/moved/Contents/Resources/app.asar'); assert.equal(fs.readdirSync(backups).length, 1);
});

test('restart retains an official model selection while refreshing moved bundle paths', t => {
  const f = fixture(t); f.start(); const config = JSON.parse(fs.readFileSync(f.config));
  config.model = 'official-other'; config.tools = ['read']; fs.writeFileSync(f.config, JSON.stringify(config));
  config.approvalMode = 'manual'; config.workspaceRoot = path.join(f.root, 'custom-tasks'); fs.writeFileSync(f.config, JSON.stringify(config));
  f.start('/moved/Contents/Resources/app.asar'); const moved = JSON.parse(fs.readFileSync(f.config));
  assert.equal(moved.model, 'official-other'); assert.deepEqual(moved.tools, ['read']);
  assert.equal(moved.approvalMode, 'manual'); assert.equal(moved.workspaceRoot, config.workspaceRoot);
  assert.equal(JSON.parse(fs.readFileSync(path.join(moved.agentDir, 'settings.json'))).defaultModel, 'official-other');
});

test('linked model config and linked migration directory fail before changing private files', t => {
  const f = fixture(t); f.start(); const config = JSON.parse(fs.readFileSync(f.config));
  const modelFile = path.join(config.agentDir, 'models.json'), external = path.join(f.root, 'external.json'); fs.writeFileSync(external, '{"keep":true}');
  fs.unlinkSync(modelFile); fs.symlinkSync(external, modelFile); const before = fs.readFileSync(f.config);
  assert.throws(() => f.start(), /ordinary bounded file/); assert.deepEqual(fs.readFileSync(f.config), before);
  assert.equal(fs.readFileSync(external, 'utf8'), '{"keep":true}');
  fs.unlinkSync(modelFile); fs.writeFileSync(modelFile, '{}');
  const backups = path.join(f.root, 'WorkBuddy-Pi-5.9.1/pi/migration-backups'); fs.symlinkSync(f.root, backups);
  assert.throws(() => f.start(), /backup directory is not ordinary/); assert.deepEqual(fs.readFileSync(f.config), before);
});

test('candidate bootstrap refuses a linked candidate directory instead of touching another profile', t => {
  const f = fixture(t), elsewhere = path.join(f.root, 'elsewhere'); fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(f.root, 'WorkBuddy-Pi-5.9.1'));
  assert.throws(() => f.start(), /ordinary directory/); assert.deepEqual(fs.readdirSync(elsewhere), []);
});
