import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { normalizeOfficialCatalog } from '../src/official-bridge.mjs';
import { createOfficialProvider, OFFICIAL_THINKING_FIELD } from '../src/official-provider-extension.mjs';
import { thinkingOptionsForModel, normalizeThoughtLevel, thinkingLevelMapForModel, normalizePreMessageCompactPct,
  normalizeTurnSettings, buildRuntimeSettings, ensureTurnRuntime, parseTurnSettingsEnvironment, TURN_SETTINGS_ENV, TURN_SETTINGS_READY } from '../src/turn-settings.mjs';
import turnSettingsExtension from '../src/turn-settings-extension.mjs';
const { publicModel, applyOfficialThinking } = createRequire(import.meta.url)('../src/official-model-bridge.cjs');
const hy4 = { id: 'hy4', provider: 'workbuddy-official', api: 'openai-completions', contextWindow: 300000, maxTokens: 64000,
  reasoning: true, capabilities: { onlyReasoning: true, reasoning: { canDisableThinking: false, defaultEffort: 'high', supportedEfforts: ['high'], summary: 'auto' } } };
const glm = { ...hy4, id: 'glm-fixture', capabilities: { onlyReasoning: true, reasoning: { canDisableThinking: true, defaultEffort: 'high', supportedEfforts: ['low', 'high', 'max'] } } };
function temporary(t) { const p = realpathSync(mkdtempSync('/private/tmp/pi-turn-settings-')); t.after(() => rmSync(p, { recursive: true, force: true })); return p; }

