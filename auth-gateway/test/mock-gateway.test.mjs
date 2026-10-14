import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockGateway } from '../src/mock-gateway.mjs';

test('loopback mock grants a CSRF-bound test login without passwords and supports account/refresh', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mock-test-'));
  const config = { dataDir, publicUrl: 'http://127.0.0.1:8787', accessTtlSeconds: 3600, refreshTtlSeconds: 86400, loginTtlSeconds: 300 };
  const app = await createMockGateway(config);
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  config.publicUrl = `http://127.0.0.1:${app.server.address().port}`;
  const stateResponse = await fetch(`${config.publicUrl}/v2/plugin/auth/state?platform=workbuddy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const state = (await stateResponse.json()).data;
  const page = await fetch(state.authUrl), text = await page.text();
  assert.match(text, /模拟登录/); assert.ok(!text.includes('type="password"'));
  assert.equal(page.headers.get('referrer-policy'), 'strict-origin');
  const cookie = page.headers.get('set-cookie').split(';')[0], csrf = /name="csrf" value="([^"]+)"/.exec(text)[1];
  let response = await fetch(`${config.publicUrl}/mock/login`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state: state.state, csrf }) });
  assert.equal(response.status, 403);
  response = await fetch(`${config.publicUrl}/mock/login`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: config.publicUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state: state.state, csrf: 'wrong' }) });
  assert.equal(response.status, 403);
  response = await fetch(`${config.publicUrl}/mock/login`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: config.publicUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state: state.state, csrf }) });
  assert.equal(response.status, 303);
  response = await fetch(`${config.publicUrl}/v2/plugin/auth/token?state=${state.state}`);
  const auth = (await response.json()).data;
  response = await fetch(`${config.publicUrl}/v2/plugin/account`, { headers: { Authorization: `Bearer ${auth.accessToken}` } });
  assert.equal((await response.json()).data.nickname, 'Mock 测试账号');
  response = await fetch(`${config.publicUrl}/v2/plugin/auth/token/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Refresh-Token': auth.refreshToken }, body: '{}' });
  assert.equal(response.status, 200);
});

test('mock refuses remote origins and existing real data directories', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mock-guard-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = { dataDir, publicUrl: 'https://auth.example.test', accessTtlSeconds: 3600, refreshTtlSeconds: 86400, loginTtlSeconds: 300 };
  await assert.rejects(createMockGateway(config), /loopback/);
  config.publicUrl = 'http://127.0.0.1:8787'; fs.writeFileSync(path.join(dataDir, 'gateway.sqlite'), 'existing-store-fixture');
  await assert.rejects(createMockGateway(config), /已有账号数据库/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'gateway.sqlite'), 'utf8'), 'existing-store-fixture');
});
