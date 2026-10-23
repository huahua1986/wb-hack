import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { startGateway, completeLogin, TEST_PASSWORD } from './helpers.mjs';
import { authorizeMock, beginLexiangAuthorization, submitLexiangAuthorization, authHeaders, LEXIANG_OAUTH as prefix, LEXIANG_TEST_PASSWORD } from './lexiang-helpers.mjs';
import { createBackup, restoreBackup } from '../src/backup.mjs';
import { AuthStore } from '../src/store.mjs';
import { readLexiangConfig } from '../src/lexiang-http.mjs';

const status = async (client, token) => (await (await client.request(prefix + 'status', { headers: authHeaders(token) })).json()).data.status;
const post = (client, token, suffix, body = {}) => client.request(prefix + suffix, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) });
const access = async (client, token) => (await (await client.request(prefix + 'accesstoken', { headers: authHeaders(token) })).json()).data;
const api = (client, token, path) => client.request(path, { headers: authHeaders(token) });

test('WorkBuddy and Lexiang credentials are separate and explicit consent is required before data access', async t => {
  const client = await startGateway(t, { config: { lexiang: { mode: 'mock' } } }), wb = await completeLogin(client);
  assert.equal(await status(client, wb.accessToken), 'not_connected');
  const denied = await client.request(prefix + 'accesstoken', { headers: authHeaders(wb.accessToken) });
  assert.equal(denied.status, 200); assert.equal((await denied.json()).code, 401);
  await client.app.lexiang.mock.addAccount('knowledge-one', '知识账号一', LEXIANG_TEST_PASSWORD);
  const pending = await beginLexiangAuthorization(client, wb.accessToken);
  assert.match(pending.html, /两个系统的密码分别管理/);
  const wrong = await submitLexiangAuthorization(client, pending, { action: 'login', username: 'knowledge-one', password: TEST_PASSWORD });
  assert.equal(wrong.status, 401); assert.equal(await status(client, wb.accessToken), 'pending');
  const login = await submitLexiangAuthorization(client, pending, { action: 'login', username: 'knowledge-one', password: LEXIANG_TEST_PASSWORD });
  assert.equal(login.status, 200); assert.match(await login.text(), /确认授权绑定/);
  assert.equal(await status(client, wb.accessToken), 'pending');
  const approved = await submitLexiangAuthorization(client, pending, { action: 'approve' }); assert.equal(approved.status, 200);
  assert.equal(await status(client, wb.accessToken), 'connected');
  const token = await access(client, wb.accessToken), staff = (await (await api(client, token.access_token, '/spapi/account/v1/staff')).json()).data.staff;
  assert.equal(staff.display_name, '知识账号一');
  assert.equal((await (await api(client, wb.accessToken, '/v2/plugin/account')).json()).data.nickname, '测试账号');
  assert.equal(client.app.store.db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
});

test('authorization resists forged CSRF, foreign origins, state replay and WorkBuddy session revocation', async t => {
  const client = await startGateway(t, { config: { lexiang: { mode: 'mock' } } }), wb = await completeLogin(client);
  await client.app.lexiang.mock.addAccount('knowledge-one', '知识账号一', LEXIANG_TEST_PASSWORD);
  const pending = await beginLexiangAuthorization(client, wb.accessToken);
  assert.equal((await submitLexiangAuthorization(client, { ...pending, csrf: 'wrong' }, { action: 'login', username: 'knowledge-one', password: LEXIANG_TEST_PASSWORD })).status, 403);
  assert.equal((await client.request('/private/lexiang/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: pending.cookie, Origin: 'https://attacker.example.test' }, body: new URLSearchParams({ state: pending.state, csrf: pending.csrf, action: 'approve' }) })).status, 403);
  assert.equal((await submitLexiangAuthorization(client, pending, { action: 'approve' })).status, 400);
  await submitLexiangAuthorization(client, pending, { action: 'login', username: 'knowledge-one', password: LEXIANG_TEST_PASSWORD });
  await submitLexiangAuthorization(client, pending, { action: 'approve' });
  const id = client.app.lexiang.auth.binding(client.app.store.getUser('tester').id).id;
  await submitLexiangAuthorization(client, pending, { action: 'approve' });
  assert.equal(client.app.lexiang.auth.binding(client.app.store.getUser('tester').id).id, id);
  const next = await beginLexiangAuthorization(client, wb.accessToken);
  client.app.store.revokeUserSessions('tester');
  assert.equal((await submitLexiangAuthorization(client, next, { action: 'login', username: 'knowledge-one', password: LEXIANG_TEST_PASSWORD })).status, 410);
});

test('access and refresh tokens rotate, old access fails, and an expired Lexiang grant leaves WorkBuddy logged in', async t => {
  let now = Date.now(); const client = await startGateway(t, { now: () => now, config: { lexiang: { mode: 'mock' } } }), wb = await completeLogin(client);
  await authorizeMock(client, wb.accessToken);
  const user = client.app.store.getUser('tester'), before = client.app.lexiang.auth.binding(user.id);
  const first = await access(client, wb.accessToken), oldRefresh = client.app.lexiang.auth.refreshToken(client.app.lexiang.auth.binding(user.id));
  now += 301000;
  assert.equal((await api(client, first.access_token, '/spapi/account/v1/staff')).status, 401);
  const refreshed = (await (await post(client, wb.accessToken, 'refresh')).json()).data;
  assert.notEqual(first.access_token, refreshed.access_token);
  assert.equal((await api(client, refreshed.access_token, '/spapi/account/v1/staff')).status, 200);
  const binding = client.app.lexiang.auth.binding(user.id);
  assert.ok(binding.refresh_count >= before.refresh_count + 2);
  assert.notEqual(client.app.lexiang.auth.refreshToken(binding), oldRefresh);
  assert.throws(() => client.app.lexiang.mock.refresh(oldRefresh, binding.id), /授权/);
  client.app.store.db.prepare('UPDATE lexiang_bindings SET refresh_expires=? WHERE id=?').run(now - 1, binding.id);
  assert.equal(await status(client, wb.accessToken), 'expired');
  const unavailable = await client.request(prefix + 'accesstoken', { headers: authHeaders(wb.accessToken) });
  assert.equal(unavailable.status, 200); assert.equal((await unavailable.json()).code, 401);
  assert.equal((await api(client, wb.accessToken, '/v2/plugin/account')).status, 200);
});

test('unbinding invalidates old access, tickets and cookies, and rebinding cannot resurrect the old member identity', async t => {
  const client = await startGateway(t, { config: { lexiang: { mode: 'mock' } } }), wb = await completeLogin(client);
  await authorizeMock(client, wb.accessToken, { username: 'knowledge-one', nickname: '知识账号一' });
  const first = await access(client, wb.accessToken);
  const ticket = (await (await post(client, wb.accessToken, 'temp-login-url', { intend_url: client.config.publicUrl + '/wb' })).json()).data.login_url;
  const used = await fetch(ticket, { redirect: 'manual' }), cookie = used.headers.get('set-cookie').split(';')[0];
  const unconsumed = (await (await post(client, wb.accessToken, 'temp-login-url', { intend_url: client.config.publicUrl + '/wb' })).json()).data.login_url;
  assert.equal((await post(client, wb.accessToken, 'revoke')).status, 200);
  assert.equal(await status(client, wb.accessToken), 'not_connected');
  assert.equal((await api(client, first.access_token, '/spapi/account/v1/staff')).status, 401);
  assert.equal((await fetch(unconsumed, { redirect: 'manual' })).status, 401);
  assert.equal((await client.request('/wb', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await api(client, wb.accessToken, '/v2/plugin/account')).status, 200);
  await authorizeMock(client, wb.accessToken, { username: 'knowledge-two', nickname: '知识账号二' });
  const second = await access(client, wb.accessToken);
  assert.equal((await (await api(client, second.access_token, '/spapi/account/v1/staff')).json()).data.staff.display_name, '知识账号二');
  assert.equal((await api(client, first.access_token, '/spapi/account/v1/staff')).status, 401);
});

test('a password revision change between login and consent cannot grant access', async t => {
  const client = await startGateway(t, { config: { lexiang: { mode: 'mock' } } }), wb = await completeLogin(client);
  const member = await client.app.lexiang.mock.addAccount('knowledge-one', '知识账号一', LEXIANG_TEST_PASSWORD);
  const pending = await beginLexiangAuthorization(client, wb.accessToken);
  await submitLexiangAuthorization(client, pending, { action: 'login', username: 'knowledge-one', password: LEXIANG_TEST_PASSWORD });
  client.app.store.db.prepare('UPDATE lexiang_mock_accounts SET revision=revision+1 WHERE id=?').run(member.id);
  assert.equal((await submitLexiangAuthorization(client, pending, { action: 'approve' })).status, 403);
  assert.equal(await status(client, wb.accessToken), 'pending');
});

test('backup restore cannot reintroduce an old independent authorization', async t => {
  const client = await startGateway(t, { config: { lexiang: { mode: 'mock' } } }), wb = await completeLogin(client);
  await authorizeMock(client, wb.accessToken);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lexiang-restore-')); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const snapshot = path.join(parent, 'snapshot'), destination = path.join(parent, 'restored');
  await createBackup(client.config, snapshot); restoreBackup({ ...client.config, dataDir: destination }, snapshot);
  const restored = new AuthStore({ ...client.config, dataDir: destination });
  try { assert.equal(restored.db.prepare('SELECT count(*) AS n FROM lexiang_bindings').get().n, 0); assert.equal(restored.db.prepare('SELECT count(*) AS n FROM lexiang_mock_refresh_tokens WHERE revoked=0').get().n, 0); } finally { restored.close(); }
});

test('concurrent refreshes are coalesced and durable grants never store passwords or refresh secrets in plaintext', async t => {
  const client = await startGateway(t, { config: { lexiang: { mode: 'mock' } } }), wb = await completeLogin(client);
  await authorizeMock(client, wb.accessToken);
  const user = client.app.store.getUser('tester'), session = client.app.store.sessionForAccessToken(wb.accessToken);
  const tokens = await Promise.all(Array.from({ length: 8 }, () => client.app.lexiang.delegatedToken(user, session, true)));
  assert.ok(tokens.every(token => token.access_token === tokens[0].access_token));
  const first = tokens[0].access_token, next = await access(client, wb.accessToken);
  assert.notEqual(next.access_token, first);
  assert.equal((await api(client, first, '/spapi/account/v1/staff')).status, 200);
  const binding = client.app.lexiang.auth.binding(user.id), refresh = client.app.lexiang.auth.refreshToken(binding);
  const data = Buffer.concat(['gateway.sqlite', 'gateway.sqlite-wal'].filter(name => fs.existsSync(path.join(client.config.dataDir, name))).map(name => fs.readFileSync(path.join(client.config.dataDir, name))));
  for (const secret of [LEXIANG_TEST_PASSWORD, refresh, first, next.access_token]) assert.equal(data.includes(Buffer.from(secret)), false);
  assert.equal(JSON.stringify(client.logs).includes(refresh), false);
});

test('cancelled and superseded authorization links do not bind an account', async t => {
  const client = await startGateway(t, { config: { lexiang: { mode: 'mock' } } }), wb = await completeLogin(client);
  const first = await beginLexiangAuthorization(client, wb.accessToken), next = await beginLexiangAuthorization(client, wb.accessToken);
  assert.equal((await submitLexiangAuthorization(client, first, { action: 'deny' })).status, 410);
  assert.equal((await submitLexiangAuthorization(client, next, { action: 'deny' })).status, 200);
  assert.equal(await status(client, wb.accessToken), 'failed');
  assert.equal(client.app.lexiang.auth.binding(client.app.store.getUser('tester').id), undefined);
  assert.equal((await api(client, wb.accessToken, '/v2/plugin/account')).status, 200);
});

test('bridge authorization uses PKCE and user consent exchange; refresh and introspection are scoped to the binding generation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lexiang-bridge-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = path.join(directory, 'bridge.key'), secret = 'fixture-service-secret-32-characters-only'; fs.writeFileSync(key, secret, { mode: 0o600 });
  let origin, challenge, state, unsafe = false, excessiveTtl = false; const calls = [];
  const grant = () => ({ subject: 'member-b', display_name: '客户乐享用户B', refresh_token: 'fixture-private-refresh-' + calls.length, refresh_expires_at: Math.floor(Date.now() / 1000) + 86400 });
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const bytes of req) text += bytes; const body = JSON.parse(text); calls.push({ path: req.url, body, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/authorize') { challenge = body.code_challenge; state = body.state; return res.end(JSON.stringify({ authorize_url: origin + '/customer-login?state=' + body.state })); }
    if (req.url === '/exchange') { assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), challenge); return res.end(JSON.stringify(grant())); }
    if (req.url === '/refresh') return res.end(JSON.stringify({ ...grant(), access_token: 'fixture-member-access-' + calls.length, expires_at: Math.floor(Date.now() / 1000) + (excessiveTtl ? 3600 : 120) }));
    if (req.url === '/login-url') return res.end(JSON.stringify({ login_url: (unsafe ? 'https://attacker.example.test' : 'https://knowledge.customer.test') + '/pages/doc?ticket=fixture' }));
    if (req.url === '/revoke') return res.end(JSON.stringify({ ok: true }));
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  origin = `http://127.0.0.1:${server.address().port}`;
  const client = await startGateway(t, { config: { lexiang: { mode: 'bridge', webOrigin: 'https://knowledge.customer.test', bridgeOrigin: origin, bridgeSecretFile: key, mcpUrl: origin + '/mcp' } } }), wb = await completeLogin(client);
  assert.equal(await status(client, wb.accessToken), 'not_connected');
  const started = (await (await post(client, wb.accessToken, 'start')).json()).data;
  assert.equal(new URL(started.authorize_url).origin, origin);
  const callback = '/private/lexiang/callback?state=' + state + '&code=fixture-authorization-code';
  assert.equal((await client.request(callback)).status, 200); assert.equal((await client.request(callback)).status, 410);
  assert.equal(await status(client, wb.accessToken), 'connected');
  const token = await access(client, wb.accessToken); assert.match(token.access_token, /^fixture-member-access-/);
  assert.ok(calls.every(call => !JSON.stringify(call).includes(wb.accessToken)));
  assert.equal(calls[0].authorization, 'Bearer ' + secret);
  const input = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'call_rpc', arguments: { tool_name: 'entry_list_example_space_entries', arguments: {} } } };
  assert.equal((await client.request('/console/agent-gateway/lexiang-ol/mcp', { method: 'POST', headers: authHeaders(wb.accessToken), body: JSON.stringify(input) })).status, 200);
  assert.match(calls.at(-1).authorization, /^Bearer fixture-member-access-/);
  excessiveTtl = true; assert.equal((await api(client, wb.accessToken, prefix + 'accesstoken')).status, 502); excessiveTtl = false;
  const binding = client.app.lexiang.auth.binding(client.app.store.getUser('tester').id), session = client.app.store.sessionForAccessToken(wb.accessToken);
  const introspect = async (bindingId, authorization = secret) => (await (await client.request('/private/lexiang/bridge/introspect', { method: 'POST', headers: authHeaders(authorization), body: JSON.stringify({ subject: 'member-b', session_id: session.id, binding_id: bindingId }) })).json());
  assert.equal((await introspect(binding.id)).data.active, true); assert.equal((await introspect('old-binding')).data.active, false);
  assert.equal((await client.request('/private/lexiang/bridge/introspect', { method: 'POST', headers: authHeaders(wb.accessToken), body: JSON.stringify({ subject: 'member-b', session_id: session.id, binding_id: binding.id }) })).status, 401);
  const login = () => post(client, wb.accessToken, 'temp-login-url', { intend_url: 'https://lexiangla.com/pages/doc' });
  assert.equal((await login()).status, 200); unsafe = true; assert.equal((await login()).status, 502);
  const published = await (await client.request('/v3/config')).text(); assert.ok(!published.includes(secret) && !published.includes('refresh_token'));
  assert.equal((await post(client, wb.accessToken, 'revoke')).status, 200); assert.equal((await introspect(binding.id)).data.active, false);
  assert.equal((await api(client, wb.accessToken, '/v2/plugin/account')).status, 200);
  fs.chmodSync(key, 0o644); assert.throws(() => readLexiangConfig(client.config), /0600/);
});

test('in-flight bridge exchanges cannot restore a revoked or superseded authorization', async t => {
  for (const interrupt of ['revoke', 'start']) {
    await t.test(interrupt, async t => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lexiang-race-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const key = path.join(directory, 'bridge.key'); fs.writeFileSync(key, 'fixture-service-secret-32-characters-only', { mode: 0o600 });
      const client = await startGateway(t, { config: { lexiang: { mode: 'bridge', webOrigin: 'https://knowledge.customer.test', bridgeOrigin: 'http://127.0.0.1:10001', bridgeSecretFile: key, mcpUrl: 'http://127.0.0.1:10001/mcp' } } }), wb = await completeLogin(client);
      let entered, release, state, revoked = 0;
      const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
      client.app.lexiang.request = async (url, options) => {
        const body = JSON.parse(options.body), route = new URL(url).pathname;
        if (route === '/authorize') { state = body.state; return Response.json({ authorize_url: 'http://127.0.0.1:10001/login' }); }
        if (route === '/revoke') { revoked++; return Response.json({ ok: true }); }
        assert.equal(route, '/exchange'); entered(); await gate;
        return Response.json({ subject: 'discarded-b', refresh_token: 'discarded-fixture-refresh', refresh_expires_at: Math.floor(Date.now() / 1000) + 86400 });
      };
      await post(client, wb.accessToken, 'start');
      const callback = client.request('/private/lexiang/callback?state=' + state + '&code=fixture'); await waiting;
      assert.equal((await post(client, wb.accessToken, interrupt)).status, 200); release();
      assert.equal((await callback).status, 410);
      assert.equal(client.app.lexiang.auth.binding(client.app.store.getUser('tester').id), undefined);
      assert.equal(revoked, 1);
      assert.equal(await status(client, wb.accessToken), interrupt === 'start' ? 'pending' : 'not_connected');
    });
  }
});

