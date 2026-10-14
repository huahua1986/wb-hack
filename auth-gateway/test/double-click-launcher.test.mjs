import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { rootCertificates } from 'node:tls';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLauncherSettings, sharedAuthFilename, workbuddyProcessIds, prepareDoubleClickLaunch, spawnPreparedWorkBuddy } from '../src/double-click-launcher.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-double-click-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "目录 空格's", 'Work Buddy.app');
  const exe = path.join(app, 'Contents', 'MacOS', 'Electron');
  const product = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'product.json');
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.mkdirSync(path.dirname(product), { recursive: true });
  fs.writeFileSync(exe, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(product, JSON.stringify({ productName: 'WorkBuddy', authentication: { id: 'workbuddy-desktop' }, models: [{ id: 'auto' }], config: {} }));
  const config = path.join(root, 'workbuddy-launcher.json');
  const settings = { gateway: 'https://auth.example.test', appPath: app, mode: 'development', nodeExecutable: '', reuseDevelopmentAuth: false, replaceProductionLogin: false };
  const home = path.join(root, 'test-user-home');
  const write = () => fs.writeFileSync(config, JSON.stringify(settings)); write();
  const prepare = () => prepareDoubleClickLaunch(config, { home, platform: 'darwin', findProcesses: () => [] });
  return { root, app, exe, product, config, settings, home, write, prepare };
}

test('JSON config validation never executes shell text and supports spaced application paths', t => {
  const f = fixture(t), parsed = readLauncherSettings(f.config, f.home);
  assert.equal(parsed.appPath, f.app);
  f.settings.gateway = 'https://user:password@auth.example.test'; f.write();
  assert.throws(() => readLauncherSettings(f.config), /gateway/);
  f.settings.gateway = 'http://remote.example.test'; f.write();
  assert.throws(() => readLauncherSettings(f.config), /gateway/);
  f.settings.gateway = 'https://auth.example.test'; f.settings.reuseDevelopmentAuth = 'true'; f.write();
  assert.throws(() => readLauncherSettings(f.config), /必须是/);
  f.settings.reuseDevelopmentAuth = false;
  for (const productName of [123, null, '   ']) {
    f.settings.productName = productName; f.write();
    assert.throws(() => readLauncherSettings(f.config), /productName/);
  }
});

