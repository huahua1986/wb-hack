import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../src/gateway.mjs';
import { AuthStore } from '../src/store.mjs';
import { hashPassword, seal, tokenHash } from '../src/credentials.mjs';
import { completeLogin, startGateway, startLogin, submitLogin, testConfig, TEST_PASSWORD } from './helpers.mjs';

const account = (client, auth) => client.request('/v2/plugin/account', { headers: { Authorization: `Bearer ${auth.accessToken}` } });
const refresh = (client, auth) => client.request('/v2/plugin/auth/token/refresh', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Refresh-Token': auth.refreshToken }, body: '{}',
});

async function restartableGateway(t) {
  const config = testConfig();
  let app = await createGateway(config);
  const listen = port => new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, '127.0.0.1', resolve); });
  await listen(0);
  const port = app.server.address().port;
  config.publicUrl = `http://127.0.0.1:${port}`;
  app.store.addUser('tester', '测试账号', await hashPassword(TEST_PASSWORD));
  t.after(async () => { await app.close(); fs.rmSync(config.dataDir, { recursive: true, force: true }); });
  return {
    config, get app() { return app; }, request: (route, options) => fetch(config.publicUrl + route, options),
    async restart() { await app.close(); app = await createGateway(config); await listen(port); },
  };
}

test('a second password login is rejected without revoking or exposing the existing session', async t => {
  const client = await startGateway(t), first = await completeLogin(client), second = await startLogin(client);
  assert.equal((await submitLogin(client, second, { password: 'incorrect' })).status, 401);
  const response = await submitLogin(client, second), page = await response.text();
  assert.equal(response.status, 409);
  assert.match(page, /role="alert"/); assert.match(page, /账号已有有效会话/); assert.match(page, /管理员释放会话/);
  for (const secret of [TEST_PASSWORD, first.accessToken, first.refreshToken]) assert.ok(!page.includes(secret));
  assert.equal((await account(client, first)).status, 200);
  assert.equal((await refresh(client, first)).status, 200);
  assert.equal(client.app.store.listSessions('tester').length, 1);
  assert.equal(client.app.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  assert.equal((await (await client.request(`/v2/plugin/auth/token?state=${second.state}`)).json()).code, 11217);
  const audit = client.app.store.listAudit({ username: 'tester' });
  assert.equal(audit.filter(row => row.action === 'login_rejected_active_session').length, 1);
  assert.ok(!JSON.stringify(audit).includes(first.refreshToken));
  assert.ok(!JSON.stringify(client.logs).includes(TEST_PASSWORD));
  assert.equal((await (await client.request('/healthz')).json()).data.sessionPolicy, 'single-session-reject');
});

test('simultaneous browser logins have one winner and one conflict', async t => {
  const client = await startGateway(t), left = await startLogin(client), right = await startLogin(client);
  const results = await Promise.all([submitLogin(client, left), submitLogin(client, right)]);
  assert.deepEqual(results.map(result => result.status).sort(), [303, 409]);
  const winner = results[0].status === 303 ? left : right;
  const auth = (await (await client.request(`/v2/plugin/auth/token?state=${winner.state}`)).json()).data;
  assert.equal((await account(client, auth)).status, 200);
  assert.equal(client.app.store.listSessions('tester').length, 1);
});

test('backend restart preserves the session; administrator release invalidates every token and permits retry', async t => {
  const client = await restartableGateway(t), first = await completeLogin(client);
  const id = client.app.store.listSessions('tester')[0].id;
  await client.restart();
  assert.equal((await account(client, first)).status, 200);
  const rotated = (await (await refresh(client, first)).json()).data;
  assert.equal(client.app.store.listSessions('tester')[0].id, id);
  const second = await startLogin(client);
  assert.equal((await submitLogin(client, second)).status, 409);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/session.mjs', import.meta.url)),
    'revoke', 'tester', '--id', id, '--data-dir', client.config.dataDir], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).revoked, 1);
  for (const auth of [first, rotated]) {
    assert.equal((await account(client, auth)).status, 401);
    assert.equal((await refresh(client, auth)).status, 401);
    assert.ok(!cli.stdout.includes(auth.accessToken) && !cli.stdout.includes(auth.refreshToken));
  }
  assert.equal((await submitLogin(client, second)).status, 303);
  const next = (await (await client.request(`/v2/plugin/auth/token?state=${second.state}`)).json()).data;
  assert.equal((await account(client, next)).status, 200);
  assert.notEqual(client.app.store.listSessions('tester')[0].id, id);
  await client.restart();
  assert.equal((await account(client, next)).status, 200);
  assert.equal((await refresh(client, rotated)).status, 401);
});

