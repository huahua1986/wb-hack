import assert from 'node:assert/strict';

export const LEXIANG_TEST_PASSWORD = 'separate-lexiang-fixture-password';
export const LEXIANG_OAUTH = '/v2/as/connector/oauth/lexiang-ol/';
export const authHeaders = token => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
export async function beginLexiangAuthorization(client, token) {
  const response = await client.request(LEXIANG_OAUTH + 'start', { method: 'POST', headers: authHeaders(token), body: '{}' });
  assert.equal(response.status, 200);
  const start = (await response.json()).data; assert.equal(start.next_action, 'redirect');
  const page = await fetch(start.authorize_url), html = await page.text();
  assert.equal(page.status, 200);
  return { start, state: new URL(start.authorize_url).searchParams.get('state'), csrf: /name="csrf" value="([^"]+)"/.exec(html)[1], cookie: page.headers.get('set-cookie').split(';')[0], html };
}
export function submitLexiangAuthorization(client, authorization, fields) {
  return client.request('/private/lexiang/authorize', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: client.config.publicUrl, Cookie: authorization.cookie },
    body: new URLSearchParams({ state: authorization.state, csrf: authorization.csrf, ...fields }) });
}
export async function authorizeMock(client, token, { username = 'knowledge-tester', nickname = '独立乐享账号', password = LEXIANG_TEST_PASSWORD } = {}) {
  if (!client.app.lexiang.mock.account(username)) await client.app.lexiang.mock.addAccount(username, nickname, password);
  const authorization = await beginLexiangAuthorization(client, token);
  const loggedIn = await submitLexiangAuthorization(client, authorization, { action: 'login', username, password });
  assert.equal(loggedIn.status, 200); assert.match(await loggedIn.text(), /确认授权绑定/);
  const approved = await submitLexiangAuthorization(client, authorization, { action: 'approve' });
  assert.equal(approved.status, 200); assert.match(await approved.text(), /乐享授权完成/);
  return authorization;
}