test('private CA config validates certificates and passes additive Node trust to the original executable', async t => {
  const f = fixture(t), cert = path.join(f.root, 'private-ca.pem'), key = path.join(f.root, 'fixture-key.pem');
  const config = path.join(f.root, 'ca.cnf');
  fs.writeFileSync(config, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Launcher test root\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', key, '-out', cert], { encoding: 'utf8' });
  assert.equal(generated.status, 0, 'OpenSSL could not generate the test CA');
  const initial = f.prepare();
  const bundlePath = path.join(initial.profile.configDir, 'system-ca-bundle.pem');
  fs.writeFileSync(bundlePath, rootCertificates[0]);
  f.settings.caCertificate = 'private-ca.pem'; f.write();
  const prepared = f.prepare();
  assert.equal(prepared.profile.caCertificate, cert);
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  assert.ok(bundle.startsWith(rootCertificates[0])); assert.ok(bundle.includes(fs.readFileSync(cert, 'utf8').trim()));
  f.prepare(); assert.equal(fs.readFileSync(bundlePath, 'utf8'), bundle);
  const fakeSpawn = () => { const child = new EventEmitter(); child.pid = 123456; child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; };
  const result = await spawnPreparedWorkBuddy(prepared, { spawnProcess: fakeSpawn, watchMs: 5, parentEnvironment: { LOCAL_MODEL_API_KEY: 'test-model-key' } });
  assert.equal(result.env.NODE_EXTRA_CA_CERTS, cert); assert.equal(result.env.LOCAL_MODEL_API_KEY, 'test-model-key');
  assert.equal(result.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  const nativeSource = fs.readFileSync(fileURLToPath(new URL('./fixtures/cli-process-env.js', import.meta.url)), 'utf8');
  assert.equal(createHash('sha256').update(nativeSource).digest('hex'), '1527e7a28bea590c5b74116f64bd3a91e37c53f207c3c271fed1e7b59c90d048');
  const nativeExports = {};
  vm.runInNewContext(nativeSource, { exports: nativeExports, process: { env: {} }, require: name => {
    assert.equal(name, './app-lifetime-job.js');
    return { p: env => env.WORKBUDDY_CONFIG_DIR, u: dir => fs.existsSync(path.join(dir, 'system-ca-bundle.pem')) ? path.join(dir, 'system-ca-bundle.pem') : undefined, d: () => false, l: async () => undefined };
  } });
  assert.equal(nativeExports.n({}, result.env).NODE_EXTRA_CA_CERTS, bundlePath);
  fs.writeFileSync(cert, 'invalid PEM'); assert.throws(() => f.prepare(), /PEM CA/);
  f.settings.caCertificate = 123; f.write(); assert.throws(() => f.prepare(), /证书路径字符串/);
});

test('changing gateway regenerates owned product and dev resolver, preserving user models and installed files', t => {
  const f = fixture(t), sourceHash = createHash('sha256').update(fs.readFileSync(f.product)).digest('hex');
  const first = f.prepare();
  assert.equal(JSON.parse(fs.readFileSync(first.profile.productPath)).productName, 'WorkBuddy');
  const models = path.join(first.profile.configDir, 'models.json'); fs.writeFileSync(models, '[{"id":"user-custom"}]');
  const publicPlugin = path.join(first.profile.configDir, 'plugins', 'marketplaces', 'workbuddy-connector-plugins-official', 'connectors', 'public-existing', 'plugin.json');
  fs.mkdirSync(path.dirname(publicPlugin), { recursive: true }); fs.writeFileSync(publicPlugin, '{"name":"public-existing","version":"1.0.0"}');
  f.settings.gateway = 'https://new-auth.example.test'; f.settings.productName = ' 企业AI工作台 '; f.write();
  const second = f.prepare();
  const product = JSON.parse(fs.readFileSync(second.profile.productPath));
  const dev = JSON.parse(fs.readFileSync(path.join(second.profile.configDir, 'dev-env.json')));
  assert.equal(product.endpoint, f.settings.gateway); assert.equal(product.config.disabled, true);
  assert.equal(product.productName, '企业AI工作台');
  f.prepare();
  assert.equal(JSON.parse(fs.readFileSync(second.profile.productPath)).productName, '企业AI工作台');
  assert.ok(product.models.every(model => model.disabled));
  assert.equal(dev.customEnvs.find(e => e.name === 'double-click-gateway').endpoint, f.settings.gateway);
  assert.equal(fs.readFileSync(models, 'utf8'), '[{"id":"user-custom"}]');
  assert.equal(fs.readFileSync(publicPlugin, 'utf8'), '{"name":"public-existing","version":"1.0.0"}');
  const source = JSON.parse(fs.readFileSync(path.join(second.profile.configDir, 'connectors', 'connector-marketplace.json')));
  assert.equal(source.connectorPluginMarketplaceUrl, f.settings.gateway + '/connector-agent-plugins/connector-plugins.zip');
  assert.equal(createHash('sha256').update(fs.readFileSync(f.product)).digest('hex'), sourceHash);
});

test('double-click refuses an unowned source override without removing installed content', t => {
  const f = fixture(t), first = f.prepare();
  const sourcePath = path.join(first.profile.configDir, 'connectors', 'connector-marketplace.json');
  const foreign = '{"connectorPluginMarketplaceUrl":"https://user.example.test/catalog.zip","custom":true}';
  fs.writeFileSync(sourcePath, foreign);
  assert.throws(() => f.prepare(), /not owned/);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), foreign);
});

test('unmanaged profiles and running app block launch without process killing', t => {
  const f = fixture(t);
  assert.throws(() => prepareDoubleClickLaunch(f.config, { home: f.home, findProcesses: () => [12345] }), /仍在运行/);
  const inBundle = path.join(f.app, 'workbuddy-launcher.json'); fs.writeFileSync(inBundle, JSON.stringify(f.settings));
  assert.throws(() => prepareDoubleClickLaunch(inBundle, { home: f.home, findProcesses: () => [] }), /包之外/);
  const dir = path.join(f.root, 'auth-gateway', 'client-profiles', 'double-click'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'user-file.txt'), 'preserve');
  assert.throws(() => f.prepare(), /拒绝覆盖/);
  assert.equal(fs.readFileSync(path.join(dir, 'user-file.txt'), 'utf8'), 'preserve');
});

