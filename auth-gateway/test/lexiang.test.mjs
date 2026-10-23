import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { startGateway, completeLogin, startLogin, submitLogin, testConfig, TEST_PASSWORD } from './helpers.mjs';
import { createGateway } from '../src/gateway.mjs';
import { hashPassword } from '../src/credentials.mjs';
import { normalizeLexiangClient, rewriteLexiangUrl, normalizeLexiangTarget } from '../src/lexiang-config.mjs';
import { lexiangRoutingScript } from '../src/runtime-lexiang.mjs';
import { buildClientProduct } from '../src/client-profile.mjs';
import { readLexiangConfig } from '../src/lexiang-http.mjs';
import { authorizeMock } from './lexiang-helpers.mjs';

async function completeLinkedLogin(client) {
  const auth = await completeLogin(client); await authorizeMock(client, auth.accessToken); return auth;
}

const oauth = '/v2/as/connector/oauth/lexiang-ol/';
const get = async (client, token, route) => {
  const response = await client.request(route, { headers: { Authorization: `Bearer ${token}` } });
  return { response, value: await response.json() };
};
const post = (client, token, route, body) => client.request(route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('private Lexiang validates persisted public settings, rewrites only known web hosts, and leaves model endpoints alone', () => {
  const lexiang = { enabled: true, webOrigin: 'https://knowledge.example.test', mcpOrigin: 'https://mcp.example.test' };
  const product = buildClientProduct({ models: [], productFeatures: {}, privateHost: { docHost: 'https://docs.example.test' } }, 'https://auth.example.test', { lexiang });
  assert.equal(product.privateHost.lexiangHost, lexiang.webOrigin); assert.equal(product.privateHost.docHost, 'https://docs.example.test');
  assert.equal(product.productFeatures.TencentLexiangKnowledge, true); assert.equal(product.config.disabled, true);
  for (const webOrigin of ['http://intranet.example.test', 'https://user:pass@example.test', 'https://host.example/lexiang', 'https://host.example/?token=x']) assert.throws(() => normalizeLexiangClient({ webOrigin }));
  assert.throws(() => normalizeLexiangClient({ ...lexiang, accessToken: 'never-in-client-config' }), /凭据/);
  assert.equal(rewriteLexiangUrl('https://lexiangla.com/pages/id?company_from=public&access_token=old&ui_space_sidebar=0', lexiang.webOrigin), 'https://knowledge.example.test/pages/id?ui_space_sidebar=0');
  assert.equal(rewriteLexiangUrl('https://lexiangla.com/pages/id#access_token=old', lexiang.webOrigin), 'https://knowledge.example.test/pages/id');
  assert.equal(normalizeLexiangTarget('https://knowledge.example.test/pages/id#access_token=old', lexiang.webOrigin), 'https://knowledge.example.test/pages/id');
  for (const url of ['http://127.0.0.1:11434/v1', 'https://model.example.test/v1', 'https://lexiangla.com.attacker.test/path', 'javascript:alert(1)']) assert.equal(rewriteLexiangUrl(url, lexiang.webOrigin), url);
  assert.throws(() => normalizeLexiangTarget('https://attacker.example.test/page', lexiang.webOrigin), /不在配置/);
  assert.throws(() => normalizeLexiangTarget('invalid', lexiang.webOrigin), /无效/);
  assert.throws(() => readLexiangConfig({ publicUrl: 'https://public.example.test', lexiang: { mode: 'mock' } }), /回环/);
});

test('password login, native directories, search and MCP use the authenticated account with separate scoped tokens', async t => {
  const client = await startGateway(t, { config: { lexiang: { mode: 'mock' } } });
  assert.equal((await client.request(oauth + 'status')).status, 401);
  const auth = await completeLinkedLogin(client), status = await get(client, auth.accessToken, oauth + 'status');
  assert.equal(status.value.data.status, 'connected');
  const delegated = (await get(client, auth.accessToken, oauth + 'accesstoken')).value.data;
  assert.notEqual(delegated.access_token, auth.accessToken);
  assert.equal(delegated.expires_at, delegated.expire_at);
  assert.equal((await get(client, auth.accessToken, '/spapi/team/v1/frequent-teams')).response.status, 401);
  const personal = (await get(client, delegated.access_token, '/spapi/kb/space/v1/spaces/personal')).value.data.space;
  const children = (await get(client, delegated.access_token, `/spapi/kb/entry/v1/entries/${personal.root_entry_id}/children`)).value.data;
  assert.equal(children.entries.length, 2); assert.ok(children.entries.every(entry => entry.space_id === personal.id));
  const search = await (await post(client, delegated.access_token, '/spapi/search/v1/kb/search', { keyword: '重启', type: 'entry', space_id: personal.id })).json();
  assert.equal(search.data.docs.length, 1); assert.equal(search.data.docs[0].title, '重启恢复检查');
  const mcp = await (await post(client, auth.accessToken, '/console/agent-gateway/lexiang-ol/mcp', { id: 7, method: 'tools/call', params: { name: 'call_rpc', arguments: { tool_name: 'entry_list_example_space_entries', arguments: {} } } })).json();
  assert.equal(mcp.id, 7); assert.ok(JSON.parse(mcp.result.content[0].text).data.spaces[0].root_entry_id);
  const configuration = (await get(client, auth.accessToken, '/private/lexiang/config')).value.data.client;
  assert.equal(configuration.webOrigin, client.config.publicUrl);
  assert.deepEqual((await (await client.request('/v3/config')).json()).data.models, []);
  assert.equal((await post(client, auth.accessToken, '/v1/chat/completions', {})).status, 501);
  assert.ok(client.logs.every(item => !JSON.stringify(item).includes(auth.accessToken) && !JSON.stringify(item).includes(delegated.access_token)));
});

test('preview tickets are one-use, isolated by account, and all Mock access stops on administrator release', async t => {
  const client = await startGateway(t, { config: { lexiang: { mode: 'mock' } } });
  const auth = await completeLinkedLogin(client);
  const delegated = (await get(client, auth.accessToken, oauth + 'accesstoken')).value.data.access_token;
  const space = (await get(client, delegated, '/spapi/kb/space/v1/spaces/personal')).value.data.space;
  const entries = (await get(client, delegated, `/spapi/kb/entry/v1/entries/${space.root_entry_id}/children`)).value.data.entries;
  for (const target of ['https://attacker.example.test/a', client.config.publicUrl + '/login', 'https://user:pass@lexiangla.com/pages/a']) assert.equal((await post(client, auth.accessToken, oauth + 'temp-login-url', { intend_url: target })).status, 400);
  const preview = await (await post(client, auth.accessToken, oauth + 'temp-login-url', { intend_url: 'https://lexiangla.com/pages/' + entries[0].id + '?ui_ai_panel=0&company_from=public' })).json();
  assert.equal(new URL(preview.data.login_url).origin, client.config.publicUrl);
  const redeemed = await fetch(preview.data.login_url, { redirect: 'manual' });
  assert.equal(redeemed.status, 303); assert.ok(!redeemed.headers.get('location').includes('lexiangla.com'));
  const cookie = redeemed.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(preview.data.login_url, { redirect: 'manual' })).status, 401);
  const page = await client.request('/pages/' + entries[0].id, { headers: { Cookie: cookie } });
  assert.match(await page.text(), /本地 Mock 乐享/);
  client.app.store.addUser('second', '另一账号', await hashPassword(TEST_PASSWORD));
  const login = await startLogin(client); assert.equal((await submitLogin(client, login, { username: 'second' })).status, 303);
  const other = (await (await client.request('/v2/plugin/auth/token?state=' + login.state)).json()).data;
  await authorizeMock(client, other.accessToken, { username: 'knowledge-other', nickname: '另一乐享账号' });
  const otherToken = (await get(client, other.accessToken, oauth + 'accesstoken')).value.data.access_token;
  assert.deepEqual((await get(client, otherToken, `/spapi/kb/entry/v1/entries/${space.root_entry_id}/children`)).value.data.entries, []);
  assert.equal(client.app.store.revokeUserSessions('tester', { actor: 'test-admin' }), 1);
  assert.equal((await get(client, delegated, '/spapi/kb/space/v1/spaces/personal')).response.status, 401);
  assert.equal((await client.request('/pages/' + entries[0].id, { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await get(client, auth.accessToken, oauth + 'status')).response.status, 401);
  assert.equal((await get(client, otherToken, '/spapi/kb/space/v1/spaces/personal')).response.status, 200);
});

test('backend restart preserves primary login, delegated browser access and deterministic knowledge identifiers', async t => {
  const config = { ...testConfig(), lexiang: { mode: 'mock' } };
  let app = await createGateway(config);
  t.after(async () => { await app.close(); fs.rmSync(config.dataDir, { recursive: true, force: true }); });
  app.store.addUser('tester', '测试账号', await hashPassword(TEST_PASSWORD));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  config.publicUrl = `http://127.0.0.1:${app.server.address().port}`;
  const client = { config, app, request: (route, options) => fetch(config.publicUrl + route, options) };
  const auth = await completeLinkedLogin(client), token = (await get(client, auth.accessToken, oauth + 'accesstoken')).value.data.access_token;
  const space = (await get(client, token, '/spapi/kb/space/v1/spaces/personal')).value.data.space;
  const preview = await (await post(client, auth.accessToken, oauth + 'temp-login-url', { intend_url: client.config.publicUrl + '/wb' })).json();
  const page = await fetch(preview.data.login_url, { redirect: 'manual' }), cookie = page.headers.get('set-cookie').split(';')[0];
  await app.close();
  app = await createGateway(client.config); client.app = app;
  await new Promise(resolve => app.server.listen(Number(new URL(client.config.publicUrl).port), '127.0.0.1', resolve));
  assert.equal((await get(client, auth.accessToken, oauth + 'status')).value.data.status, 'connected');
  assert.equal((await get(client, token, '/spapi/kb/space/v1/spaces/personal')).value.data.space.id, space.id);
  assert.equal((await client.request('/wb', { headers: { Cookie: cookie } })).status, 200);
});

test('scoped search never includes personal entries in a team query or entries in unknown spaces', async t => {
  const client = await startGateway(t, { config: { lexiang: { mode: 'mock' } } }), auth = await completeLinkedLogin(client);
  const token = (await get(client, auth.accessToken, oauth + 'accesstoken')).value.data.access_token;
  const team = (await get(client, token, '/spapi/team/v1/frequent-teams')).value.data.teams[0];
  const query = async parameters => (await (await post(client, token, '/spapi/search/v1/kb/search', { keyword: '重启', type: 'entry', ...parameters })).json()).data.docs;
  const scoped = await query({ team_id: team.id });
  assert.equal(scoped.length, 1); assert.equal(scoped[0].team_id, team.id);
  assert.deepEqual(await query({ team_id: 'unknown' }), []);
  assert.deepEqual(await query({ space_id: 'unknown' }), []);
  const spaces = (await (await post(client, token, '/spapi/search/v1/kb/search', { keyword: '', type: 'space', team_id: team.id })).json()).data.docs;
  assert.equal(spaces.length, 1); assert.equal(spaces[0].team_id, team.id);
});

test('repeated previews reuse browser credentials rather than exhausting a valid session', async t => {
  const client = await startGateway(t, { config: { lexiang: { mode: 'mock' } } }), auth = await completeLinkedLogin(client);
  let cookie;
  for (let i = 0; i < 140; i++) {
    const preview = await (await post(client, auth.accessToken, oauth + 'temp-login-url', { intend_url: client.config.publicUrl + '/wb' })).json();
    const response = await fetch(preview.data.login_url, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
    assert.equal(response.status, 303);
    cookie = response.headers.get('set-cookie').split(';')[0];
  }
  assert.equal(client.app.store.db.prepare("SELECT count(*) AS n FROM lexiang_credentials WHERE kind='browser'").get().n, 1);
  assert.equal((await client.request('/wb', { headers: { Cookie: cookie } })).status, 200);
});

test('runtime navigation routing covers external links and future webviews and restores original methods on dispose', async () => {
  const app = new EventEmitter(); app.getAppPath = () => '/test/app.asar';
  const contents = new EventEmitter(); contents.id = 1; contents.isDestroyed = () => false;
  const loaded = [], opened = [], loadOptions = []; contents.loadURL = async (value, options) => { loaded.push(value); loadOptions.push(options); };
  const shell = { openExternal: async value => opened.push(value) }, original = shell.openExternal;
  const context = vm.createContext({ URL, Map, Symbol, console, process: { getBuiltinModule: () => ({ createRequire: () => () => ({ app, shell, webContents: { getAllWebContents: () => [contents] } }) }) } });
  vm.runInContext(lexiangRoutingScript('/test/app.asar', { webOrigin: 'http://127.0.0.1:8791' }), context);
  await shell.openExternal('https://lexiangla.com/s/overview?company_from=old');
  assert.equal(opened[0], 'http://127.0.0.1:8791/s/overview');
  const model = 'http://127.0.0.1:11434/v1'; await contents.loadURL(model); assert.equal(loaded.at(-1), model);
  await contents.loadURL('https://lexiangla.com/pages/old', { extraHeaders: 'Authorization: Bearer fixture-old', postData: [{ bytes: Buffer.from('old-credential') }], httpReferrer: 'https://lexiangla.com/?token=old', userAgent: 'fixture-agent' });
  assert.deepEqual(JSON.parse(JSON.stringify(loadOptions.at(-1))), { userAgent: 'fixture-agent' });
  const guest = new EventEmitter(); guest.id = 2; guest.isDestroyed = () => false; guest.loadURL = async value => loaded.push(value);
  app.emit('web-contents-created', {}, guest);
  let prevented = false; guest.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://lexiangla.com/pages/test');
  assert.equal(prevented, true); assert.equal(loaded.at(-1), 'http://127.0.0.1:8791/pages/test');
  const state = vm.runInContext('globalThis[Symbol.for("private.workbuddy.lexiang")]', context); assert.ok(state.snapshot().redirected >= 2);
  state.dispose(); assert.equal(shell.openExternal, original); assert.equal(app.listenerCount('web-contents-created'), 0);
});
