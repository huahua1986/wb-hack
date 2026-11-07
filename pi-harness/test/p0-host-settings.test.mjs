import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PiHarness } from '../src/pi-harness.mjs';
import { OFFICIAL_READY, normalizeOfficialCatalog } from '../src/official-bridge.mjs';
import { TURN_SETTINGS_READY, TURN_SETTINGS_ENV } from '../src/turn-settings.mjs';

const catalogue = [
  { id: 'hy4', name: 'Synthetic Hy4', api: 'openai-completions', reasoning: true, contextWindow: 300000, maxTokens: 64000,
    maxInputTokens: 960000, supportedContextWindows: [300000, 600000, 960000],
    capabilities: { onlyReasoning: true, reasoning: { defaultEffort: 'high', supportedEfforts: ['high'], canDisableThinking: false } } },
  { id: 'glm', name: 'Synthetic sparse reasoning', api: 'openai-completions', reasoning: true, contextWindow: 64000, maxTokens: 8192,
    maxInputTokens: 128000, supportedContextWindows: [64000, 128000],
    capabilities: { onlyReasoning: true, reasoning: { defaultEffort: 'high', supportedEfforts: ['low', 'high', 'max'], canDisableThinking: true } } },
  { id: 'plain', name: 'Synthetic plain model', api: 'openai-completions', contextWindow: 32768, maxTokens: 4096, reasoning: false },
];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let n = 0; n < 100; n++) { if (predicate()) return; await tick(); } throw Error('Synthetic Host operation did not reach expected boundary'); }
class SettingsClient extends EventEmitter {
  constructor(options) { super(); this.options = options; this.prompts = []; this.compactCalls = []; this.modelCalls = []; this.closed = false; this.next = 0; }
  get sessionFile() { return this.options.args[this.options.args.indexOf('--session') + 1]; }
  async start() {
    if (this.options.args.some(value => /official-provider-extension\.(?:ts|mjs)$/.test(value))) this.emit('event', { type: 'extension_ui_request', method: 'notify', message: OFFICIAL_READY });
    if (!this.suppressSettingsReady && this.options.args.some(value => /turn-settings-extension\.mjs$/.test(value))) this.emit('event', { type: 'extension_ui_request', method: 'notify', message: TURN_SETTINGS_READY });
  }
  async getState() {
    const modelId = this.options.args[this.options.args.indexOf('--model') + 1];
    return { isStreaming: false, thinkingLevel: this.options.args[this.options.args.indexOf('--thinking') + 1],
      model: { ...catalogue.find(model => model.id === modelId), provider: 'workbuddy-official' } };
  }
  async setModel(provider, id) { this.modelCalls.push({ provider, id }); if (this.modelGate) await this.modelGate.promise; return { id, provider }; }
  async getSessionStats() { return { contextUsage: { tokens: null, contextWindow: 300000, percent: null } }; }
  async prompt(message) {
    this.prompts.push(message);
    if (!existsSync(this.sessionFile)) writeFileSync(this.sessionFile, JSON.stringify({ type: 'session', version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: this.options.cwd }) + '\n', { mode: 0o600 });
    appendFileSync(this.sessionFile, JSON.stringify({ type: 'message', id: `user-${++this.next}`, parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: message }] } }) + '\n');
    return { disposition: 'started' };
  }
  finish() {
    this.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'SYNTHETIC_SETTINGS_ANSWER' }], stopReason: 'stop' } });
    this.emit('event', { type: 'agent_settled', aborted: false });
  }
  async compact(options) {
    this.compactCalls.push(options);
    if (this.compactError) throw this.compactError;
    if (this.compactGate) return this.compactGate.promise;
    return { summary: 'SYNTHETIC_SETTINGS_SUMMARY', firstKeptEntryId: 'user-1', tokensBefore: 6000, estimatedTokensAfter: 900 };
  }
  async abort() {}
  async close() { this.closed = true; const error = Object.assign(Error('Synthetic transport closed'), { code: 'PI_RPC_CLOSED' }); this.compactGate?.reject(error); this.modelGate?.reject(error); }
}
function setup(t, mutateClient) {
  const root = realpathSync(mkdtempSync('/private/tmp/pi-p0-host-settings-')), clients = [];
  const bridgeState = { gate: null };
  const agentDir = join(root, 'agent'); mkdirSync(agentDir, { mode: 0o700 }); writeFileSync(join(agentDir, 'settings.json'), '{"theme":"light","retry":{"enabled":false}}', { mode: 0o600 });
  const options = { command: '/synthetic/pi', cwd: root, stateDir: join(root, 'state'), agentDir, provider: 'workbuddy-official', model: 'hy4',
    officialOnly: true, officialBridgeDir: join(root, 'synthetic-bridge'), requestTimeoutMs: 30, cancelTimeoutMs: 15,
    officialBridgeClient: { models: async () => { if (bridgeState.gate) await bridgeState.gate.promise; return normalizeOfficialCatalog({ data: structuredClone(catalogue) }); } },
    clientFactory: launch => { const client = new SettingsClient(launch); mutateClient?.(client); clients.push(client); return client; } };
  const harness = new PiHarness(options);
  const hosts = [harness];
  t.after(async () => { for (const host of hosts.reverse()) await host.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, clients, options, harness, hosts, bridgeState };
}
function current(harness, id) { return harness.listThreads().find(thread => thread.id === id); }
async function start(harness, clients, threadId) {
  const before = clients.length; await harness.startTurn({ threadId, prompt: 'Synthetic settings fixture' });
  await until(() => clients.slice(before).some(client => client.prompts.length)); return clients.slice(before).find(client => client.prompts.length);
}

test('Host exposes real model thinking defaults, rejects unsupported levels and persists per-model preferences and percent', async t => {
  const { harness, options, clients, hosts } = setup(t);
  const thread = await harness.createThread(); assert.equal(thread.executionSettings.thinkingLevel, 'high');
  const max = await harness.setExecutionSettings({ threadId: thread.id, preMessageCompactPct: '0' }); assert.equal(max.executionSettings.autoCompaction, true); assert.equal(max.executionSettings.preMessageCompaction, false);
  const reset = await harness.setExecutionSettings({ threadId: thread.id, preMessageCompactPct: '' }); assert.equal(reset.executionSettings.preMessageCompactPct, null); assert.equal(reset.executionSettings.effectiveCompactPercent, 80);
  await assert.rejects(harness.setExecutionSettings({ threadId: thread.id, thoughtLevel: 'disabled' }), { code: 'PI_THINKING_UNSUPPORTED' });
  await assert.rejects(harness.setExecutionSettings({ threadId: thread.id, thoughtLevel: 'low' }), { code: 'PI_THINKING_UNSUPPORTED' });
  const first = await harness.setExecutionSettings({ threadId: thread.id, preMessageCompactPct: '60' }); assert.equal(first.executionSettings.reserveTokens, 120000);
  await harness.setModel({ threadId: thread.id, model: 'glm' });
  const chosen = await harness.setExecutionSettings({ threadId: thread.id, thoughtLevel: 'disabled' }); assert.equal(chosen.executionSettings.thinkingLevel, 'off');
  await harness.setModel({ threadId: thread.id, model: 'hy4' }); assert.equal(current(harness, thread.id).executionSettings.thinkingLevel, 'high');
  await harness.setModel({ threadId: thread.id, model: 'glm' }); assert.equal(current(harness, thread.id).executionSettings.thinkingLevel, 'off');
  await harness.setModel({ threadId: thread.id, model: 'plain' }); assert.equal(current(harness, thread.id).executionSettings.thinkingLevel, 'off');
  await assert.rejects(harness.setExecutionSettings({ threadId: thread.id, thoughtLevel: 'enabled' }), { code: 'PI_THINKING_UNSUPPORTED' });
  await harness.setModel({ threadId: thread.id, model: 'glm' });
  await harness.close(); const count = clients.length; const restored = new PiHarness(options); hosts.push(restored); await restored.refreshOfficialModels();
  const saved = current(restored, thread.id); assert.equal(saved.executionSettings.thinkingLevel, 'off'); assert.equal(saved.executionSettings.effectiveCompactPercent, 60); assert.equal(clients.length, count);
});

test('Host rebuilds isolated runtime after settings/model/window changes without mutating shared settings or replaying prompts', async t => {
  const { harness, clients, options } = setup(t); const thread = await harness.createThread();
  const first = await start(harness, clients, thread.id); first.finish();
  const previous = JSON.parse(readFileSync(first.options.env.PI_CODING_AGENT_DIR + '/settings.json'));
  assert.equal(previous.defaultThinkingLevel, 'high'); assert.equal(previous.compaction.reserveTokens, 60000);
  await harness.setExecutionSettings({ threadId: thread.id, preMessageCompactPct: 75 }); assert.equal(first.closed, true);
  const second = await start(harness, clients, thread.id); second.finish();
  assert.equal(JSON.parse(second.options.env[TURN_SETTINGS_ENV]).reserveTokens, 75000);
  await harness.setContextWindow({ threadId: thread.id, contextWindow: 600000 }); assert.equal(second.closed, true);
  const third = await start(harness, clients, thread.id); third.finish(); assert.equal(JSON.parse(third.options.env[TURN_SETTINGS_ENV]).reserveTokens, 150000);
  await harness.setModel({ threadId: thread.id, model: 'glm' }); assert.equal(third.closed, true);
  const fourth = await start(harness, clients, thread.id); fourth.finish(); assert.equal(JSON.parse(fourth.options.env[TURN_SETTINGS_ENV]).contextWindow, 64000);
  assert.equal(clients.reduce((n, client) => n + client.prompts.length, 0), 4);
  assert.equal(readFileSync(join(options.agentDir, 'settings.json'), 'utf8'), '{"theme":"light","retry":{"enabled":false}}');
});

test('active generation and manual compaction reject competing settings, model or prompt operations', async t => {
  const { harness, clients } = setup(t); const thread = await harness.createThread(), client = await start(harness, clients, thread.id);
  await assert.rejects(harness.setExecutionSettings({ threadId: thread.id, thoughtLevel: 'high' }), { code: 'CONFLICT' });
  await assert.rejects(harness.compactThread({ threadId: thread.id }), { code: 'CONFLICT' }); client.finish();
  client.compactGate = deferred(); const compacting = harness.compactThread({ threadId: thread.id }); await until(() => client.compactCalls.length === 1);
  assert.equal(current(harness, thread.id).status, 'compacting');
  await assert.rejects(harness.setExecutionSettings({ threadId: thread.id, preMessageCompactPct: 50 }), { code: 'CONFLICT' });
  await assert.rejects(harness.setModel({ threadId: thread.id, model: 'glm' }), { code: 'CONFLICT' });
  await assert.rejects(harness.deleteThread(thread.id), { code: 'CONFLICT' });
  await assert.rejects(harness.startTurn({ threadId: thread.id, prompt: 'must not run' }), { code: 'CONFLICT' });
  await harness.cancelTurn({ threadId: thread.id }); assert.deepEqual(await compacting, { cancelled: true });
});

test('manual compaction uses compact RPC with a valid request context and never adds or replays a prompt turn', async t => {
  const { harness, clients } = setup(t); const thread = await harness.createThread(), client = await start(harness, clients, thread.id); client.finish();
  const before = current(harness, thread.id).turns.length, promptCount = client.prompts.length;
  await assert.rejects(harness.compactThread({ threadId: thread.id, customInstructions: 'x'.repeat(8193) }), { code: 'INVALID_PARAMS' }); assert.equal(client.compactCalls.length, 0);
  const result = await harness.compactThread({ threadId: thread.id, customInstructions: 'Retain only the synthetic marker' });
  assert.equal(result.compacted, true); assert.equal(result.tokensBefore, 6000); assert.equal(result.estimatedTokensAfter, 900);
  assert.equal(client.compactCalls[0].customInstructions, 'Retain only the synthetic marker');
  const context = JSON.parse(readFileSync(client.options.env.WORKBUDDY_PI_REQUEST_CONTEXT_FILE));
  assert.equal(context.threadId, thread.id); assert.match(context.turnId, /^pi-turn-[a-f0-9-]{36}$/);
  assert.equal(current(harness, thread.id).turns.length, before); assert.equal(client.prompts.length, promptCount);
  assert.equal(current(harness, thread.id).status, 'idle');
});

test('cancel and failure keep original turns and expose safe compaction outcomes', async t => {
  const { harness, clients } = setup(t); const thread = await harness.createThread(), client = await start(harness, clients, thread.id); client.finish();
  const before = current(harness, thread.id).turns;
  client.compactError = Error('Synthetic private error details must not be shown');
  await assert.rejects(harness.compactThread({ threadId: thread.id }), e => e.code === 'PI_COMPACTION_FAILED' && !e.message.includes('private error'));
  assert.equal(client.closed, true); assert.equal(current(harness, thread.id).turns.length, before.length); assert.equal(current(harness, thread.id).status, 'idle');
  const operation = harness.compactThread({ threadId: thread.id }); await until(() => clients.some(c => c !== client && c.compactCalls.length));
  await operation; assert.equal(clients.reduce((n, c) => n + c.prompts.length, 0), 1);
});

test('empty sessions and malformed settings are rejected before any model process is created', async t => {
  const { harness, clients } = setup(t); const thread = await harness.createThread();
  await assert.rejects(harness.compactThread({ threadId: thread.id }), { code: 'PI_COMPACTION_EMPTY' });
  await assert.rejects(harness.setExecutionSettings({ threadId: thread.id, preMessageCompactPct: -1 }), { code: 'PI_COMPACTION_INVALID' });
  await assert.rejects(harness.setExecutionSettings({ threadId: thread.id, unknown: 'x' }), { code: 'INVALID_PARAMS' }); assert.equal(clients.length, 0);
});

test('missing verified settings readiness prevents prompt execution instead of ignoring project overrides', async t => {
  const { harness, clients } = setup(t, client => { client.suppressSettingsReady = true; }); const thread = await harness.createThread();
  await harness.startTurn({ threadId: thread.id, prompt: 'must not reach the model' });
  for (let n = 0; n < 20 && current(harness, thread.id).turns[0].status === 'running'; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(current(harness, thread.id).turns[0].status, 'failed');
  assert.equal(clients.reduce((n, client) => n + client.prompts.length, 0), 0);
});

test('manual compact also requires verified runtime settings and leaves the transcript unchanged on readiness failure', async t => {
  let suppress = false;
  const { harness, clients } = setup(t, client => { client.suppressSettingsReady = suppress; });
  const thread = await harness.createThread(), first = await start(harness, clients, thread.id); first.finish();
  const bytes = readFileSync(first.sessionFile); await harness.setExecutionSettings({ threadId: thread.id, preMessageCompactPct: 65 }); suppress = true;
  await assert.rejects(harness.compactThread({ threadId: thread.id }), { code: 'PI_COMPACTION_FAILED' });
  assert.deepEqual(readFileSync(first.sessionFile), bytes); assert.equal(clients.reduce((n, client) => n + client.compactCalls.length, 0), 0);
  assert.equal(current(harness, thread.id).turns.length, 1);
});

test('cancelling compact while the model catalog is refreshing never creates a late owned execution client', async t => {
  const { harness, clients, bridgeState } = setup(t);
  const thread = await harness.createThread(), first = await start(harness, clients, thread.id); first.finish();
  await harness.setExecutionSettings({ threadId: thread.id, preMessageCompactPct: 65 }); assert.equal(first.closed, true);
  const before = clients.length, gate = deferred(); bridgeState.gate = gate;
  const refreshing = harness.refreshOfficialModels({ force: true });
  const compacting = harness.compactThread({ threadId: thread.id });
  try { await harness.cancelTurn({ threadId: thread.id }); }
  finally { bridgeState.gate = null; gate.resolve(); }
  await refreshing; assert.deepEqual(await compacting, { cancelled: true }); await tick();
  const owned = clients.slice(before).filter(client => client.options.args.some(arg => /turn-settings-extension\.mjs$/.test(arg)));
  assert.equal(owned.length, 0); assert.equal(harness.describe().running, false);
  assert.equal(clients.reduce((n, client) => n + client.prompts.length, 0), 1);
});

test('model changes hold the same thread operation lock as compaction, settings and prompts', async t => {
  const { harness, clients } = setup(t); const thread = await harness.createThread(), first = await start(harness, clients, thread.id); first.finish();
  const gate = deferred(); first.modelGate = gate;
  const changing = harness.setModel({ threadId: thread.id, model: 'glm' });
  await until(() => first.modelCalls.some(call => call.id === 'glm'));
  try {
    await assert.rejects(harness.compactThread({ threadId: thread.id }), { code: 'CONFLICT' });
    await assert.rejects(harness.setExecutionSettings({ threadId: thread.id, preMessageCompactPct: 55 }), { code: 'CONFLICT' });
    await assert.rejects(harness.deleteThread(thread.id), { code: 'CONFLICT' });
    await assert.rejects(harness.startTurn({ threadId: thread.id, prompt: 'must not race model selection' }), { code: 'CONFLICT' });
  } finally { gate.resolve(); }
  assert.equal((await changing).models.currentModelId, 'glm'); assert.equal(first.closed, true);
  assert.equal(clients.reduce((n, client) => n + client.prompts.length, 0), 1);
});

test('thread deletion is rejected while an execution-setting update waits for authoritative model metadata', async t => {
  const { harness, bridgeState } = setup(t), thread = await harness.createThread();
  const gate = deferred(); bridgeState.gate = gate;
  const refreshing = harness.refreshOfficialModels({ force: true });
  const changing = harness.setExecutionSettings({ threadId: thread.id, preMessageCompactPct: 66 });
  try { await assert.rejects(harness.deleteThread(thread.id), { code: 'CONFLICT' }); }
  finally { bridgeState.gate = null; gate.resolve(); }
  await refreshing; assert.equal((await changing).executionSettings.effectiveCompactPercent, 66);
  assert.equal(current(harness, thread.id).id, thread.id);
});
