import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readPiConfig } from '../src/config.mjs';
import { OfficialBridgeClient, createOfficialFetch, normalizeOfficialCatalog, readOfficialLocator, applyOfficialContextWindows } from '../src/official-bridge.mjs';
import { createOfficialProvider } from '../src/official-provider-extension.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-official-fixture-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bridgeDir = join(root, 'bridge'); mkdirSync(bridgeDir, { mode: 0o700 });
  const locator = { version: 1, port: 49123, pid: process.pid, ticket: 'fixture-only-local-ticket-0000000001', expiresAt: Date.now() + 600_000 };
  const save = values => { Object.assign(locator, values); writeFileSync(join(bridgeDir, 'locator.json'), JSON.stringify(locator), { mode: 0o600 }); };
  save({});
  return { root, bridgeDir, locator, save };
}
const rows = [
  { id: 'hy4', name: 'HY 4', api: 'openai-completions', contextWindow: 32768, maxTokens: 2048, reasoning: true, input: ['text'], supportsToolCall: true },
  { id: 'response-model', name: 'Responses', api: 'openai-responses', supportsToolCall: false },
  { id: 'denied', name: 'Denied', api: 'openai-completions', disabled: true, disabledReason: '请先获得官方权益' },
];
const jsonResponse = data => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

test('official config has safe defaults and rejects foreign providers without breaking legacy config', t => {
  const { root } = fixture(t), filename = join(root, 'pi.json');
  const base = { command: process.execPath, cwd: root, stateDir: 'state', agentDir: 'agent', officialOnly: true, officialBridgeDir: 'bridge' };
  writeFileSync(filename, JSON.stringify(base));
  const parsed = readPiConfig(filename);
  assert.equal(parsed.provider, 'workbuddy-official'); assert.equal(parsed.model, 'hy4');
  assert.equal(parsed.officialBridgeDir, join(root, 'bridge'));
  for (const extra of [{ provider: 'ollama' }, { officialOnly: 'yes' }, { officialBridgeDir: undefined }, { officialOnly: false }]) {
    writeFileSync(filename, JSON.stringify({ ...base, ...extra })); assert.throws(() => readPiConfig(filename));
  }
  writeFileSync(filename, JSON.stringify({ command: process.execPath, cwd: root, stateDir: 'legacy-state', agentDir: 'legacy-agent', provider: 'ollama', model: 'old-model' }));
  assert.equal(readPiConfig(filename).provider, 'ollama');
});

test('locator requires a private same-owner regular file and a finite unexpired local capability', t => {
  const { bridgeDir, locator, save, root } = fixture(t);
  assert.equal(readOfficialLocator(bridgeDir).port, locator.port);
  save({ expiresAt: new Date(Date.now() + 10_000).toISOString() }); assert.equal(typeof readOfficialLocator(bridgeDir).expiresAt, 'number');
  save({ expiresAt: Date.now() - 1 }); assert.throws(() => readOfficialLocator(bridgeDir), { code: 'OFFICIAL_BRIDGE_UNAVAILABLE' });
  save({ expiresAt: Date.now() + 600_000, ticket: 'bad\nheader-xxxxxxxxxxxx' }); assert.throws(() => readOfficialLocator(bridgeDir));
  save({ ticket: 'fixture-safe-ticket-xxxxxxxx', port: 443 });
  chmodSync(join(bridgeDir, 'locator.json'), 0o644); assert.throws(() => readOfficialLocator(bridgeDir));
  chmodSync(join(bridgeDir, 'locator.json'), 0o600);
  symlinkSync(bridgeDir, join(root, 'link')); assert.throws(() => readOfficialLocator(join(root, 'link')));
});

test('catalog only carries safe metadata and preserves disabled model boundaries', () => {
  const models = normalizeOfficialCatalog({ data: rows.map(row => ({ ...row, accessToken: 'not-an-actual-token', apiKey: 'not-an-actual-key', url: 'https://private.example' })) });
  assert.equal(models.length, 3);
  assert.equal(models[0].provider, 'workbuddy-official'); assert.equal(models[0].pricingKnown, false);
  assert.equal(models[2].disabled, true); assert.equal(models[2].disabledReason, '请先获得官方权益');
  assert.equal(JSON.stringify(models).includes('not-an-actual'), false);
  assert.equal(JSON.stringify(models).includes('private.example'), false);
  for (const data of [[{ id: 'bad', api: 'aicc' }], [...rows, rows[0]], []]) assert.throws(() => normalizeOfficialCatalog({ data }));
});