test('native thinking aliases honor fixed native efforts and do not silently accept unsupported settings', () => {
  assert.deepEqual(thinkingOptionsForModel(hy4), { levels: ['high'], defaultLevel: 'high', canDisableThinking: false });
  for (const value of [undefined, null, '', 'enabled', 'high']) assert.equal(normalizeThoughtLevel(value, hy4), 'high');
  for (const value of ['off', 'disabled', 'low', 'medium', 'max']) assert.throws(() => normalizeThoughtLevel(value, hy4), { code: 'PI_THINKING_UNSUPPORTED' });
  assert.throws(() => normalizeThoughtLevel('bogus', hy4), { code: 'PI_THINKING_INVALID' });
  assert.deepEqual(thinkingOptionsForModel(glm).levels, ['off', 'low', 'high', 'max']);
  assert.equal(normalizeThoughtLevel('disabled', glm), 'off');
  const plain = { ...hy4, reasoning: false };
  assert.equal(normalizeThoughtLevel(undefined, plain), 'off');
  assert.throws(() => normalizeThoughtLevel('enabled', plain), { code: 'PI_THINKING_UNSUPPORTED' });
});
test('Pi capability map keeps native sparse levels and disables unsupported extended levels', () => {
  assert.deepEqual(thinkingLevelMapForModel(glm), { off: 'off', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' });
  assert.equal(thinkingLevelMapForModel(hy4).off, null);
});
test('native empty/zero/percentage values become exact Pi reserveTokens triggers', () => {
  for (const value of [undefined, null, '']) assert.equal(normalizePreMessageCompactPct(value), null);
  assert.equal(normalizePreMessageCompactPct('0'), 0); assert.equal(normalizePreMessageCompactPct('80.5'), 80.5);
  for (const value of [' ', 'NaN', 'Infinity', '0x10', '-1', -1, 101, {}, false]) assert.throws(() => normalizePreMessageCompactPct(value), { code: 'PI_COMPACTION_INVALID' });
  const defaults = normalizeTurnSettings({}, hy4); assert.equal(defaults.effectiveCompactPercent, 80); assert.equal(defaults.reserveTokens, 60000); assert.equal(defaults.keepRecentTokens, 20000);
  const large = normalizeTurnSettings({ preMessageCompactPct: '60' }, hy4, { contextWindow: 960000 });
  assert.equal(large.reserveTokens, 384000); assert.equal(large.contextWindow - large.reserveTokens, 576000);
  const maximum = normalizeTurnSettings({ preMessageCompactPct: 0 }, hy4);
  assert.equal(maximum.autoCompaction, true); assert.equal(maximum.preMessageCompaction, false); assert.equal(maximum.reserveTokens, 0);
  assert.equal(normalizeTurnSettings({ preMessageCompactPct: 100 }, hy4).reserveTokens, 0);
});
test('runtime settings isolate compaction overrides and do not copy account or executable configuration', () => {
  const value = buildRuntimeSettings({ baseSettings: { theme: 'light', retry: { enabled: false }, auth: { private: true }, apiKey: 'fixture-not-a-secret',
    extensions: ['untrusted'], mcpServers: { untrusted: {} }, compaction: { modelOverrides: { 'other/model': { reserveTokens: 1 } } } }, model: hy4, settings: { preMessageCompactPct: 70 } });
  assert.equal(value.settings.compaction.reserveTokens, 90000);
  assert.deepEqual(Object.keys(value.settings.compaction.modelOverrides), ['workbuddy-official/hy4']);
  for (const key of ['auth', 'apiKey', 'extensions', 'mcpServers']) assert.ok(!Object.hasOwn(value.settings, key));
  assert.equal(value.settings.defaultThinkingLevel, 'high'); assert.equal(value.settings.retry.enabled, false);
});
test('per-thread runtime files are private, independent, restart-readable and never write shared settings', t => {
  const root = temporary(t), shared = join(root, 'agent'); mkdirSync(shared, { mode: 0o700 });
  writeFileSync(join(shared, 'settings.json'), '{"preserve":"shared"}');
  const one = ensureTurnRuntime({ stateDir: root, threadId: 'pi-thread-00000000-0000-4000-8000-000000000001', model: hy4, settings: { preMessageCompactPct: 65 } });
  const two = ensureTurnRuntime({ stateDir: root, threadId: 'pi-thread-00000000-0000-4000-8000-000000000002', model: glm, settings: { thoughtLevel: 'disabled', preMessageCompactPct: 0 } });
  assert.notEqual(one.agentDir, two.agentDir); assert.equal(lstatSync(one.agentDir).mode & 0o077, 0); assert.equal(lstatSync(one.settingsFile).mode & 0o077, 0);
  assert.equal(JSON.parse(readFileSync(one.settingsFile)).compaction.enabled, true); assert.equal(JSON.parse(readFileSync(two.settingsFile)).compaction.enabled, true);
  assert.equal(JSON.parse(readFileSync(two.settingsFile)).compaction.reserveTokens, 0); assert.equal(two.effective.preMessageCompaction, false);
  assert.equal(readFileSync(join(shared, 'settings.json'), 'utf8'), '{"preserve":"shared"}');
  assert.equal(parseTurnSettingsEnvironment(one.extensionValue).thinkingLevel, 'high');
  assert.equal(parseTurnSettingsEnvironment(two.extensionValue).thinkingLevel, 'off');
});
test('runtime directories refuse symlink substitution and invalid thread identities', t => {
  const root = temporary(t), other = temporary(t); symlinkSync(other, join(root, 'runtimes'));
  assert.throws(() => ensureTurnRuntime({ stateDir: root, threadId: 'pi-thread-00000000-0000-4000-8000-000000000001', model: hy4 }), { code: 'PI_SETTINGS_PATH_INVALID' });
  assert.throws(() => ensureTurnRuntime({ stateDir: root, threadId: '../outside', model: hy4 }), { code: 'PI_SETTINGS_PATH_INVALID' });
});
test('controlled settings extension verifies actual merged settings and actual thinking state before announcing readiness', () => {
  const runtime = buildRuntimeSettings({ model: hy4 }), env = process.env[TURN_SETTINGS_ENV];
  process.env[TURN_SETTINGS_ENV] = JSON.stringify({ version: 1, provider: hy4.provider, modelId: hy4.id, ...runtime.effective });
  try {
    const handlers = {}; let level = 'off', notified;
    const pi = { on: (name, callback) => { handlers[name] = callback; }, getSettings: () => runtime.settings,
      setThinkingLevel: value => { level = value; }, getThinkingLevel: () => level };
    turnSettingsExtension(pi); handlers.session_start({}, { mode: 'rpc', ui: { notify: message => { notified = message; } } });
    assert.equal(level, 'high'); assert.equal(notified, TURN_SETTINGS_READY);
    pi.getSettings = () => ({ compaction: { enabled: false } });
    assert.throws(() => handlers.session_start({}, { mode: 'rpc', ui: { notify() {} } }), /PI_SETTINGS_NOT_APPLIED/);
  } finally { if (env === undefined) delete process.env[TURN_SETTINGS_ENV]; else process.env[TURN_SETTINGS_ENV] = env; }
});
test('native zero-percent cancels only threshold compaction and preserves manual/overflow recovery hooks', () => {
  const runtime = buildRuntimeSettings({ model: hy4, settings: { preMessageCompactPct: 0 } }), previous = process.env[TURN_SETTINGS_ENV];
  process.env[TURN_SETTINGS_ENV] = JSON.stringify({ version: 1, provider: hy4.provider, modelId: hy4.id, ...runtime.effective });
  try {
    const handlers = {}; turnSettingsExtension({ on: (name, callback) => { handlers[name] = callback; } });
    assert.deepEqual(handlers.session_before_compact({ reason: 'threshold' }), { cancel: true });
    assert.equal(handlers.session_before_compact({ reason: 'manual' }), undefined);
    assert.equal(handlers.session_before_compact({ reason: 'overflow' }), undefined);
  } finally { if (previous === undefined) delete process.env[TURN_SETTINGS_ENV]; else process.env[TURN_SETTINGS_ENV] = previous; }
});
test('reasoning metadata survives official directory normalization without exporting arbitrary provider fields', () => {
  const raw = { id: 'hy4', supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: false, defaultEffort: 'high', supportedEfforts: ['high'], summary: 'auto', privateConfig: 'not-exported' } };
  const row = publicModel(raw, {}, {}), [model] = normalizeOfficialCatalog({ data: [row] });
  assert.equal(model.capabilities.reasoning.defaultEffort, 'high'); assert.deepEqual(model.capabilities.reasoning.supportedEfforts, ['high']);
  assert.equal(model.thinkingLevelMap.off, null); assert.equal(model.thinkingLevelMap.high, 'high');
  assert.ok(!JSON.stringify(model).includes('privateConfig'));
});
test('official bridge converts local thinking control to standard API payload and enforces actual model efforts', () => {
  const model = { id: 'hy4', supportsReasoning: true, onlyReasoning: true, reasoning: hy4.capabilities.reasoning };
  const base = { model: model.id, messages: [], [OFFICIAL_THINKING_FIELD]: 'high' };
  const chat = applyOfficialThinking(base, model, 'chat-completions'); assert.equal(chat.reasoning_effort, 'high'); assert.ok(!Object.hasOwn(chat, OFFICIAL_THINKING_FIELD));
  const response = applyOfficialThinking({ ...base, input: [] }, model, 'responses'); assert.deepEqual(response.reasoning, { effort: 'high', summary: 'auto' });
  for (const level of ['low', 'off', 'max']) assert.throws(() => applyOfficialThinking({ ...base, [OFFICIAL_THINKING_FIELD]: level }, model, 'chat-completions'), { code: 'MODEL_THINKING_UNSUPPORTED' });
  const untouched = { model: 'legacy', messages: [] }; assert.equal(applyOfficialThinking(untouched, model, 'chat-completions'), untouched);
});
test('official provider carries the effective engine level and preserves reasoning/tool/lifecycle callbacks', async t => {
  const root = temporary(t), locator = { version: 1, port: 32123, pid: process.pid, ticket: 'fixture-only-local-ticket', expiresAt: Date.now() + 60000 };
  writeFileSync(join(root, 'locator.json'), JSON.stringify(locator), { mode: 0o600 });
  let captured;
  const bridge = { models: async () => [hy4, glm], fetch() {} };
  const provider = await createOfficialProvider({ directory: root, bridge, streamSimple: (model, context, options) => { captured = options; return 'stream'; } });
  assert.equal(provider.streamSimple(hy4, {}, { reasoning: 'high', onPayload: value => ({ ...value, custom: true }) }), 'stream');
  assert.deepEqual(await captured.onPayload({ model: 'hy4' }, hy4), { model: 'hy4', custom: true, [OFFICIAL_THINKING_FIELD]: 'high' });
  provider.streamSimple(glm, {}, {});
  assert.equal((await captured.onPayload({ model: glm.id }, glm))[OFFICIAL_THINKING_FIELD], 'off');
});