test('expired access alone does not free a slot; refresh session expiration does', async t => {
  let now = Date.now();
  const client = await startGateway(t, { now: () => now, config: { accessTtlSeconds: 60, refreshTtlSeconds: 600 } });
  const first = await completeLogin(client);
  now += 61000;
  assert.equal((await account(client, first)).status, 401);
  assert.equal((await submitLogin(client, await startLogin(client))).status, 409);
  now += 540000;
  const next = await completeLogin(client);
  assert.equal((await account(client, next)).status, 200);
  assert.equal((await refresh(client, first)).status, 401);
  assert.equal(client.app.store.listSessions('tester').length, 1);
});

test('an unclaimed login reserves a slot only until its five-minute delivery expires', async t => {
  let now = Date.now();
  const client = await startGateway(t, { now: () => now }), first = await startLogin(client);
  assert.equal((await submitLogin(client, first)).status, 303);
  now += 10000;
  const second = await startLogin(client);
  assert.equal((await submitLogin(client, second)).status, 409);
  now += 290001;
  assert.equal((await submitLogin(client, second)).status, 303);
  assert.equal((await client.request(`/v2/plugin/auth/token?state=${first.state}`)).status, 410);
  const next = (await (await client.request(`/v2/plugin/auth/token?state=${second.state}`)).json()).data;
  assert.equal((await account(client, next)).status, 200);
  assert.equal(client.app.store.listSessions('tester').length, 1);
  assert.ok(client.app.store.listAudit().some(row => row.action === 'session_expired_before_delivery'));
});

test('startup reconciles legacy multiple sessions by last use and removes revoked pending deliveries', async t => {
  const client = await restartableGateway(t), first = await completeLogin(client), store = client.app.store;
  const user = store.getUser('tester'), pending = store.createLoginState(), legacyId = randomUUID();
  let legacy;
  // Seed sessions that could coexist in the previous release.
  store.transaction(() => {
    const expires = Date.now() + 86400000;
    store.db.prepare('INSERT INTO sessions(id,user_id,refresh_hash,refresh_expires,created_at,last_seen_at) VALUES(?,?,?,?,?,?)')
      .run(legacyId, user.id, 'legacy-fixture', expires, Date.now() + 1000, Date.now() - 3600000);
    legacy = store.credentialPair(legacyId, expires);
    store.db.prepare('UPDATE sessions SET refresh_hash=? WHERE id=?').run(tokenHash(legacy.refreshToken), legacyId);
    store.db.prepare('UPDATE login_states SET session_id=?,delivery=? WHERE hash=?').run(legacyId, seal(store.key, legacy), tokenHash(pending));
  });
  await client.restart();
  assert.equal((await account(client, first)).status, 200);
  assert.equal((await account(client, legacy)).status, 401);
  assert.equal((await refresh(client, legacy)).status, 401);
  assert.equal((await client.request(`/v2/plugin/auth/token?state=${pending}`)).status, 410);
  assert.equal(client.app.store.listSessions('tester').length, 1);
  assert.ok(client.app.store.listAudit().some(row => row.action === 'session_revoked_single_session' && row.session_id === legacyId));
  await client.restart();
  assert.equal((await account(client, first)).status, 200);
  assert.equal(client.app.store.listAudit().filter(row => row.action === 'session_revoked_single_session').length, 1);
});

test('separate SQLite connections cannot both grant a session in a race', async t => {
  const config = testConfig(), store = new AuthStore(config);
  t.after(() => { store.close(); fs.rmSync(config.dataDir, { recursive: true, force: true }); });
  store.addUser('tester', '测试账号', await hashPassword(TEST_PASSWORD));
  const states = [store.createLoginState(), store.createLoginState()], userId = store.getUser('tester').id;
  const code = `import { AuthStore, SessionConflictError } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
    const store = new AuthStore(JSON.parse(process.argv[1]));
    process.stdin.once('data', () => {
      try { process.stdout.write(store.grantLogin(process.argv[2], process.argv[3]) ? 'granted\\n' : 'invalid\\n'); }
      catch (error) { if (error instanceof SessionConflictError) process.stdout.write('conflict\\n'); else process.exitCode = 1; }
      finally { store.close(); process.stdin.destroy(); }
    }); process.stdout.write('ready\\n'); process.stdin.resume();`;
  const workers = states.map(state => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(config), state, userId], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
    let output = '';
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('ready\n')) readyResolve(); });
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', status => { readyResolve(); status === 0 ? resolve(output) : reject(new Error('SQLite worker failed')); });
    });
    return { child, ready, done };
  });
  await Promise.all(workers.map(worker => worker.ready));
  for (const worker of workers) worker.child.stdin.end('grant');
  const results = await Promise.all(workers.map(worker => worker.done));
  assert.equal(results.filter(result => result.includes('granted\n')).length, 1);
  assert.equal(results.filter(result => result.includes('conflict\n')).length, 1);
  assert.equal(store.listSessions('tester').length, 1);
});