test('loopback fetch rotates a ticket once on 401, attaches normalized request IDs, and never forwards caller Authorization', async t => {
  const { root, bridgeDir, save, locator } = fixture(t);
  const contextFile = join(root, 'request.json');
  const context = { threadId: `pi-thread-${randomUUID()}`, turnId: `pi-turn-${randomUUID()}` };
  writeFileSync(contextFile, JSON.stringify(context), { mode: 0o600 });
  const calls = [];
  const localFetch = createOfficialFetch(bridgeDir, { requestContextFile: contextFile, fetchImpl: async (url, init) => {
    calls.push({ url, headers: init.headers, body: Buffer.from(init.body ?? '').toString() });
    if (calls.length === 1) { save({ ticket: 'fixture-only-rotated-ticket-00000002', port: 49124 }); return new Response('', { status: 401 }); }
    return jsonResponse({ accepted: true });
  } });
  assert.equal((await localFetch('http://127.0.0.1:1/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer must-not-forward' }, body: '{"model":"hy4"}' })).status, 200);
  assert.equal(calls.length, 2); assert.equal(calls[1].url, 'http://127.0.0.1:49124/v1/chat/completions');
  assert.equal(calls[1].headers.get('authorization'), `Bearer ${locator.ticket}`);
  assert.equal(calls[1].headers.get('x-workbuddy-pi-thread-id'), context.threadId);
  assert.equal(calls[1].headers.get('x-workbuddy-pi-turn-id'), context.turnId);
  assert.equal(calls[1].body, '{"model":"hy4"}');
  await assert.rejects(() => localFetch('https://public.example/v1/chat/completions'), { code: 'OFFICIAL_ENDPOINT_REJECTED' });
  await assert.rejects(() => localFetch('http://127.0.0.1:1/private'), { code: 'OFFICIAL_ENDPOINT_REJECTED' });
});

test('unchanged 401 is not replayed and auth/forbidden catalog responses are safe', async t => {
  const { bridgeDir } = fixture(t);
  for (const [status, code] of [[401, 'OFFICIAL_AUTH_REQUIRED'], [403, 'OFFICIAL_MODEL_FORBIDDEN']]) {
    let calls = 0;
    const bridge = new OfficialBridgeClient(bridgeDir, { fetchImpl: async () => { calls++; return new Response('raw-private-auth-error', { status }); } });
    await assert.rejects(() => bridge.models({ waitMs: 0 }), { code });
    assert.equal(calls, 1);
  }
});

test('catalog waits briefly for startup and preserves actual cancellation', async t => {
  const { bridgeDir } = fixture(t);
  let calls = 0;
  const bridge = new OfficialBridgeClient(bridgeDir, { fetchImpl: async () => { calls++; if (calls === 1) throw Error('connect'); return jsonResponse({ data: rows }); } });
  assert.equal((await bridge.models({ waitMs: 500 })).length, 3); assert.equal(calls, 2);
  const controller = new AbortController();
  const localFetch = createOfficialFetch(bridgeDir, { fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  }) });
  const request = localFetch('http://127.0.0.1:1/v1/responses', { method: 'POST', body: '{}', signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(request, { code: 'OFFICIAL_REQUEST_ABORTED' });
});

test('native provider selects each standard API, preserves lifecycle callbacks and honors no-tool models', async t => {
  const { bridgeDir, locator } = fixture(t), seen = [];
  const localFetch = async () => jsonResponse({});
  const bridge = { fetch: localFetch, models: async () => normalizeOfficialCatalog({ data: rows }) };
  const provider = await createOfficialProvider({ directory: bridgeDir, bridge, streamSimple: (model, context, options) => { seen.push({ model, context, options }); return 'fixture-stream'; } });
  assert.equal(provider.id, 'workbuddy-official');
  assert.equal(provider.getModels().length, 3); assert.equal(provider.filterModels(provider.getModels()).length, 2);
  assert.equal((await provider.auth.apiKey.resolve()).auth.apiKey, locator.ticket);
  const controller = new AbortController(), onResponse = () => {};
  assert.equal(provider.streamSimple(provider.getModels()[1], { messages: [] }, { signal: controller.signal, onResponse, onPayload: payload => ({ ...payload, replacement: true }) }), 'fixture-stream');
  const call = seen[0]; assert.equal(call.model.api, 'openai-responses'); assert.equal(call.options.fetch, localFetch);
  assert.equal(call.options.maxRetries, 0); assert.equal(call.options.signal, controller.signal); assert.equal(call.options.onResponse, onResponse);
  assert.deepEqual(await call.options.onPayload({ model: 'response-model', tools: [{}], tool_choice: 'auto', parallel_tool_calls: true }, call.model), { model: 'response-model', replacement: true });
});

test('each provider process applies only its own validated context windows without changing model IDs or the catalog', async t => {
  const { bridgeDir } = fixture(t);
  const catalog = normalizeOfficialCatalog({ data: [{ id: 'hy4', api: 'openai-completions', contextWindow: 300000,
    maxTokens: 64000, maxInputTokens: 960000, supportedContextWindows: [300000, 600000, 960000] }] });
  const before = structuredClone(catalog), bridge = { models: async () => catalog };
  const large = await createOfficialProvider({ directory: bridgeDir, bridge, contextWindows: { hy4: 960000 } });
  const normal = await createOfficialProvider({ directory: bridgeDir, bridge });
  assert.equal(large.getModels()[0].contextWindow, 960000); assert.equal(large.getModels()[0].id, 'hy4');
  assert.equal(normal.getModels()[0].contextWindow, 300000); assert.deepEqual(catalog, before);
  for (const selection of [{ hy4: 1000000 }, { hy4: '960000' }, [], null, { hy4: 0 }]) {
    assert.throws(() => applyOfficialContextWindows(catalog, selection), { code: 'OFFICIAL_CONTEXT_WINDOW_INVALID' });
  }
});
