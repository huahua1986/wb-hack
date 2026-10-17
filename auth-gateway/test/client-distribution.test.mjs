import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KIND, VERSION, LABEL, CLIENT_MODULES, digest, verifyPayload, verifyWorkBuddy, initializeState, clientPaths, seedModels, launchAgent, validateModelPreset } from '../../client-distribution/lib.mjs';
import { installPayload, retireLegacyLogin } from '../../client-distribution/install.mjs';
import { disableClient } from '../../client-distribution/uninstall.mjs';
import { requestGateway } from '../../client-distribution/setup.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-client-distribution-'))), payload = path.join(root, 'payload'), home = path.join(root, 'user');
  fs.mkdirSync(payload); fs.mkdirSync(home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => { const p = path.join(payload, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, value); };
  for (const name of CLIENT_MODULES) write('auth-gateway/src/' + name + '.mjs', '// bounded fixture\n');
  for (const name of ['lib', 'bootstrap', 'install', 'uninstall', 'setup']) write('client-distribution/' + name + '.mjs', '// bounded fixture\n');
  write('runtime/node', 'fixture runtime'); write('runtime/LICENSE', 'fixture license'); write('native/ClientActions', 'fixture native helper');
  write('client-config.json', JSON.stringify({ gateway: '', appPath: '/Applications/WorkBuddy.app' }));
  const manifest = { kind: KIND, version: VERSION, compatibility: [], files: {} };
  const inventory = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const filename = path.join(dir, entry.name); if (entry.isDirectory()) inventory(filename); else manifest.files[path.relative(payload, filename)] = digest(filename); } };
  const save = () => { fs.writeFileSync(path.join(payload, 'release.json'), JSON.stringify(manifest)); };
  const rehashConfig = config => { write('client-config.json', JSON.stringify(config)); manifest.files['client-config.json'] = digest(path.join(payload, 'client-config.json')); save(); };
  inventory(payload); save();
  return { root, payload, home, manifest, write, save, rehashConfig };
}

test('client payload excludes backend, unlisted files, links, traversal and modified content', t => {
  const f = fixture(t);
  assert.equal(verifyPayload(f.payload).kind, KIND);
  f.write('credentials.json', '{"secret":"fixture-only"}');
  assert.throws(() => verifyPayload(f.payload), /未列入/);
  fs.unlinkSync(path.join(f.payload, 'credentials.json'));
  f.manifest.files['credentials.json'] = 'a'.repeat(64); f.save();
  assert.throws(() => verifyPayload(f.payload), /非客户端/);
  delete f.manifest.files['credentials.json']; f.manifest.files['../escape'] = 'a'.repeat(64); f.save();
  assert.throws(() => verifyPayload(f.payload), /非客户端|路径/);
  delete f.manifest.files['../escape']; f.save();
  fs.renameSync(path.join(f.payload, 'runtime/LICENSE'), path.join(f.root, 'license'));
  fs.symlinkSync(path.join(f.root, 'license'), path.join(f.payload, 'runtime/LICENSE'));
  assert.throws(() => verifyPayload(f.payload), /链接/);
  fs.unlinkSync(path.join(f.payload, 'runtime/LICENSE')); fs.renameSync(path.join(f.root, 'license'), path.join(f.payload, 'runtime/LICENSE'));
  f.write('runtime/node', 'tampered'); assert.throws(() => verifyPayload(f.payload), /校验失败/);
});

test('compatibility requires the tested version and each original artifact hash', t => {
  const f = fixture(t), app = path.join(f.root, 'WorkBuddy.app');
  const files = ['Contents/MacOS/Electron', 'Contents/Resources/app.asar', 'Contents/Resources/app.asar.unpacked/cli/product.json'];
  for (const name of [...files, 'Contents/Info.plist']) { const p = path.join(app, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, name); }
  const support = [{ version: '5.8.3', files: Object.fromEntries(files.map(name => [name, digest(path.join(app, name))])) }];
  assert.equal(verifyWorkBuddy(app, support, () => '5.8.3'), '5.8.3');
  assert.throws(() => verifyWorkBuddy(app, support, () => '5.8.4'), /尚未通过/);
  fs.appendFileSync(path.join(app, files[0]), 'change');
  assert.throws(() => verifyWorkBuddy(app, support, () => '5.8.3'), /不一致/);
  assert.throws(() => verifyWorkBuddy(path.join(f.root, 'missing'), support), /未找到原版/);
});