test('unknown shared development auth is preserved; owned matching gateway can be reused', t => {
  const f = fixture(t), auth = sharedAuthFilename('development', f.home, 'darwin');
  fs.mkdirSync(path.dirname(auth), { recursive: true });
  const foreign = JSON.stringify({ auth: { domain: 'other.example.test', accessToken: 'test-only-placeholder' } }); fs.writeFileSync(auth, foreign);
  assert.throws(() => f.prepare(), /已有开发登录态/);
  assert.equal(fs.readFileSync(auth, 'utf8'), foreign);
  f.settings.reuseDevelopmentAuth = true; f.write(); const prepared = f.prepare();
  fs.writeFileSync(path.join(prepared.directory, 'last-launch.json'), JSON.stringify({ gateway: f.settings.gateway, mode: 'development', executable: f.exe }));
  fs.writeFileSync(auth, JSON.stringify({ auth: { domain: 'auth.example.test', accessToken: 'test-only-placeholder' } }));
  f.settings.reuseDevelopmentAuth = false; f.write(); assert.doesNotThrow(() => f.prepare());
  f.settings.mode = 'production'; f.write(); assert.throws(() => f.prepare(), /replaceProductionLogin/);
});

test('spawn receives configured environment and detaches without starting a proxy', async t => {
  const f = fixture(t), prepared = f.prepare(); let passed;
  const fakeSpawn = (executable, args, options) => {
    passed = { executable, args, options };
    const child = new EventEmitter(); child.pid = 123456; child.unref = () => { passed.unref = true; };
    queueMicrotask(() => child.emit('spawn')); return child;
  };
  const result = await spawnPreparedWorkBuddy(prepared, { spawnProcess: fakeSpawn, watchMs: 5, parentEnvironment: { LOCAL_MODEL_API_KEY: 'test-model-key', CODEBUDDY_AUTH_TOKEN: 'stale-test', NODE_OPTIONS: '--stale', WORKBUDDY_CONNECTOR_MARKET_API: '1', WORKBUDDY_BUILTIN_MARKET_BASE_URL: 'https://stale.example.test' } });
  assert.equal(passed.executable, f.exe); assert.deepEqual(passed.args, []);
  assert.equal(passed.options.shell, false); assert.equal(passed.options.detached, true); assert.equal(passed.unref, true);
  assert.equal(result.env.WORKBUDDY_DEV_ENDPOINT_OVERRIDE, f.settings.gateway);
  assert.equal(result.env.LOCAL_MODEL_API_KEY, 'test-model-key'); assert.equal(result.env.CODEBUDDY_AUTH_TOKEN, undefined);
  assert.equal(result.env.NODE_OPTIONS, undefined); assert.equal(result.env.NODE_ENV, 'development');
  assert.equal(result.env.CODEBUDDY_REMOTE_CONFIG_DISABLED, '1');
  assert.equal(result.env.WORKBUDDY_CONNECTOR_MARKET_API, '0'); assert.equal(result.env.WORKBUDDY_BUILTIN_MARKET_BASE_URL, undefined);
  assert.ok(fs.existsSync(path.join(prepared.directory, 'last-launch.json')));
});

test('spawn errors and early exits produce actionable failures', async t => {
  const f = fixture(t), prepared = f.prepare();
  for (const kind of ['error', 'exit']) {
    const spawnProcess = () => {
      const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => kind === 'error' ? child.emit('error', { code: 'ENOENT' }) : (child.emit('spawn'), child.emit('exit', 0, null)));
      return child;
    };
    await assert.rejects(spawnPreparedWorkBuddy(prepared, { spawnProcess, watchMs: 5 }), kind === 'error' ? /无法启动/ : /提前退出/);
  }
  assert.equal(fs.existsSync(path.join(prepared.directory, 'last-launch.json')), false);
});

test('named launch applies both labels, clears its temporary file and waits for inspector closure', async t => {
  const f = fixture(t); f.settings.productName = '企业AI工作台'; f.settings.welcomeTitle = '企业AI工作台，我帮你'; f.write();
  const prepared = f.prepare(); let passed, installed;
  const spawnProcess = (executable, args, options) => {
    passed = { executable, args, options };
    fs.writeSync(options.stdio[2], 'Debugger listening on ws://127.0.0.1:23456/fixture-id\n');
    const child = new EventEmitter(); child.pid = 123456; child.unref = () => {}; child.kill = () => { throw new Error('Must not kill successful startup'); };
    queueMicrotask(() => child.emit('spawn')); return child;
  };
  const result = await spawnPreparedWorkBuddy(prepared, { spawnProcess, watchMs: 5, brandingInstaller: async (endpoint, options) => {
    installed = { endpoint, options }; return { installed: true, inspectorClosed: true, inspectorPort: 23456 };
  } });
  assert.deepEqual(passed.args, ['--inspect-brk=127.0.0.1:0']);
  assert.equal(passed.options.shell, false); assert.equal(passed.options.env.NODE_OPTIONS, undefined);
  assert.equal(installed.options.productName, '企业AI工作台'); assert.equal(installed.options.welcomeTitle, '企业AI工作台，我帮你');
  assert.equal(installed.options.appAsarPath, path.join(f.app, 'Contents', 'Resources', 'app.asar'));
  assert.equal(result.runtimeBranding.inspectorClosed, true);
  assert.ok(!fs.readdirSync(prepared.directory).some(name => name.startsWith('.branding-')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(prepared.directory, 'last-launch.json'))).runtimeBranding.inspectorPort, 23456);
});

