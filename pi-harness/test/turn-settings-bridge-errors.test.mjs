import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { startOfficialModelBridge } = createRequire(import.meta.url)('../src/official-model-bridge.cjs');

test('official bridge retains whitelisted nested overflow codes, preserves top-level priority and redacts provider messages', async t => {
  const root = realpathSync(mkdtempSync('/private/tmp/pi-overflow-code-')), bridgeDir = join(root, 'bridge');
  const session = { account: { uid: 'synthetic-error-user' }, auth: { accessToken: 'synthetic-error-auth' } };
  const product = { endpoint: 'https://www.workbuddy.cn', models: [{ id: 'fixture', supportsImages: false }] };
  let providerBody;
  const bridge = await startOfficialModelBridge({ bridgeDir,
    authenticationManager: { currentSessionSubject: { getValue: () => session, subscribe: () => ({ unsubscribe() {} }) }, waitForSessionRefresh: async () => {}, refreshSessionForAuthenticationFailure: async () => {} },
    productManager: { waitConfiguration: async () => product, getEndpoint: () => product.endpoint }, productEnvService: { getCurrent: async () => '' },
    restOperations: { request: async () => ({ status: 400, data: providerBody }) },
  });
  t.after(async () => { await bridge.close(); rmSync(root, { recursive: true, force: true }); });
  const locator = JSON.parse(readFileSync(join(bridgeDir, 'locator.json')));
  const cases = [
    [{ error: { code: 'context_length_exceeded', message: 'DO-NOT-EXPOSE-PROVIDER-MESSAGE' } }, 'context_length_exceeded'],
    [{ error: { code: 'model_context_window_exceeded', message: 'DO-NOT-EXPOSE-PROVIDER-MESSAGE' } }, 'model_context_window_exceeded'],
    [{ error: { code: 'request_too_large' } }, 'request_too_large'],
    [{ code: 'legacy-top-level', error: { code: 'context_length_exceeded' } }, 'legacy-top-level'],
    [{ code: 1261, error: { code: 'context_length_exceeded' } }, '1261'],
    [{ error: { code: 'DO-NOT-EXPOSE-UNKNOWN-CODE', message: 'DO-NOT-EXPOSE-PROVIDER-MESSAGE' } }, undefined],
  ];
  for (const [body, expected] of cases) {
    providerBody = body;
    const response = await fetch(`http://127.0.0.1:${locator.port}/v1/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${locator.ticket}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'Synthetic error mapping fixture' }] }) });
    assert.equal(response.status, 400); const result = await response.json();
    assert.equal(result.error.code, 'OFFICIAL_REQUEST_REJECTED'); assert.equal(result.error.upstreamCode, expected);
    assert.ok(!JSON.stringify(result).includes('DO-NOT-EXPOSE'));
  }
});