test('first-use gateway configuration is private, bounded and reused without a developer workspace', t => {
  const f = fixture(t), initial = initializeState(f.payload, { home: f.home });
  assert.equal(initial.needsGateway, true);
  for (const gateway of ['http://remote.example.test', 'https://user:password@example.test', 'https://example.test/path', 'https://example.test/?token=x']) {
    assert.throws(() => initializeState(f.payload, { home: f.home, gateway }));
  }
  const configured = initializeState(f.payload, { home: f.home, gateway: 'http://127.0.0.1:8787' });
  assert.equal(configured.settings.gateway, 'http://127.0.0.1:8787');
  assert.equal(fs.statSync(configured.state).mode & 0o777, 0o700);
  assert.equal(fs.statSync(configured.filename).mode & 0o777, 0o600);
  assert.equal(initializeState(f.payload, { home: f.home }).settings.gateway, configured.settings.gateway);
  assert.equal(fs.existsSync(path.join(configured.state, 'auth-gateway/data')), false);
});

test('foreign user state and symlinked configuration remain untouched', t => {
  const f = fixture(t), paths = clientPaths(f.home);
  fs.mkdirSync(paths.state, { recursive: true }); fs.writeFileSync(path.join(paths.state, 'user-file'), 'keep');
  assert.throws(() => initializeState(f.payload, { home: f.home, gateway: 'https://auth.example.test' }), /已有其他文件/);
  assert.equal(fs.readFileSync(path.join(paths.state, 'user-file'), 'utf8'), 'keep');
  fs.unlinkSync(path.join(paths.state, 'user-file')); initializeState(f.payload, { home: f.home, gateway: 'https://auth.example.test' });
  const target = path.join(f.root, 'foreign.json'); fs.writeFileSync(target, '{}');
  const config = path.join(paths.state, 'workbuddy-launcher.json'); fs.unlinkSync(config); fs.symlinkSync(target, config);
  assert.throws(() => initializeState(f.payload, { home: f.home }), /普通文件/);
  assert.equal(fs.readFileSync(target, 'utf8'), '{}');
});

test('user-level install survives source removal and refuses foreign programs and agents', t => {
  const f = fixture(t);
  const installed = installPayload(f.payload, { home: f.home, register: false });
  fs.rmSync(f.payload, { recursive: true });
  assert.equal(verifyPayload(installed.program).kind, KIND);
  const agent = fs.readFileSync(installed.agent, 'utf8');
  assert.ok(agent.includes(installed.program) && !agent.includes(f.payload));
  assert.match(agent, /<key>RunAtLoad<\/key><true\/>/); assert.match(agent, /<key>KeepAlive<\/key><false\/>/);
  assert.ok(!agent.includes('/usr/bin/open'));
  assert.doesNotMatch(agent, /<string>[^<]*\.app(?:\/|<)/);
  fs.writeFileSync(installed.agent, '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>foreign</string></dict></plist>');
  assert.throws(() => installPayload(installed.program, { home: f.home, register: false }), /其他配置/);
  const release = path.join(installed.program, 'release.json'); fs.writeFileSync(release, JSON.stringify({ kind: 'foreign' }));
  assert.throws(() => installPayload(installed.program, { home: f.home, register: false }));
  assert.equal(JSON.parse(fs.readFileSync(release)).kind, 'foreign');
});

test('explicit owned-profile migration preserves source and model bytes; foreign gateways are refused', t => {
  const f = fixture(t), legacy = path.join(f.root, 'legacy'), source = path.join(legacy, 'auth-gateway/client-profiles/double-click');
  fs.mkdirSync(path.join(source, 'config'), { recursive: true }); fs.mkdirSync(path.join(source, 'user-data'));
  fs.writeFileSync(path.join(source, 'managed.json'), JSON.stringify({ kind: 'workbuddy-double-click-profile', version: 1 }));
  fs.writeFileSync(path.join(source, 'last-launch.json'), JSON.stringify({ gateway: 'http://127.0.0.1:8787', mode: 'development', executable: '/Applications/WorkBuddy.app/Contents/MacOS/Electron' }));
  const models = '{"models":[{"id":"user-model","apiKey":"fixture-user-value"}]}';
  fs.writeFileSync(path.join(source, 'config/models.json'), models);
  assert.throws(() => initializeState(f.payload, { home: f.home, gateway: 'https://other.example.test', migrateFrom: legacy }), /不匹配/);
  const migrated = initializeState(f.payload, { home: f.home, gateway: 'http://127.0.0.1:8787', migrateFrom: legacy });
  const target = path.join(migrated.state, 'auth-gateway/client-profiles/double-click/config/models.json');
  assert.equal(fs.readFileSync(target, 'utf8'), models); assert.equal(fs.readFileSync(path.join(source, 'config/models.json'), 'utf8'), models);
  seedModels({ configDir: path.dirname(target) }, { models: [], availableModels: [] });
  assert.equal(fs.readFileSync(target, 'utf8'), models);
  assert.throws(() => initializeState(f.payload, { home: f.home, gateway: 'http://127.0.0.1:8787', migrateFrom: legacy }), /已有配置/);
});

