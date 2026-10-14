import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { AuthStore } from '../src/store.mjs';
import { normalizeIp, requestIp } from '../src/client-ip.mjs';
import { readConfig } from '../src/config.mjs';
import { hashPassword, verifyPassword } from '../src/credentials.mjs';
import { completeLogin, startGateway, testConfig, TEST_PASSWORD } from './helpers.mjs';

test('trusted proxy handling normalizes mapped IPs and ignores spoofed headers from other peers', () => {
  const req = (peer, header) => ({ socket: { remoteAddress: peer }, headers: { 'x-real-ip': header } });
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp('0:0:0:0:0:0:0:1'), '::1');
  assert.equal(requestIp(req('192.0.2.1', '198.51.100.1'), ['127.0.0.1']), '192.0.2.1');
  assert.equal(requestIp(req('::ffff:127.0.0.1', '198.51.100.1'), ['127.0.0.1']), '198.51.100.1');
  assert.throws(() => requestIp(req('127.0.0.1', '198.51.100.1,198.51.100.2'), ['127.0.0.1']));
  assert.throws(() => readConfig({ GATEWAY_TRUSTED_PROXY_IPS: '*' }));
});

test('proxy clients have separate persisted limits across server/store restarts', async t => {
  const client = await startGateway(t, { config: { trustedProxyIPs: ['127.0.0.1'] } });
  const state = ip => client.request('/v2/plugin/auth/state?platform=workbuddy', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip }, body: '{}' });
  assert.equal((await state('192.0.2.11')).status, 200);
  assert.equal((await state('192.0.2.12')).status, 200);
  assert.equal((await state('not-an-ip')).status, 400);
  assert.equal(client.app.store.db.prepare('SELECT hits FROM rate_limits WHERE key=?').get('state:192.0.2.11').hits, 1);
  const reopened = new AuthStore(client.config);
  try { assert.equal(reopened.checkRateLimit('state:192.0.2.11', 1), false); assert.equal(reopened.checkRateLimit('state:192.0.2.13', 1), true); }
  finally { reopened.close(); }
});

test('administration revokes one or all sessions including pending delivery, without exposing tokens', async t => {
  const client = await startGateway(t), first = await completeLogin(client), second = await completeLogin(client);
  const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts');
  const run = (script, args, input = '') => {
    const result = spawnSync(process.execPath, [path.join(scripts, script + '.mjs'), ...args], { encoding: 'utf8', input, env: { ...process.env, GATEWAY_DATA_DIR: client.config.dataDir, WORKBUDDY_ADMIN_ACTOR: 'test-operator' } });
    assert.equal(result.status, 0, result.stderr);
    for (const value of [first.accessToken, first.refreshToken, second.accessToken, TEST_PASSWORD]) assert.ok(!result.stdout.includes(value) && !result.stderr.includes(value));
    return result.stdout;
  };
  const sessions = run('session', ['list', 'tester']).trim().split('\n').map(JSON.parse);
  assert.equal(sessions.length, 2);
  client.app.store.addUser('other-user', 'Other user', await hashPassword('other-user-fixture-password'));
  assert.throws(() => client.app.store.revokeUserSessions('other-user', { sessionId: sessions[0].id }), /belong/);
  assert.equal(JSON.parse(run('session', ['revoke', 'tester', '--id', sessions[0].id])).revoked, 1);
  assert.equal(client.app.store.listSessions('tester').length, 1);
  const valid = client.app.store.account(first.accessToken) ? first : second;
  const revoked = valid === first ? second : first;
  assert.equal(client.app.store.refresh(revoked.refreshToken), undefined);
  const pending = client.app.store.createLoginState();
  assert.equal(client.app.store.grantLogin(pending, client.app.store.getUser('tester').id), true);
  assert.equal(JSON.parse(run('session', ['revoke', 'tester', '--all'])).revoked, 2);
  assert.equal(client.app.store.pollLogin(pending).status, 'expired');
  assert.equal(client.app.store.account(valid.accessToken), undefined);
  assert.equal(client.app.store.refresh(valid.refreshToken), undefined);
  run('user', ['disable', 'tester']);
  run('user', ['enable', 'tester']);
  run('user', ['set-display-name', 'tester', '--display-name', 'Renamed user']);
  assert.equal(client.app.store.getUser('tester').nickname, 'Renamed user');
  const third = await completeLogin(client);
  run('user', ['set-password', 'tester'], 'new-password-for-test-only\n');
  assert.equal(client.app.store.account(third.accessToken), undefined);
  client.app.store.checkRateLimit('user:tester', 1);
  run('user', ['unlock', 'tester']);
  assert.equal(client.app.store.checkRateLimit('user:tester', 1), true);
  const audit = run('audit', ['--username', 'tester']).trim().split('\n').map(JSON.parse);
  assert.ok(audit.some(row => row.action === 'user_sessions_revoked' && row.actor === 'test-operator'));
  const bad = spawnSync(process.execPath, [path.join(scripts, 'session.mjs'), 'revoke', 'tester'], { env: { ...process.env, GATEWAY_DATA_DIR: client.config.dataDir }, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
});

test('a password reset during verification cannot issue a session from the old password', async t => {
  const client = await startGateway(t), user = client.app.store.getUser('tester'), state = client.app.store.createLoginState();
  client.app.store.updateUser('tester', await hashPassword('updated-password-for-fixture'));
  assert.equal(client.app.store.grantLogin(state, user.id, { expectedPasswordHash: user.password_hash }), false);
  assert.equal(client.app.store.listSessions('tester').length, 0);
});

test('legacy database/password records migrate, while new Unicode password policy and missing keys fail closed', async t => {
  const config = testConfig();
  t.after(() => fs.rmSync(config.dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(config.dataDir, 'delivery.key'), randomBytes(32));
  const db = new DatabaseSync(path.join(config.dataDir, 'gateway.sqlite'));
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE,nickname TEXT,password_hash TEXT,disabled INTEGER DEFAULT 0,created_at INTEGER); CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),refresh_hash TEXT UNIQUE,refresh_expires INTEGER,revoked INTEGER DEFAULT 0,previous_refresh_hash TEXT,previous_refresh_until INTEGER,previous_delivery TEXT); CREATE TABLE access_tokens(hash TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,expires INTEGER); CREATE TABLE login_states(hash TEXT PRIMARY KEY,expires INTEGER,session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,delivery TEXT);');
  const salt = randomBytes(16), legacyPassword = 'legacy-12-byte-pass';
  const encoded = ['scrypt', 32768, 8, 1, salt.toString('hex'), scryptSync(legacyPassword, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 67108864 }).toString('hex')].join('$');
  db.prepare('INSERT INTO users VALUES(?,?,?,?,0,?)').run('local_old', 'legacy-user', 'Legacy', encoded, Date.now());
  db.close();
  const store = new AuthStore(config);
  try { assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2); assert.equal(await verifyPassword(legacyPassword, store.getUser('legacy-user').password_hash), true); }
  finally { store.close(); }
  await assert.rejects(hashPassword('中文密码四个字'), /15 Unicode/);
  await assert.rejects(hashPassword('passwordpassword'), /predictable/);
  const current = await hashPassword('这是一个用于密码策略测试的足够长口令');
  assert.match(current, /^scrypt\$32768\$8\$3\$/);
  fs.unlinkSync(path.join(config.dataDir, 'delivery.key'));
  assert.throws(() => new AuthStore(config), /original key/);
  assert.equal(fs.existsSync(path.join(config.dataDir, 'delivery.key')), false);
});
