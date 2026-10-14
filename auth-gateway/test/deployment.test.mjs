import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(args, options = {}) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('deployment rendering validates inputs and produces private config, hardened unit and no query-string access logging', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-deploy-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'rendered');
  const args = ['deploy/render.mjs', '--origin', 'https://auth.example.test', '--tls-cert', '/etc/ssl/auth/cert.pem', '--tls-key', '/etc/ssl/auth/key.pem', '--node', '/usr/bin/node', '--output', output];
  run(args);
  assert.match(fs.readFileSync(path.join(output, 'gateway.env'), 'utf8'), /GATEWAY_TRUSTED_PROXY_IPS=127.0.0.1,::1/);
  const unit = fs.readFileSync(path.join(output, 'workbuddy-auth.service'), 'utf8');
  assert.match(unit, /User=workbuddy-auth/); assert.match(unit, /ProtectSystem=strict/);
  assert.equal(fs.statSync(path.join(output, 'gateway.env')).mode & 0o777, 0o600);
  const nginx = fs.readFileSync(path.join(output, 'workbuddy-auth.conf'), 'utf8');
  assert.match(nginx, /X-Real-IP \$remote_addr/); assert.ok(!nginx.includes('$request ')); assert.ok(!nginx.includes('$request_uri'));
  for (const filename of [path.join(output, 'workbuddy-auth'), path.join(root, 'deploy/install.sh'), path.join(root, 'deploy/rollback.sh')]) assert.equal(spawnSync('/bin/bash', ['-n', filename]).status, 0);
  const entry = spawnSync('/bin/bash', ['deploy/install.sh', '--origin', 'https://auth.example.test', '--tls-cert', '/etc/ssl/auth/cert.pem', '--tls-key', '/etc/ssl/auth/key.pem', '--node', process.execPath, '--render-only', path.join(dir, 'entry')], { cwd: root, encoding: 'utf8' });
  assert.equal(entry.status, 0, entry.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'entry', 'workbuddy-auth.service')));
  const invalid = spawnSync(process.execPath, [...args.slice(0, -2), '--prefix', '/tmp/unsafe;touch', '--output', path.join(dir, 'bad')], { cwd: root });
  assert.notEqual(invalid.status, 0); assert.equal(fs.existsSync(path.join(dir, 'bad')), false);
});

test('readiness probe uses the public origin Host while connecting only to the loopback backend', async t => {
  let receivedHost;
  const server = createHttpServer((req, res) => {
    receivedHost = req.headers.host;
    res.writeHead(receivedHost === '21.130.240.28' ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { status: 'ok', service: 'workbuddy-auth', schema: 2 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const child = spawn(process.execPath, ['scripts/health.mjs'], { cwd: root, env: { ...process.env, GATEWAY_PUBLIC_URL: 'https://21.130.240.28', GATEWAY_PORT: String(server.address().port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr); assert.equal(receivedHost, '21.130.240.28'); assert.equal(JSON.parse(stdout).status, 'ok');
});

test('release archive is self-contained, verified and excludes credentials, mock and client profiles', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-release-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archive = path.join(dir, 'release.tar.gz');
  run(['scripts/package.mjs', '--output', archive]);
  const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.equal(listing.status, 0); assert.doesNotMatch(listing.stdout, /(?:^|\/)\._[^\n]+/m);
  assert.equal(spawnSync('tar', ['-xzf', archive, '-C', dir]).status, 0);
  const bundle = path.join(dir, 'workbuddy-auth');
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'release-manifest.json')));
  assert.ok(Object.keys(manifest.files).every(name => !/mock|client-profiles|delivery\.key|\.sqlite|^\.env$/.test(name)));
  run([path.join(bundle, 'deploy/verify-package.mjs')], { cwd: bundle });
  const dataDir = path.join(dir, 'live-data');
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = String(reservation.address().port);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [path.join(bundle, 'src/main.mjs')], { env: { ...process.env, GATEWAY_PORT: port, GATEWAY_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend startup timeout: ' + stderr)), 5000);
    child.stdout.on('data', bytes => { if (String(bytes).includes('authentication gateway:')) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Backend exited before ready: ' + stderr)); });
  });
  const response = await fetch('http://127.0.0.1:' + port + '/healthz');
  assert.equal((await response.json()).data.service, 'workbuddy-auth');
  const duplicate = spawnSync(process.execPath, [path.join(bundle, 'src/main.mjs')], { env: { ...process.env, GATEWAY_PORT: port, GATEWAY_DATA_DIR: dataDir }, encoding: 'utf8' });
  assert.notEqual(duplicate.status, 0); assert.match(duplicate.stderr, /already owns/);
  child.kill('SIGTERM');
  assert.equal((await exited)[0], 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'server.lock')), false);
  fs.appendFileSync(path.join(bundle, 'src/gateway.mjs'), '\n// tampered fixture\n');
  assert.notEqual(spawnSync(process.execPath, [path.join(bundle, 'deploy/verify-package.mjs')]).status, 0);
});
