import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { completeLogin, startGateway, startLogin, submitLogin, TEST_PASSWORD } from './helpers.mjs';
import { AuthStore } from '../src/store.mjs';
import { readConfig } from '../src/config.mjs';

test('WorkBuddy handshake, local account, refresh rotation, restart and logout', async t => {
  const client = await startGateway(t), login = await startLogin(client);
  let res = await client.request(`/v2/plugin/auth/token?state=${login.state}`);
  assert.equal((await res.json()).code, 11217);
  res = await submitLogin(client, login); assert.equal(res.status, 303);
  res = await client.request(`/v2/plugin/auth/token?state=${login.state}`);
  const auth = (await res.json()).data;
  assert.ok(auth.accessToken && auth.refreshToken && auth.expiresAt > Date.now());
  res = await client.request(`/v2/plugin/auth/token?state=${login.state}`); assert.equal(res.status, 410);
  res = await client.request('/v2/plugin/account', { headers: { Authorization: `Bearer ${auth.accessToken}`, 'X-User-Id': 'spoofed-user', 'X-Tenant-Id': 'spoofed-tenant' } });
  const account = (await res.json()).data;
  assert.equal(account.username, 'tester'); assert.equal(account.type, 'personal'); assert.equal(account.enterpriseId, undefined);
  assert.notEqual(account.uid, 'spoofed-user');
  const refresh = () => client.request('/v2/plugin/auth/token/refresh', { method: 'POST', headers: { 'X-Refresh-Token': auth.refreshToken, 'Content-Type': 'application/json' }, body: '{}' });
  const first = (await (await refresh()).json()).data, retry = (await (await refresh()).json()).data;
  assert.ok(first.accessToken !== auth.accessToken && first.refreshToken !== auth.refreshToken);
  assert.ok(first.accessToken === retry.accessToken && first.refreshToken === retry.refreshToken);
  const reopened = new AuthStore(client.config);
  try { assert.equal(reopened.account(first.accessToken).uid, account.uid); } finally { reopened.close(); }
  const database = fs.readFileSync(path.join(client.config.dataDir, 'gateway.sqlite'));
  const wal = fs.readFileSync(path.join(client.config.dataDir, 'gateway.sqlite-wal'));
  for (const secret of [TEST_PASSWORD, first.accessToken, first.refreshToken, auth.accessToken]) {
    assert.ok(!database.includes(Buffer.from(secret)) && !wal.includes(Buffer.from(secret)));
  }
  res = await client.request('/v2/plugin/auth/logout', { method: 'POST', headers: { 'X-Refresh-Token': first.refreshToken, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 200);
  res = await client.request('/v2/plugin/account', { headers: { Authorization: `Bearer ${first.accessToken}` } }); assert.equal(res.status, 401);
  assert.ok(!JSON.stringify(client.logs).includes(TEST_PASSWORD));
  assert.ok(!JSON.stringify(client.logs).includes(first.accessToken));
  assert.ok(client.logs.every(log => !log.route?.includes('?')));
});

test('bad password, missing CSRF and cross-origin submissions cannot grant a login', async t => {
  const client = await startGateway(t), login = await startLogin(client);
  const page = await client.request(`/login?state=${login.state}`);
  assert.equal(page.headers.get('referrer-policy'), 'strict-origin');
  let res = await submitLogin(client, login, { csrf: 'invalid' }); assert.equal(res.status, 403);
  res = await submitLogin(client, login, { password: 'incorrect' }); assert.equal(res.status, 401);
  res = await client.request('/login', { method: 'POST', headers: { Cookie: login.cookie, Origin: 'https://attacker.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state: login.state, csrf: login.csrf, username: 'tester', password: TEST_PASSWORD }) });
  assert.equal(res.status, 403);
  res = await client.request(`/v2/plugin/auth/token?state=${login.state}`); assert.equal((await res.json()).code, 11217);
  res = await submitLogin(client, login); assert.equal(res.status, 303);
});

test('expired login states, access tokens and old refresh replay fail closed', async t => {
  let now = Date.now();
  const client = await startGateway(t, { now: () => now }), login = await startLogin(client);
  now += 301000;
  let res = await client.request(`/v2/plugin/auth/token?state=${login.state}`); assert.equal(res.status, 410);
  const auth = await completeLogin(client);
  res = await client.request('/v2/plugin/auth/token/refresh', { method: 'POST', headers: { 'X-Refresh-Token': auth.refreshToken, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(res.status, 200);
  now += 11000;
  res = await client.request('/v2/plugin/auth/token/refresh', { method: 'POST', headers: { 'X-Refresh-Token': auth.refreshToken, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(res.status, 401);
  now += 3600000;
  res = await client.request('/v2/plugin/account', { headers: { Authorization: `Bearer ${auth.accessToken}` } }); assert.equal(res.status, 401);
});

test('password changes and disabling users revoke existing and pending sessions', async t => {
  const client = await startGateway(t), auth = await completeLogin(client);
  client.app.store.updateUser('tester', undefined, true);
  let res = await client.request('/v2/plugin/account', { headers: { Authorization: `Bearer ${auth.accessToken}` } }); assert.equal(res.status, 401);
  res = await client.request('/v2/plugin/auth/token/refresh', { method: 'POST', headers: { 'X-Refresh-Token': auth.refreshToken, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(res.status, 401);
  const login = await startLogin(client);
  res = await submitLogin(client, login); assert.equal(res.status, 401);
});

test('gateway exposes compatibility flags but no model catalogue or model proxy', async t => {
  const client = await startGateway(t);
  const data = (await (await client.request('/v3/config')).json()).data;
  assert.deepEqual(data.models, []);
  assert.equal(data.config.disabled, true);
  assert.equal(data.productFeatures.CustomModelsJSON, true);
  assert.equal(data.productFeatures.DisableCreditsEntry, true);
  assert.equal(data.productFeatures.TencentNetDriveKnowledge, false);
  assert.equal(data.productFeatures.DisableCloudAssistantUpgradeBanner, true);
  assert.equal(data.productFeatures.DisableTeamsProject, true);
  let res = await client.request('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":"auto"}' }); assert.equal(res.status, 501);
  res = await client.request('/v2/as/unknown'); assert.equal(res.status, 404);
  res = await client.request('/v2/plugin/account'); assert.equal(res.status, 401);
  res = await client.request('/v2/plugin/auth/state?platform=other', { method: 'POST', body: '{}' }); assert.equal(res.status, 400);
});

test('private branding uses the original authenticated product overlay without defining models', async t => {
  const client = await startGateway(t, { config: { productName: '企业AI工作台' } });
  const config = (await (await client.request('/v3/config')).json()).data;
  assert.deepEqual(config.models, []);
  assert.deepEqual(config.productFeatureExperiment, { enabled: true, pollingEnabled: false });
  const route = '/v2/feature-flag/api/product-config';
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
  assert.equal((await client.request(route, options)).status, 401);
  const auth = await completeLogin(client);
  options.headers.Authorization = `Bearer ${auth.accessToken}`;
  const response = await client.request(route, options);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { exp_id: 'private-product-branding', value: { productName: '企业AI工作台' } });
  const originalPost = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${auth.accessToken}` } };
  assert.equal((await client.request(route, originalPost)).status, 200);
  assert.equal((await client.request(route, { ...originalPost, body: 'x'.repeat(18000) })).status, 413);
  client.app.store.revoke(auth.refreshToken);
  assert.equal((await client.request(route, options)).status, 401);
});

test('branding survives backend restart config loading and rejects invalid names', async t => {
  const client = await startGateway(t);
  const filename = path.join(client.config.dataDir, 'product-branding.json');
  const env = { GATEWAY_DATA_DIR: client.config.dataDir };
  assert.equal(readConfig(env).productName, undefined);
  fs.writeFileSync(filename, JSON.stringify({ productName: '企业AI工作台' }));
  assert.equal(readConfig(env).productName, '企业AI工作台');
  assert.equal(readConfig(env).productName, '企业AI工作台');
  assert.equal(readConfig({ ...env, GATEWAY_PRODUCT_NAME: '临时名称' }).productName, '临时名称');
  for (const productName of [null, 123, ' ', 'x'.repeat(129), '名称\n换行']) {
    fs.writeFileSync(filename, JSON.stringify({ productName }));
    assert.throws(() => readConfig(env), /product name/);
  }
  fs.writeFileSync(filename, 'invalid JSON');
  assert.throws(() => readConfig(env), /product-branding/);
});

test('disabled drive returns an authenticated explicit failure without hiding auth or server errors', async t => {
  const client = await startGateway(t), auth = await completeLogin(client);
  const endpoint = '/console/as/netdrive/access-token';
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.accessToken}` }, body: '{}' };
  let res = await client.request(endpoint, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  for (const route of [endpoint, '/console/as/netdrive/projects/test-project/access-token']) {
    res = await client.request(route, options);
    assert.equal(res.status, 501);
    assert.deepEqual(await res.json(), { code: 'NETDRIVE_DISABLED', msg: '当前服务未启用云端网盘', data: null });
  }
  res = await client.request(endpoint, { ...options, body: 'invalid' }); assert.equal(res.status, 400);
  res = await client.request('/console/as/netdrive/upload/apply', options); assert.equal(res.status, 404);
  const originalAccount = client.app.store.account;
  client.app.store.account = () => { throw new Error('test database unavailable'); };
  try {
    res = await client.request(endpoint, options); assert.equal(res.status, 500);
    assert.equal((await res.json()).msg, '服务暂不可用');
  } finally { client.app.store.account = originalAccount; }
  client.app.store.revoke(auth.refreshToken);
  res = await client.request(endpoint, options); assert.equal(res.status, 401);
});

test('oversized JSON and repeated bad passwords are rejected', async t => {
  const client = await startGateway(t), login = await startLogin(client);
  let res = await client.request('/v2/plugin/auth/state?platform=workbuddy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'x'.repeat(18000) }) }); assert.equal(res.status, 413);
  for (let index = 0; index < 10; index++) { res = await submitLogin(client, login, { password: 'incorrect' }); assert.equal(res.status, 401); }
  res = await submitLogin(client, login); assert.equal(res.status, 429);
});