test('model templates allow placeholders and direct URLs but cannot distribute API keys', () => {
  const preset = key => ({ models: [{ id: 'local-model', url: 'http://127.0.0.1:11434/v1', apiKey: key }], availableModels: ['local-model'] });
  assert.equal(validateModelPreset(preset('')).models.length, 1);
  assert.equal(validateModelPreset(preset('$' + '{LOCAL_MODEL_API_KEY}')).models.length, 1);
  assert.throws(() => validateModelPreset(preset('a-real-looking-key')), /不允许包含/);
  const invalid = preset(''); invalid.models[0].url = 'https://user:password@models.example.test/v1';
  assert.throws(() => validateModelPreset(invalid), /凭据/);
  const xml = launchAgent('/Users/Example User/A&B', 'certs/enterprise-ca.pem');
  assert.ok(xml.includes('A&amp;B')); assert.ok(xml.includes(LABEL)); assert.ok(!xml.includes('KeepAlive</key><true'));
});

test('legacy login and launcher are archived and restored without deleting user state or touching other jobs', t => {
  const f = fixture(t), installed = installPayload(f.payload, { home: f.home, register: false });
  initializeState(installed.program, { home: f.home, gateway: 'http://127.0.0.1:8787' });
  const oldApp = path.join(f.home, 'Applications/企业AI工作台.app'), marker = path.join(oldApp, 'Contents/Resources/launcher.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, JSON.stringify({ buildOwner: 'enterprise-workbench-launcher' }));
  const oldAgent = path.join(path.dirname(installed.agent), 'local.workbuddy.enterprise-ai-launcher.login.plist');
  const otherAgent = path.join(path.dirname(installed.agent), 'user-other.plist'); fs.writeFileSync(otherAgent, 'keep');
  fs.writeFileSync(oldAgent, 'fixture plist');
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (command.endsWith('/plutil')) return JSON.stringify(args.at(-1) === installed.agent
      ? { Label: LABEL, ProgramArguments: [path.join(installed.program, 'runtime/node')] }
      : { Label: 'local.workbuddy.enterprise-ai-launcher.login', ProgramArguments: ['/usr/bin/open', '-a', oldApp] });
    if (command.endsWith('/pgrep')) throw Object.assign(new Error('not running'), { status: 1 });
    return '';
  };
  retireLegacyLogin(f.home, { run });
  assert.ok(!fs.existsSync(oldApp) && !fs.existsSync(oldAgent));
  assert.ok(fs.existsSync(path.join(installed.state, 'legacy-launcher.app')));
  assert.equal(disableClient({ home: f.home, run }).legacyLoginRestoredForNextLogin, true);
  assert.ok(fs.existsSync(oldApp) && fs.existsSync(oldAgent));
  assert.equal(fs.readFileSync(otherAgent, 'utf8'), 'keep');
  assert.ok(fs.existsSync(path.join(installed.state, 'workbuddy-launcher.json')));
  assert.ok(calls.filter(([command]) => command.endsWith('/launchctl')).every(([, args]) => args[0] === 'bootout' && args[1].includes('local.workbuddy.enterprise')));
});

test('temporary browser setup requires its nonce, cookie, CSRF and origin; saves no credentials and closes', async t => {
  const f = fixture(t);
  let origin;
  const result = await requestGateway(f.root, { open: async url => {
    origin = new URL(url).origin;
    assert.equal(fs.statSync(path.join(f.root, 'setup-session.json')).mode & 0o777, 0o600);
    assert.equal((await fetch(origin + '/setup?nonce=wrong')).status, 404);
    const response = await fetch(url), html = await response.text(), cookie = response.headers.get('set-cookie').split(';')[0];
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
    const post = (gateway, overrides = {}) => fetch(origin + '/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: overrides.origin || origin, Cookie: cookie },
      body: new URLSearchParams({ csrf: overrides.csrf || csrf, gateway, action: 'save' }),
    });
    assert.equal((await post('https://auth.example.test', { origin: 'null' })).status, 403);
    assert.equal((await post('https://auth.example.test', { csrf: 'wrong' })).status, 403);
    const invalid = await post('https://user:fixture-password@auth.example.test');
    assert.equal(invalid.status, 400); assert.ok(!(await invalid.text()).includes('fixture-password'));
    const saved = await post('https://auth.example.test');
    assert.equal(saved.status, 200); assert.match(await saved.text(), /地址已保存/);
  } });
  assert.deepEqual(result, { gateway: 'https://auth.example.test' });
  assert.ok(!fs.existsSync(path.join(f.root, 'setup-session.json')));
  await assert.rejects(fetch(origin + '/setup'));
});

test('browser setup expires without leaving a listener or a setup token file', async t => {
  const f = fixture(t);
  assert.deepEqual(await requestGateway(f.root, { timeoutMs: 10 }), { cancelled: true });
  assert.ok(!fs.existsSync(path.join(f.root, 'setup-session.json')));
});