test('failed branding stops only its own new process and does not publish successful launch metadata', async t => {
  const f = fixture(t); f.settings.productName = '企业AI工作台'; f.write();
  const prepared = f.prepare(); let killed;
  const spawnProcess = (_executable, _args, options) => {
    fs.writeSync(options.stdio[2], 'Debugger listening on ws://127.0.0.1:23456/fixture-id\n');
    const child = new EventEmitter(); child.unref = () => {}; child.kill = signal => { killed = signal; };
    queueMicrotask(() => child.emit('spawn')); return child;
  };
  await assert.rejects(spawnPreparedWorkBuddy(prepared, { spawnProcess, watchMs: 5, brandingInstaller: async () => ({ installed: true, inspectorClosed: false }) }), /未关闭/);
  assert.equal(killed, 'SIGTERM'); assert.equal(fs.existsSync(path.join(prepared.directory, 'last-launch.json')), false);
  assert.ok(!fs.readdirSync(prepared.directory).some(name => name.startsWith('.branding-')));
});

test('process lookup uses bounded escaped argv and distinguishes no match from failure', () => {
  let args;
  const pid = workbuddyProcessIds('/example/Work Buddy.app/Contents/MacOS/Electron', (command, values) => { args = { command, values }; return '123\n456\n'; });
  assert.deepEqual(pid, [123, 456]); assert.equal(args.command, '/usr/bin/pgrep');
  assert.ok(args.values[1].startsWith('^/example/Work Buddy\\.app'));
  assert.deepEqual(workbuddyProcessIds('/example/Electron', () => { throw { status: 1 }; }), []);
  assert.throws(() => workbuddyProcessIds('/example/Electron', () => { throw { status: 3 }; }), /无法检查/);
});

test('double-click command works with Finder-like PATH and a simulated app only', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t);
  const capture = path.join(f.root, 'mock-environment.json');
  fs.writeFileSync(f.exe, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.env.WB_LAUNCHER_TEST_CAPTURE,JSON.stringify({gateway:process.env.WORKBUDDY_DEV_ENDPOINT_OVERRIDE,mode:process.env.NODE_ENV,config:process.env.ACC_PRODUCT_CONFIG_PATH}));setTimeout(()=>{},1600);\n`, { mode: 0o755 });
  const command = path.join(f.root, '启动WorkBuddy.command');
  fs.copyFileSync(fileURLToPath(new URL('../../启动WorkBuddy.command', import.meta.url)), command); fs.chmodSync(command, 0o755);
  const helper = fileURLToPath(new URL('../scripts/double-click-workbuddy.mjs', import.meta.url));
  fs.mkdirSync(path.join(f.root, 'auth-gateway', 'scripts'), { recursive: true });
  fs.symlinkSync(helper, path.join(f.root, 'auth-gateway', 'scripts', 'double-click-workbuddy.mjs'));
  f.settings.nodeExecutable = process.execPath;
  // The simulated executable never reads or writes the real auth namespace.
  // This explicit fixture option prevents any inspection of auth contents.
  f.settings.reuseDevelopmentAuth = true; f.write();
  const result = spawnSync('/bin/zsh', [command], { encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', WB_LAUNCHER_TEST_CAPTURE: capture } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已传入 WORKBUDDY_DEV_ENDPOINT_OVERRIDE/);
  assert.ok(fs.existsSync(capture));
  const environment = JSON.parse(fs.readFileSync(capture));
  assert.equal(environment.gateway, f.settings.gateway); assert.equal(environment.mode, 'development');
  assert.equal(JSON.parse(fs.readFileSync(environment.config)).endpoint, f.settings.gateway);
  const globalNode = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].some(filename => fs.existsSync(filename) && Number(spawnSync(filename, ['-p', 'process.versions.node.split(".")[0]'], { encoding: 'utf8' }).stdout.trim()) >= 24);
  if (globalNode) {
    f.settings.nodeExecutable = ''; f.write();
    const automatic = spawnSync('/bin/zsh', [command, '--check'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
    assert.equal(automatic.status, 0, automatic.stderr);
    assert.match(automatic.stdout, /检查通过/);
  }
});