test('a revoked WorkBuddy session cannot erase a surviving B grant when its in-flight refresh completes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lexiang-refresh-race-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = path.join(directory, 'bridge.key'); fs.writeFileSync(key, 'fixture-service-secret-32-characters-only', { mode: 0o600 });
  const client = await startGateway(t, { config: { lexiang: { mode: 'bridge', webOrigin: 'https://knowledge.customer.test', bridgeOrigin: 'http://127.0.0.1:10001', bridgeSecretFile: key, mcpUrl: 'http://127.0.0.1:10001/mcp' } } }), wb = await completeLogin(client);
  const user = client.app.store.getUser('tester'), session = client.app.store.sessionForAccessToken(wb.accessToken);
  const grant = { subject: 'member-b', refresh_token: 'old-fixture-refresh', refresh_expires_at: Math.floor(Date.now() / 1000) + 86400 };
  const binding = client.app.lexiang.auth.saveBinding(user.id, grant, 'bridge');
  let entered, release; const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  client.app.lexiang.request = async () => { entered(); await gate; return Response.json({ ...grant, refresh_token: 'rotated-fixture-refresh', access_token: 'fixture-access', expires_at: Math.floor(Date.now() / 1000) + 120 }); };
  const refresh = client.app.lexiang.delegatedToken(user, session, true); const rejected = assert.rejects(refresh, /WorkBuddy 会话已失效/);
  await waiting; client.app.store.revokeUserSessions('tester');
  const fresh = await completeLogin(client); release(); await rejected;
  const current = client.app.lexiang.auth.binding(user.id);
  assert.equal(current.id, binding.id); assert.equal(client.app.lexiang.auth.refreshToken(current), 'rotated-fixture-refresh');
  assert.equal(await status(client, fresh.accessToken), 'connected');
  assert.equal((await access(client, fresh.accessToken)).access_token, 'fixture-access');
});

test('authorization HTML submits in place with a pinned script and preserves the consent submitter action', async t => {
  const client = await startGateway(t, { config: { lexiang: { mode: 'mock' } } }), wb = await completeLogin(client);
  const pending = await beginLexiangAuthorization(client, wb.accessToken);
  const response = await fetch(pending.start.authorize_url, { headers: { Cookie: pending.cookie } });
  const html = await response.text(), script = /<script>([\s\S]+)<\/script>/.exec(html)?.[1];
  assert.ok(script); assert.ok(response.headers.get('content-security-policy').includes("'sha256-" + createHash('sha256').update(script).digest('base64') + "'"));
  assert.match(script, /event\.preventDefault\(\)/); assert.match(script, /form\.getAttribute\('action'\)/); assert.match(script, /event\.submitter\.value/);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
});
