import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../src/gateway.mjs';
import { hashPassword } from '../src/credentials.mjs';

export const TEST_PASSWORD = 'only-for-local-test-fixture';
export function testConfig() {
  return { publicUrl: 'http://127.0.0.1:8787', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auth-test-')),
    accessTtlSeconds: 3600, refreshTtlSeconds: 1209600, loginTtlSeconds: 300 };
}

export async function startGateway(t, { now = Date.now, config: overrides = {} } = {}) {
  const config = { ...testConfig(), ...overrides }, logs = [];
  const app = await createGateway(config, { now, logger: entry => logs.push(entry) });
  t.after(async () => { await app.close(); fs.rmSync(config.dataDir, { recursive: true, force: true }); });
  app.store.addUser('tester', '测试账号', await hashPassword(TEST_PASSWORD));
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  config.publicUrl = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, options = {}) => fetch(config.publicUrl + route, options);
  return { app, config, logs, request };
}

export async function startLogin(client) {
  const res = await client.request('/v2/plugin/auth/state?platform=workbuddy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = (await res.json()).data;
  const page = await fetch(data.authUrl), text = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(text)?.[1];
  const cookie = page.headers.get('set-cookie').split(';')[0];
  return { state: data.state, csrf, cookie, authUrl: data.authUrl };
}

export function submitLogin(client, login, overrides = {}) {
  return client.request('/login', { method: 'POST', redirect: 'manual', headers: {
    'Content-Type': 'application/x-www-form-urlencoded', Cookie: login.cookie, Origin: client.config.publicUrl,
  }, body: new URLSearchParams({ state: login.state, csrf: login.csrf, username: 'tester', password: TEST_PASSWORD, ...overrides }) });
}

export async function completeLogin(client) {
  const login = await startLogin(client);
  const response = await submitLogin(client, login);
  if (response.status !== 303) throw new Error('Fixture login failed');
  const poll = await client.request(`/v2/plugin/auth/token?state=${login.state}`);
  return (await poll.json()).data;
}
