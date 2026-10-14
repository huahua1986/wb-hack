import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { startGateway, TEST_PASSWORD } from './helpers.mjs';

test('original WorkBuddy 5.8 account-scoped provider interoperates with live local gateway', async t => {
  const client = await startGateway(t);
  const source = fs.readFileSync(new URL('./fixtures/AccountScopedExternalLinkAuthenticationProvider.js', import.meta.url), 'utf8');
  const trace = { requestHeaders: {}, startSpan() { return this; }, markAsSuccessful() {}, markAsFailed() {} };
  const context = vm.createContext({
    URL, setTimeout, clearTimeout, AbortController, process: { env: {} },
    SIGN_IN_PENDING_TIMEOUT: 300000, SIGN_IN_FETCH_INTERVAL: 1000,
    SPAN_OPEN_EXTERNAL_LINK: 'open', SPAN_GET_AUTH_STATE: 'state', SPAN_GET_AUTH_TOKEN: 'token', SPAN_GET_ACCOUNT: 'account',
    import_common$10: { wait: () => delay(5) },
    TimeoutError: class extends Error {}, CanceledError: class extends Error {}, SignError: class extends Error {}, UnauthorizedError: class extends Error {},
    AuthenticationType: { ACCOUNT_SCOPED_EXTERNAL_LINK: 'account-scoped-external-link' },
    addLoginSpanEvent() {}, hasHostLoginObservation: () => false,
    appendHostLoginJourneyParams() {}, getLoginDeviceNonce: () => undefined, appendLoginPageHintParams() {},
    alignAuthUrlToApiOrigin: url => url,
    resolveAuthApiOrigin: config => new URL(config.baseURL).origin,
    hasUsableAuthToken: value => typeof value?.accessToken === 'string' && !!value.accessToken,
    isLoginPollPending: (value, code) => value?.code === code,
    normalizeAccountAvatar: account => account,
    toSignLicenseError: () => undefined,
    HTTP_HEADER_DOMAIN: 'X-Domain',
    URI$1: { parse: value => ({ authority: new URL(value).host }) },
  });
  vm.runInContext(source, context, { filename: 'original-AccountScopedExternalLinkAuthenticationProvider.js' });
  const provider = vm.runInContext('new AccountScopedExternalLinkAuthenticationProvider()', context);
  const config = { endpoint: client.config.publicUrl, authentication: { type: 'account-scoped-external-link', attributes: { prefixPath: '/plugin', platform: 'workbuddy' } } };
  provider.configuration = config;
  provider.productManager = { getEndpoint: () => client.config.publicUrl, waitConfiguration: async () => config };
  provider.clientInfoProvider = { get: async () => ({ pluginVersion: '5.8.0-fixture' }) };
  provider.logger = { info() {}, warn() {}, error() {} };
  const send = async (method, url, payload, options = {}) => {
    const response = await client.request(url, { method, headers: { ...options.headers, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(payload || {}) } : {}) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error('Gateway request failed'), { isAxiosError: true, response: { status: response.status, data } });
    return { data, config: { url, baseURL: client.config.publicUrl } };
  };
  provider.restOperations = { post: (url, data, options) => send('POST', url, data, options), get: (url, options) => send('GET', url, undefined, options) };
  provider.externalUriOpener = {
    urlSubject: { subscribe: () => ({ unsubscribe() {} }) },
    async open(authUrl) {
      const response = await fetch(authUrl), page = await response.text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
      const state = new URL(authUrl).searchParams.get('state');
      const result = await client.request('/login', { method: 'POST', redirect: 'manual', headers: { Cookie: response.headers.get('set-cookie').split(';')[0], Origin: client.config.publicUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state, csrf, username: 'tester', password: TEST_PASSWORD }) });
      assert.equal(result.status, 303); return true;
    },
  };
  assert.equal(await provider.support({}), true);
  const signContext = { traceSpan: trace, abortController: new AbortController() };
  const session = await provider.createSession(signContext);
  assert.equal(session.account.username, 'tester');
  assert.equal(session.accounts.length, 1); assert.equal(session.allAccounts.length, 1);
  const refreshed = await provider.refreshSession(session, signContext);
  assert.ok(refreshed.auth.accessToken !== session.auth.accessToken);
  assert.equal(refreshed.account.uid, session.account.uid);
});
