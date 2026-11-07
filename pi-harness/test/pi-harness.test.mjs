import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { PiHarness, safeOfficialModelError } from '../src/pi-harness.mjs';
import approvalExtension, { APPROVAL_PROTOCOL, APPROVAL_READY, APPROVAL_TITLE }
  from '../package-dmg/approval-extension.mjs';
import { NATIVE_READY, NATIVE_CALL, NATIVE_TITLE } from '../src/native-feature-extension.mjs';
import { nativeToolName } from '../src/native-tools.mjs';
import { TURN_SETTINGS_READY } from '../src/turn-settings.mjs';
import { normalizeOfficialCatalog } from '../src/official-bridge.mjs';
import { createNativeInputReplay } from './fixtures/native-input-592.replay.mjs';
import { writeExpertFixture } from './helpers/expert-fixtures.mjs';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class FakeClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.prompts = [];
    this.aborts = 0;
    this.closed = false;
    this.stateCalls = 0;
    this.disposition = 'started';
    this.uiResponses = [];
    this.modelCalls = [];
  }
  async start() {
    if (this.startGate) await this.startGate;
    if (this.options.args?.includes('--extension') && !this.suppressApprovalReady) {
      this.event({ type: 'extension_ui_request', id: 'ready', method: 'notify', message: APPROVAL_READY });
    }
    if (this.options.args?.some(arg => /official-provider-extension\.(?:mjs|ts)$/.test(arg))) {
      this.event({ type: 'extension_ui_request', id: 'official-ready', method: 'notify', message: 'workbuddy-official-provider-ready-v1' });
    }
    if (this.options.args?.some(arg => /native-feature-extension\.mjs$/.test(arg))) this.event({ type: 'extension_ui_request', method: 'notify', message: NATIVE_READY });
    if (this.options.args?.some(arg => /turn-settings-extension\.mjs$/.test(arg))) this.event({ type: 'extension_ui_request', method: 'notify', message: TURN_SETTINGS_READY });
  }
  async getState() { this.stateCalls++; return { isStreaming: false,
    thinkingLevel: this.options.args?.[this.options.args.indexOf('--thinking') + 1] ?? 'off', ...(this.modelState ? { model: this.modelState } : {}) }; }
  async getSessionStats() {
    this.statsCalls = (this.statsCalls ?? 0) + 1;
    if (this.statsGate) await this.statsGate;
    this.statsEffect?.();
    return this.sessionStats ?? { contextUsage: { tokens: null, contextWindow: 32768, percent: null } };
  }
  async setModel(provider, modelId) { this.modelCalls.push({ provider, modelId }); return { id: modelId, provider }; }
  async prompt(message, options) {
    this.prompts.push(message);
    this.promptOptions = options;
    if (this.promptError) throw this.promptError;
    return { disposition: this.disposition };
  }
  async abort() { this.aborts++; }
  async sendExtensionUiResponse(response) { this.uiResponses.push({ ...response }); }
  async close() { this.closed = true; }
  event(record) { this.emit('event', record); }
}

function setup(overrides = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-harness-test-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const clients = [];
  const options = {
    command: '/test/pi', cwd: root, stateDir: join(root, 'state'), agentDir: join(root, 'agent'),
    provider: 'local-ollama', model: 'qwen3.8:27b', modelName: '本地 Qwen', cancelTimeoutMs: 25,
    clientFactory: config => { const client = new FakeClient(config); clients.push(client); return client; },
    ...overrides,
  };
  const harness = new PiHarness(options);
  cleanups.push(() => harness.close());
  return { root, clients, options, harness };
}

async function tick() { await new Promise(resolve => setImmediate(resolve)); }
async function turnStart(harness, thread) {
  const turn = await harness.startTurn({ threadId: thread.id, prompt: '仅用测试输入' });
  await tick();
  return turn;
}
function current(harness, threadId) { return harness.listThreads().find(thread => thread.id === threadId); }
function approvalRequest(client, id, toolName = 'write', toolCallId = `${id}-tool`, timeout) {
  client.event({ type: 'extension_ui_request', id, method: 'confirm', title: APPROVAL_TITLE,
    message: JSON.stringify({ protocol: APPROVAL_PROTOCOL, toolName, toolCallId,
      input: toolName === 'bash' ? { command: 'printf fixture' } : { path: 'fixture.txt', content: 'fixture' } }),
    ...(timeout === undefined ? {} : { timeout }),
  });
}

test('empty or partial length stops fail visibly after settling and retain completed tool results without replay', async () => {
  for (const text of ['', 'partial answer']) {
    const { harness, clients } = setup(); const events = []; harness.subscribe(e => events.push(e));
    const thread = await harness.createThread(); await turnStart(harness, thread); const client = clients[0];
    client.event({ type: 'tool_execution_start', toolCallId: 'already-executed', toolName: 'read', args: { path: 'fixture' } });
    client.event({ type: 'tool_execution_end', toolCallId: 'already-executed', toolName: 'read', result: { content: [{ type: 'text', text: 'preserved result' }] } });
    client.event({ type: 'message_start', message: { role: 'assistant' } });
    client.event({ type: 'message_end', message: { role: 'assistant', content: text ? [{ type: 'text', text }] : [], stopReason: 'length' } });
    assert.equal(current(harness, thread.id).turns[0].status, 'running');
    client.event({ type: 'agent_settled', aborted: false });
    const turn = current(harness, thread.id).turns[0];
    assert.equal(turn.status, 'failed'); assert.equal(turn.stopReason, 'length');
    assert.equal(turn.error.code, 'PI_RESPONSE_TRUNCATED');
    assert.match(turn.items.find(i => i.origin === 'host-diagnostic').text, /系统提示.*长度限制/);
    assert.equal(turn.items.find(i => i.type === 'tool').status, 'completed');
    assert.equal(client.prompts.length, 1); assert.equal(events.some(e => e.type === 'turn.failed'), true);
    assert.equal(events.some(e => e.type === 'turn.completed'), false);
    if (text) assert.equal(turn.items.find(i => i.type === 'text').text, text);
  }
});

test('Pi can recover a length stop internally, while an empty successful response is never presented as completion', async () => {
  const { harness, clients } = setup(); const thread = await harness.createThread(); await turnStart(harness, thread);
  const client = clients[0];
  client.event({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'length' } });
  client.event({ type: 'message_start', message: { role: 'assistant' } });
  client.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'recovered answer' }], stopReason: 'stop' } });
  client.event({ type: 'agent_settled', aborted: false });
  assert.equal(current(harness, thread.id).turns[0].status, 'completed');
  await turnStart(harness, thread);
  client.event({ type: 'message_start', message: { role: 'assistant' } });
  client.event({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'stop' } });
  client.event({ type: 'agent_settled', aborted: false });
  assert.equal(current(harness, thread.id).turns[1].error.code, 'PI_EMPTY_RESPONSE');
});

test('old falsely completed length stop is repaired with an exact private backup, without changing the Pi session', async () => {
  const { harness, clients, options } = setup(); const thread = await harness.createThread(); await turnStart(harness, thread);
  clients[0].event({ type: 'agent_settled', aborted: false }); await harness.close();
  const filename = join(options.stateDir, 'threads.json'), original = readFileSync(filename), saved = JSON.parse(original).threads[0].turns[0];
  const session = join(options.stateDir, 'sessions', `${thread.id}.jsonl`);
  const rows = [{ type: 'message', timestamp: saved.completedAt, message: { role: 'assistant', stopReason: 'length', content: [] } }, { type: 'context_edit', targetId: 'last-attempt', replacement: null }];
  const sessionBytes = rows.map(row => JSON.stringify(row)).join('\n') + '\n'; writeFileSync(session, sessionBytes);
  const restored = new PiHarness(options); cleanups.push(() => restored.close());
  const turn = current(restored, thread.id).turns[0];
  assert.equal(turn.status, 'failed'); assert.equal(turn.error.code, 'PI_RESPONSE_TRUNCATED');
  assert.equal(turn.items.filter(i => i.origin === 'host-diagnostic').length, 1);
  assert.equal(readFileSync(session, 'utf8'), sessionBytes); assert.equal(clients.length, 1);
  const backupDir = join(options.stateDir, 'migration-backups'), names = readdirSync(backupDir);
  assert.equal(names.length, 1); assert.deepEqual(readFileSync(join(backupDir, names[0])), original);
  assert.equal(statSync(join(backupDir, names[0])).mode & 0o777, 0o600);
  await restored.close(); const again = new PiHarness(options); cleanups.push(() => again.close());
  assert.equal(readdirSync(backupDir).length, 1); assert.equal(current(again, thread.id).turns[0].status, 'failed');
});

test('an old session length stop outside the final turn time range cannot relabel a successful turn', async () => {
  const { harness, clients, options } = setup(); const thread = await harness.createThread(); await turnStart(harness, thread);
  clients[0].event({ type: 'agent_settled', aborted: false }); await harness.close();
  writeFileSync(join(options.stateDir, 'sessions', `${thread.id}.jsonl`), JSON.stringify({ type: 'message', timestamp: '2000-01-01T00:00:00Z', message: { role: 'assistant', stopReason: 'length' } }) + '\n');
  const restored = new PiHarness(options); cleanups.push(() => restored.close());
  assert.equal(current(restored, thread.id).turns[0].status, 'completed');
  assert.equal(existsSync(join(options.stateDir, 'migration-backups')), false);
});

test('native attachments and Expert context reach Pi, restore selection, and clear without stale instructions', async () => {
  const { harness, clients, root, options } = setup({ nativeServices: { async listTools() { return []; } } });
  const thread = await harness.createThread();
  await harness.setNativeContext({ threadId: thread.id, expert: { id: 'expert-fixture', name: 'Fixture', prompt: 'EXPERT-CONTEXT-ONLY' } });
  writeFileSync(join(root, 'selected.txt'), 'ATTACHMENT-CONTENT-ONLY'); const filename = realpathSync(join(root, 'selected.txt'));
  await harness.startTurn({ threadId: thread.id, prompt: 'examine', promptContentBlocks: [
    { type: 'text', text: 'examine' }, { type: 'resource_link', name: 'selected.txt', uri: `file://${filename}`, mimeType: 'text/plain', _meta: { filePath: filename } },
  ] });
  for (let i = 0; i < 100 && !clients.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await tick();
  assert.match(clients[0].prompts[0], /ATTACHMENT-CONTENT-ONLY/);
  let context = JSON.parse(readFileSync(clients[0].options.env.WORKBUDDY_PI_NATIVE_CONTEXT_FILE));
  assert.match(context.instructions, /EXPERT-CONTEXT-ONLY/);
  const stored = JSON.parse(readFileSync(join(root, 'state', 'threads.json')));
  assert.equal(JSON.stringify(stored).includes('ATTACHMENT-CONTENT-ONLY'), false);
  clients[0].event({ type: 'agent_settled', aborted: false });
  await harness.close();
  const restored = new PiHarness(options); cleanups.push(() => restored.close());
  assert.equal(restored.listThreads()[0].nativeContext.expert.id, 'expert-fixture');
  await restored.setNativeContext({ threadId: thread.id, expert: null });
  await restored.startTurn({ threadId: thread.id, prompt: 'clear' }); await tick();
  context = JSON.parse(readFileSync(clients.at(-1).options.env.WORKBUDDY_PI_NATIVE_CONTEXT_FILE));
  assert.equal(context.instructions, '');
  clients.at(-1).event({ type: 'agent_settled', aborted: false });
});

test('installed agent experts resolve before task creation, bind their catalog and restore without cloud or replay', async () => {
  const config = realpathSync(mkdtempSync(join(tmpdir(), 'pi-expert-host-')));
  cleanups.push(() => rmSync(config, { recursive: true, force: true }));
  const f = writeExpertFixture(config), { harness, clients, options } = setup({ expertConfigDir: config });
  const resolved = await harness.resolveExpertSelection({ expert: f.selection });
  assert.equal(harness.listThreads().length, 0); assert.equal(clients.length, 0);
  assert.equal(resolved.prompt, f.body); assert.equal(resolved.package.skills[0].catalogOnly, true);
  const thread = await harness.createThread({ title: 'Synthetic Expert Host' });
  await harness.setNativeContext({ threadId: thread.id, expert: resolved });
  await harness.startTurn({ threadId: thread.id, prompt: 'SYNTHETIC_EXPERT_TASK_ONLY' });
  for (let i = 0; i < 200 && !clients[0]?.prompts.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(clients.length, 1);
  const context = JSON.parse(readFileSync(clients[0].options.env.WORKBUDDY_PI_NATIVE_CONTEXT_FILE));
  assert.match(context.instructions, /EXPERT_PACKAGE_PERSONA_MARKER/);
  assert.ok(context.instructions.includes(f.skillPath));
  assert.doesNotMatch(context.instructions, /SKILL_BODY_MUST_NOT_BE_EAGERLY_INLINED/);
  assert.deepEqual(context.tools, []);
  clients[0].event({ type: 'agent_settled', aborted: false });
  await harness.close();
  const restored = new PiHarness(options); cleanups.push(() => restored.close());
  const stored = current(restored, thread.id).nativeContext.expert;
  assert.equal(stored.marketExpertId, f.selection.marketExpertId);
  assert.equal(stored.runtimeIdentity, f.selection.runtimeIdentity);
  assert.equal(stored.package.agentSha256, resolved.package.agentSha256);
  assert.equal(clients.length, 1);
  writeFileSync(f.skillPath, '# Changed resource\nSYNTHETIC_CHANGE\n');
  await restored.startTurn({ threadId: thread.id, prompt: 'DO_NOT_SEND_CHANGED_PACKAGE' });
  for (let i = 0; i < 200 && current(restored, thread.id).turns.at(-1).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(current(restored, thread.id).turns.at(-1).error.code, 'PI_EXPERT_PACKAGE_CHANGED');
  assert.equal(clients.length, 1); assert.equal(clients[0].prompts.length, 1);
  await restored.setNativeContext({ threadId: thread.id, expert: null });
  assert.equal(current(restored, thread.id).nativeContext.expert, null);
});

test('a saved expert package cannot silently downgrade when its configured reader is unavailable', async () => {
  const { harness } = setup();
  await assert.rejects(harness.resolveExpertSelection({ expert: { id: 'synthetic', prompt: 'INLINE', package: {} } }),
    { code: 'PI_EXPERT_PACKAGE_UNAVAILABLE' });
});

test('native scene context and value-free input diagnostics persist across Host restart without granting native tools', async () => {
  let discoveryCalls = 0;
  const { harness, clients, options } = setup({ nativeServices: { async listTools() { discoveryCalls++; return []; } } });
  const thread = await harness.createThread();
  const blocks = createNativeInputReplay().homeBlocks([{ type: 'text', text: 'SYNTHETIC_SCENE_HOST_ONLY' }]);
  await harness.startTurn({ threadId: thread.id, prompt: 'SYNTHETIC_SCENE_HOST_ONLY', promptContentBlocks: blocks });
  for (let i = 0; i < 100 && !clients[0]?.prompts.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(clients.length, 1); assert.equal(clients[0].prompts.length, 1);
  assert.match(clients[0].prompts[0], /SYNTHETIC_SCENE_HOST_ONLY/);
  assert.match(clients[0].prompts[0], /企业微信/);
  assert.equal(discoveryCalls, 1);
  const native = JSON.parse(readFileSync(clients[0].options.env.WORKBUDDY_PI_NATIVE_CONTEXT_FILE));
  assert.deepEqual(native.tools, []); assert.equal(native.instructions, '');
  clients[0].event({ type: 'agent_settled', aborted: false });
  await harness.close();
  const restored = new PiHarness(options); cleanups.push(() => restored.close());
  const stored = current(restored, thread.id).turns[0];
  assert.equal(stored.status, 'completed');
  assert.deepEqual(stored.inputContexts.scenes, [{ id: '122844', name: '企业微信' }]);
  assert.equal(stored.inputDiagnostics.blocks[0].kind, 'scene');
  assert.equal(stored.inputDiagnostics.blocks[0].sceneId, '122844');
  assert.equal(stored.inputDiagnostics.blocks[0].uriScheme, 'scene:');
  assert.doesNotMatch(JSON.stringify(stored.inputDiagnostics), /SYNTHETIC_SCENE_HOST_ONLY|企业微信|scene:\/\//);
  assert.equal(clients.length, 1); assert.equal(discoveryCalls, 1);
});

test('failed remote input retains safe resource diagnostics before model startup and remains failed after restart', async () => {
  let discoveryCalls = 0;
  const { harness, clients, options } = setup({ nativeServices: { async listTools() { discoveryCalls++; return []; } } });
  const thread = await harness.createThread();
  await harness.startTurn({ threadId: thread.id, prompt: 'SYNTHETIC_REMOTE_HOST_ONLY', promptContentBlocks: [
    { type: 'text', text: 'SYNTHETIC_REMOTE_HOST_ONLY' },
    { type: 'resource_link', uri: 'https://example.invalid/synthetic.pdf?access_token=DO_NOT_STORE_REMOTE', mimeType: 'application/pdf' },
  ] });
  for (let i = 0; i < 100 && current(harness, thread.id).turns[0].status === 'running'; i++) await tick();
  const failed = current(harness, thread.id).turns[0];
  assert.equal(failed.error.code, 'ATTACHMENT_REMOTE_UNSUPPORTED');
  assert.equal(failed.inputDiagnostics.blocks[1].kind, 'remote');
  assert.equal(failed.inputDiagnostics.blocks[1].uriScheme, 'https:');
  assert.doesNotMatch(JSON.stringify(failed), /DO_NOT_STORE_REMOTE|example\.invalid|access_token/);
  assert.equal(clients.length, 0); assert.equal(discoveryCalls, 0);
  await harness.close();
  const restored = new PiHarness(options); cleanups.push(() => restored.close());
  assert.equal(current(restored, thread.id).turns[0].error.code, 'ATTACHMENT_REMOTE_UNSUPPORTED');
  assert.deepEqual(current(restored, thread.id).turns[0].inputDiagnostics, failed.inputDiagnostics);
  assert.equal(clients.length, 0); assert.equal(discoveryCalls, 0);
});

test('native long-paste full text and safe diagnostics survive Host restart without replay or invalid-body leakage', async () => {
  const { harness, clients, options } = setup();
  const thread = await harness.createThread();
  const text = 'HOST_LONGTEXT_HEAD\n' + '合成材料。'.repeat(800) + '\nHOST_LONGTEXT_TAIL';
  const native = createNativeInputReplay().paste({ text });
  assert.equal(native.blocks[0].uri.startsWith('longtext://'), true);
  await harness.startTurn({ threadId: thread.id, prompt: '', promptContentBlocks: native.blocks });
  for (let i = 0; i < 100 && !clients[0]?.prompts.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(clients[0].prompts[0], text);
  clients[0].event({ type: 'agent_settled', aborted: false });
  assert.equal(current(harness, thread.id).turns[0].prompt, text);
  const diagnostic = current(harness, thread.id).turns[0].inputDiagnostics;
  assert.equal(diagnostic.blocks[0].kind, 'long-text');
  assert.equal(diagnostic.blocks[0].uriScheme, 'longtext:');
  assert.doesNotMatch(JSON.stringify(diagnostic), /HOST_LONGTEXT|合成材料|fullText|displayText|longtext:\/\//);
  const bad = { type: 'resource_link', uri: 'https://example.invalid/private?token=DO_NOT_STORE_BAD_URI',
    _meta: { mentionType: 'long-text', fullText: 'DO_NOT_STORE_BAD_BODY' } };
  await harness.startTurn({ threadId: thread.id, prompt: 'SYNTHETIC_BAD_LONGTEXT', promptContentBlocks: [bad] });
  for (let i = 0; i < 100 && current(harness, thread.id).turns.at(-1).status === 'running'; i++) await tick();
  assert.equal(current(harness, thread.id).turns.at(-1).error.code, 'NATIVE_LONG_TEXT_INVALID');
  assert.equal(current(harness, thread.id).turns.at(-1).inputDiagnostics.blocks[0].kind, 'invalid-long-text');
  assert.equal(clients.length, 1); assert.equal(clients[0].prompts.length, 1);
  await harness.close();
  const restored = new PiHarness(options); cleanups.push(() => restored.close());
  assert.equal(current(restored, thread.id).turns[0].prompt, text);
  assert.deepEqual(current(restored, thread.id).turns[0].inputDiagnostics, diagnostic);
  assert.equal(current(restored, thread.id).turns[1].error.code, 'NATIVE_LONG_TEXT_INVALID');
  assert.doesNotMatch(readFileSync(join(options.stateDir, 'threads.json'), 'utf8'), /DO_NOT_STORE_BAD_URI|DO_NOT_STORE_BAD_BODY/);
  assert.equal(clients.length, 1);
});

test('native MCP is selected explicitly and needs exact one-shot approval before calling a credential-owning service', async () => {
  const calls = [];
  const services = { async listTools() { return [{ serverId: 'fixture', rawName: 'lookup', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }]; },
    async callTool(value) { calls.push(value); return { content: [{ type: 'text', text: 'MCP-FIXTURE-RESULT' }] }; } };
  const { harness, clients } = setup({ tools: ['read', 'write'], nativeServices: services });
  const thread = await harness.createThread(); await harness.setNativeContext({ threadId: thread.id, connectors: ['fixture'] });
  const turn = await turnStart(harness, thread), client = clients[0], name = nativeToolName('fixture', 'lookup');
  assert.ok(client.options.args[client.options.args.indexOf('--tools') + 1].split(',').includes(name));
  const metadata = { protocol: NATIVE_CALL, threadId: thread.id, turnId: turn.id, toolCallId: 'external-one', name, arguments: { query: 'fixture' } };
  client.event({ type: 'extension_ui_request', method: 'input', title: NATIVE_TITLE, id: 'unapproved', placeholder: JSON.stringify(metadata) });
  await tick(); assert.equal(calls.length, 0);
  client.event({ type: 'extension_ui_request', method: 'confirm', title: APPROVAL_TITLE, id: 'approval-one', message: JSON.stringify({ protocol: APPROVAL_PROTOCOL, toolCallId: 'external-one', toolName: name, input: metadata.arguments }) });
  const pending = current(harness, thread.id).turns[0].interactions[0];
  await harness.respondInteraction({ interactionId: pending.id, response: 'allow-once' });
  const invoke = id => client.event({ type: 'extension_ui_request', method: 'input', title: NATIVE_TITLE, id, placeholder: JSON.stringify(metadata) });
  invoke('approved'); await tick(); assert.equal(calls.length, 1);
  assert.match(client.uiResponses.find(value => value.id === 'approved').value, /MCP-FIXTURE-RESULT/);
  invoke('replay'); await tick(); assert.equal(calls.length, 1);
  await assert.rejects(() => harness.setNativeContext({ threadId: thread.id, connectors: [] }), { code: 'CONFLICT' });
  client.event({ type: 'agent_settled', aborted: false });
  await harness.setNativeContext({ threadId: thread.id, connectors: [] });
  await turnStart(harness, thread);
  assert.equal(clients[0].closed, true);
  assert.equal(clients[1].options.args[clients[1].options.args.indexOf('--tools') + 1].includes(name), false);
  clients[1].event({ type: 'agent_settled', aborted: false });
});

test('stop during native catalog preparation aborts it and never starts a Pi process', async () => {
  let entered, release, signal;
  const ready = new Promise(resolve => { entered = resolve; });
  const catalog = new Promise(resolve => { release = resolve; });
  const { harness, clients } = setup({ tools: ['read', 'write'], nativeServices: { async listTools(value) { signal = value.signal; entered(); return catalog; } } });
  const thread = await harness.createThread(); await harness.setNativeContext({ threadId: thread.id, connectors: ['fixture'] });
  await harness.startTurn({ threadId: thread.id, prompt: 'cancel preparation' }); await ready;
  assert.equal((await harness.cancelTurn({ threadId: thread.id })).status, 'cancelled');
  assert.equal(signal.aborted, true);
  release([{ serverId: 'fixture', rawName: 'lookup', inputSchema: { type: 'object' } }]); await tick();
  assert.equal(clients.length, 0); assert.equal(current(harness, thread.id).turns[0].status, 'cancelled');
});

test('current context stats stay separate from cumulative billing and do not change task activity', async () => {
  const { harness, clients } = setup(); const thread = await harness.createThread();
  await turnStart(harness, thread); const client = clients[0];
  client.sessionStats = { contextUsage: { tokens: 123, contextWindow: 1000, percent: 12.3 }, tokens: { total: 99999 } };
  client.modelState = { id: 'fixture-model', maxTokens: 200 };
  client.event({ type: 'message_start', message: { role: 'assistant' } });
  client.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'fixture' }], usage: { input: 90, output: 10, totalTokens: 100 } } });
  client.event({ type: 'agent_settled', aborted: false }); await tick();
  const saved = current(harness, thread.id);
  assert.equal(saved.piContextUsage.tokens, 123); assert.equal(saved.piContextUsage.contextWindow, 1000);
  assert.equal(saved.piContextUsage.breakdown, null); assert.equal(saved.turns[0].usage.totalTokens, 100);
  assert.equal(saved.updatedAt, saved.turns[0].completedAt);
  assert.equal(saved.piContextUsage.configuredMaxOutputTokens, 200);
  assert.equal(clients.length, 1); assert.equal(client.prompts.length, 1);
});

test('context refresh coalesces and missing Pi values remain unknown rather than cumulative or zero', async () => {
  const { harness, clients } = setup(); const thread = await harness.createThread(); await turnStart(harness, thread);
  clients[0].event({ type: 'agent_settled', aborted: false }); await tick();
  let release; clients[0].statsGate = new Promise(resolve => { release = resolve; });
  clients[0].sessionStats = { contextUsage: { tokens: null, contextWindow: 2000, percent: null }, tokens: { total: 5000 } };
  const before = clients[0].statsCalls; const first = harness.refreshContextUsage({ threadId: thread.id }); const second = harness.refreshContextUsage({ threadId: thread.id });
  await tick(); assert.equal(clients[0].statsCalls, before + 1); release();
  for (const value of await Promise.all([first, second])) { assert.equal(value.status, 'unknown'); assert.equal(value.tokens, null); assert.equal(value.contextWindow, 2000); }
  assert.equal(clients[0].prompts.length, 1);
});

test('cold context query uses an isolated no-tools session copy, preserves the original, and removes its snapshot', async () => {
  let client, release; const gate = new Promise(resolve => { release = resolve; });
  const { harness, root } = setup({ clientFactory: options => { client = new FakeClient(options); client.statsGate = gate; return client; } }); const thread = await harness.createThread();
  const empty = await harness.refreshContextUsage({ threadId: thread.id }); assert.equal(empty.tokens, null); assert.equal(client, undefined);
  const original = join(root, 'state', 'sessions', `${thread.id}.jsonl`); writeFileSync(original, 'private fixture session\n');
  const cold = harness.refreshContextUsage({ threadId: thread.id }); await tick();
  assert.ok(client.options.args.includes('--no-tools')); assert.ok(client.options.args.includes('--no-mcp'));
  const copy = client.options.args.at(-1); assert.notEqual(copy, original);
  assert.equal(readFileSync(copy, 'utf8'), readFileSync(original, 'utf8'));
  release(); const value = await cold; assert.equal(value.status, 'unknown'); assert.equal(client.prompts.length, 0); assert.equal(client.closed, true);
  assert.equal(readFileSync(original, 'utf8'), 'private fixture session\n'); assert.equal(readdirSync(join(root, 'state')).some(name => name.startsWith('stats-')), false);
});

test('normalizes Pi streaming and tools, using agent_settled rather than ACK or agent_end', async () => {
  const { harness, clients, root } = setup();
  const events = [];
  harness.subscribe(event => events.push(event));
  const thread = await harness.createThread({ title: '测试任务' });
  assert.equal(clients.length, 0);
  assert.deepEqual(thread.models, { availableModels: [{ id: 'qwen3.8:27b', name: '本地 Qwen' }], currentModelId: 'qwen3.8:27b' });
  const turn = await turnStart(harness, thread);
  const client = clients[0];
  assert.equal(current(harness, thread.id).status, 'running');
  assert.deepEqual(client.prompts, ['仅用测试输入']);
  assert.equal(client.options.env.PI_CODING_AGENT_DIR, join(root, 'agent'));
  assert.equal(client.options.env.PI_OFFLINE, '1');
  assert.equal(client.options.env.PI_TELEMETRY, '0');
  for (const flag of ['--mode', '--provider', '--model', '--thinking', '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-mcp', '--no-context-files', '--offline', '--tools', '--session']) {
    assert.ok(client.options.args.includes(flag), flag);
  }
  assert.equal(client.options.args[client.options.args.indexOf('--tools') + 1], 'read');
  assert.equal(client.options.args.includes('--no-approve'), false);
  assert.equal(client.options.args.at(-1), join(root, 'state', 'sessions', `${thread.id}.jsonl`));
  client.event({ type: 'message_start', message: { role: 'assistant' } });
  client.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好\u2028' } });
  client.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '，世界' } });
  client.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '你好，世界。' }], stopReason: 'toolUse' } });
  client.event({ type: 'tool_execution_start', toolCallId: 'tool-one', toolName: 'read', args: { path: 'fixture.txt' } });
  client.event({ type: 'tool_execution_update', toolCallId: 'tool-one', toolName: 'read', partialResult: { content: [{ type: 'text', text: 'partial' }] } });
  client.event({ type: 'tool_execution_end', toolCallId: 'tool-one', toolName: 'read', result: { content: [{ type: 'text', text: 'complete' }] }, isError: false });
  client.event({ type: 'message_start', message: { role: 'assistant' } });
  client.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '文件已读取。' }], stopReason: 'stop' } });
  client.event({ type: 'agent_end', willRetry: false });
  assert.equal(current(harness, thread.id).activeTurnId, turn.id);
  client.event({ type: 'agent_settled', aborted: false });
  const final = current(harness, thread.id);
  assert.equal(final.status, 'idle');
  assert.equal(final.activeTurnId, null);
  assert.equal(final.turns[0].status, 'completed');
  assert.equal(final.turns[0].stopReason, 'end_turn');
  assert.deepEqual(final.items.map(item => item.type), ['text', 'tool', 'text']);
  assert.equal(final.items[0].text, '你好，世界。');
  assert.equal(final.items[1].status, 'completed');
  assert.equal(final.items[1].output.content[0].text, 'complete');
  assert.equal(final.items[2].text, '文件已读取。');
  assert.equal(events.filter(event => event.type === 'turn.completed').length, 1);
  assert.equal(events.filter(event => event.type === 'message.delta').length, 2);
  assert.ok(events.some(event => event.type === 'tool.created' && event.payload.toolCallId === 'tool-one'));
  assert.ok(events.some(event => event.type === 'message.updated' && event.payload.messageId));
  assert.ok(events.every(event => event.harnessId === 'pi'));
  final.turns[0].items[0].text = 'mutated';
  assert.equal(current(harness, thread.id).items[0].text, '你好，世界。');
});

test('cancel waits for settlement, closes old client, and rejects turns during shutdown', async () => {
  const { harness, clients } = setup();
  const thread = await harness.createThread();
  const turn = await turnStart(harness, thread);
  const oldClient = clients[0];
  const cancellation = harness.cancelTurn({ threadId: thread.id });
  await tick();
  assert.equal(oldClient.aborts, 1);
  assert.equal(current(harness, thread.id).activeTurnId, turn.id);
  await assert.rejects(() => harness.startTurn({ threadId: thread.id, prompt: '过早的下一轮' }), { code: 'CONFLICT' });
  oldClient.event({ type: 'agent_settled', aborted: true });
  assert.equal((await cancellation).status, 'cancelled');
  assert.equal(oldClient.closed, true);
  const next = await turnStart(harness, thread);
  assert.equal(clients.length, 2);
  assert.equal(oldClient.options.args.at(-1), clients[1].options.args.at(-1));
  oldClient.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'stale' } });
  oldClient.event({ type: 'agent_settled', aborted: true });
  assert.equal(current(harness, thread.id).activeTurnId, next.id);
  assert.equal(current(harness, thread.id).turns[1].items.length, 0);
  clients[1].event({ type: 'agent_settled', aborted: false });
});

test('cancel has a finite timeout when Pi does not settle', async () => {
  const { harness, clients } = setup();
  const thread = await harness.createThread();
  await turnStart(harness, thread);
  const before = Date.now();
  const cancelled = await harness.cancelTurn({ threadId: thread.id });
  assert.ok(Date.now() - before < 1_000);
  assert.equal(clients[0].closed, true);
  assert.equal(cancelled.status, 'cancelled');
});

test('settlement during cancel does not allow a new turn until the old process closes', async () => {
  const { harness, clients } = setup();
  const thread = await harness.createThread();
  await turnStart(harness, thread);
  let finishClose;
  clients[0].close = () => new Promise(resolve => { finishClose = resolve; });
  const cancellation = harness.cancelTurn({ threadId: thread.id });
  clients[0].event({ type: 'agent_settled', aborted: true });
  await tick();
  assert.equal(current(harness, thread.id).activeTurnId, null);
  await assert.rejects(() => harness.startTurn({ threadId: thread.id, prompt: '先等退出' }), { code: 'CONFLICT' });
  finishClose();
  await cancellation;
  await turnStart(harness, thread);
  assert.equal(clients.length, 2);
  clients[1].event({ type: 'agent_settled', aborted: false });
});

test('cancel before Pi readiness never submits the prompt', async () => {
  let ready;
  const startGate = new Promise(resolve => { ready = resolve; });
  const { harness, clients } = setup({ clientFactory: config => {
    const client = new FakeClient(config);
    client.startGate = startGate;
    clients.push(client);
    return client;
  } });
  const thread = await harness.createThread();
  await turnStart(harness, thread);
  assert.equal((await harness.cancelTurn({ threadId: thread.id })).status, 'cancelled');
  ready();
  await tick();
  assert.deepEqual(clients[0].prompts, []);
});

test('handled prompt finishes immediately without waiting for a nonexistent run', async () => {
  const { harness, clients } = setup({ clientFactory: config => {
    const client = new FakeClient(config);
    client.disposition = 'handled'; clients.push(client); return client;
  } });
  const thread = await harness.createThread();
  await turnStart(harness, thread);
  assert.equal(current(harness, thread.id).turns[0].status, 'completed');
  assert.equal(current(harness, thread.id).turns[0].stopReason, 'handled');
});

for (const failure of ['failure', 'exit', 'error']) {
  test(`${failure} ends active turn with a safe error, without leaking raw diagnostics`, async () => {
    const { harness, clients } = setup();
    const events = [];
    harness.subscribe(event => events.push(event));
    const thread = await harness.createThread();
    await turnStart(harness, thread);
    clients[0].emit(failure, new Error('Authorization: Bearer do-not-leak prompt-secret'));
    await tick();
    assert.equal(current(harness, thread.id).turns[0].status, 'failed');
    assert.match(current(harness, thread.id).turns[0].error.message, /Pi/);
    assert.equal(JSON.stringify(events).includes('do-not-leak'), false);
  });
}

test('a prompt rejection is safe and closes its process', async () => {
  const { harness, clients } = setup({ clientFactory: config => {
    const client = new FakeClient(config);
    client.promptError = new Error('API token private-value'); clients.push(client); return client;
  } });
  const thread = await harness.createThread();
  await turnStart(harness, thread);
  assert.equal(current(harness, thread.id).turns[0].status, 'failed');
  assert.equal(JSON.stringify(harness.snapshot()).includes('private-value'), false);
  assert.equal(clients[0].closed, true);
});

test('model error fails only after settlement, and successful retry clears prior error', async () => {
  const { harness, clients } = setup();
  const thread = await harness.createThread();
  await turnStart(harness, thread);
  const client = clients[0];
  client.event({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'secret error' } });
  client.event({ type: 'agent_end', willRetry: true });
  assert.equal(current(harness, thread.id).status, 'running');
  client.event({ type: 'message_start', message: { role: 'assistant' } });
  client.event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '恢复成功' }], stopReason: 'stop' } });
  client.event({ type: 'agent_settled', aborted: false });
  assert.equal(current(harness, thread.id).turns[0].status, 'completed');
  await turnStart(harness, thread);
  client.event({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'secret error' } });
  client.event({ type: 'agent_settled', aborted: false });
  assert.equal(current(harness, thread.id).turns[1].status, 'failed');
  assert.equal(JSON.stringify(harness.snapshot()).includes('secret error'), false);
});

test('private atomic persistence restores history without starting Pi or replaying prompts', async () => {
  const { harness, clients, options, root } = setup();
  const thread = await harness.createThread({ title: '恢复测试' });
  await turnStart(harness, thread);
  clients[0].event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '已完成' }], stopReason: 'stop' } });
  clients[0].event({ type: 'agent_settled', aborted: false });
  await turnStart(harness, thread);
  clients[0].event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '部分正文' } });
  await harness.close();
  const restoredClients = [];
  const restored = new PiHarness({ ...options, clientFactory: config => {
    const client = new FakeClient(config); restoredClients.push(client); return client;
  } });
  cleanups.push(() => restored.close());
  const restoredThread = current(restored, thread.id);
  assert.equal(restoredThread.title, '恢复测试');
  assert.equal(restoredThread.turns[0].items[0].text, '已完成');
  assert.equal(restoredThread.turns[1].items[0].text, '部分正文');
  assert.equal(restoredThread.turns[1].status, 'interrupted');
  assert.equal(restoredThread.turns[1].stopReason, 'runtime_closed');
  assert.equal(restoredThread.activeTurnId, null);
  assert.equal(restoredClients.length, 0);
  assert.equal(statSync(join(root, 'state')).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, 'state', 'threads.json')).mode & 0o777, 0o600);
  await turnStart(restored, restoredThread);
  assert.deepEqual(restoredClients[0].prompts, ['仅用测试输入']);
  assert.equal(restoredClients[0].options.args.at(-1), clients[0].options.args.at(-1));
});

test('restores a process crash as interrupted rather than resubmitting', async () => {
  const { harness, options, root } = setup();
  const thread = await harness.createThread();
  await turnStart(harness, thread);
  const persisted = JSON.parse(readFileSync(join(root, 'state', 'threads.json'), 'utf8'));
  assert.equal(persisted.threads[0].turns[0].status, 'running');
  let creates = 0;
  const recovered = new PiHarness({ ...options, clientFactory: () => { creates++; throw new Error('must not spawn'); } });
  cleanups.push(() => recovered.close());
  assert.equal(current(recovered, thread.id).turns[0].status, 'interrupted');
  assert.equal(current(recovered, thread.id).turns[0].stopReason, 'runtime_interrupted');
  assert.equal(creates, 0);
});

test('separate threads use separate session files, and delete removes only its session', async () => {
  const { harness, clients, root } = setup();
  const first = await harness.createThread();
  const second = await harness.createThread();
  await turnStart(harness, first);
  await turnStart(harness, second);
  const firstSession = clients[0].options.args.at(-1);
  const secondSession = clients[1].options.args.at(-1);
  assert.notEqual(firstSession, secondSession);
  writeFileSync(firstSession, 'session first', { mode: 0o600 });
  writeFileSync(secondSession, 'session second', { mode: 0o600 });
  clients.forEach(client => client.event({ type: 'agent_settled', aborted: false }));
  assert.deepEqual(await harness.deleteThread(first.id), { deleted: true, threadId: first.id });
  assert.equal(harness.listThreads().length, 1);
  assert.equal(readFileSync(secondSession, 'utf8'), 'session second');
  assert.throws(() => readFileSync(firstSession), { code: 'ENOENT' });
  assert.equal(JSON.parse(readFileSync(join(root, 'state', 'threads.json'))).threads.length, 1);
});

test('rejects state symlinks and malformed persistence without overwriting files', async () => {
  const { harness, options, root } = setup();
  await harness.close();
  const target = join(root, 'target');
  writeFileSync(target, 'unchanged');
  symlinkSync(target, join(root, 'state', 'linked.json'));
  // Use a new directory to avoid changing the already-closed harness state.
  const badState = join(root, 'bad-state');
  const bad = new PiHarness({ ...options, stateDir: badState });
  await bad.close();
  rmSync(join(badState, 'threads.json'));
  symlinkSync(target, join(badState, 'threads.json'));
  assert.throws(() => new PiHarness({ ...options, stateDir: badState }), /regular files/);
  assert.equal(readFileSync(target, 'utf8'), 'unchanged');
  rmSync(join(badState, 'threads.json'));
  writeFileSync(join(badState, 'threads.json'), '{bad json');
  assert.throws(() => new PiHarness({ ...options, stateDir: badState }), /无法读取/);
});

test('unsupported approval and alternate models are explicit; configured model works', async () => {
  const { harness } = setup();
  const thread = await harness.createThread();
  assert.equal((await harness.setModel({ threadId: thread.id, model: 'qwen3.8:27b' })).models.currentModelId, 'qwen3.8:27b');
  await assert.rejects(() => harness.setModel({ threadId: thread.id, model: 'unknown' }), { code: 'INVALID_PARAMS' });
  await assert.rejects(() => harness.respondInteraction({ interactionId: 'anything', response: 'allow' }), { code: 'UNAVAILABLE' });
  await assert.rejects(() => harness.createThread({ mcpServers: [{ name: 'external' }] }), { code: 'UNAVAILABLE' });
});

test('full tool profile requires the exact approval extension and a runtime handshake', async () => {
  const { harness, clients } = setup({ tools: ['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls'] });
  assert.equal(harness.describe().capabilities.approval, true);
  assert.deepEqual(harness.describe().toolPolicy.approvalRequired, ['edit', 'write', 'bash']);
  const thread = await harness.createThread();
  await turnStart(harness, thread);
  assert.equal(clients[0].options.args[clients[0].options.args.indexOf('--tools') + 1], 'read,edit,write,bash,grep,find,ls');
  assert.equal(clients[0].options.args.includes('--no-extensions'), true);
  assert.equal(clients[0].options.args.includes('--no-approve'), false);
  assert.equal(clients[0].options.args.includes('--no-context-files'), true);
  assert.deepEqual(clients[0].prompts, ['仅用测试输入']);
  clients[0].event({ type: 'agent_settled', aborted: false });
});

test('missing approval handshake prevents model prompts and fails closed', async () => {
  const { harness, clients } = setup({ tools: ['read', 'write'], requestTimeoutMs: 15,
    clientFactory: config => {
      const client = new FakeClient(config); client.suppressApprovalReady = true; clients.push(client); return client;
    } });
  const thread = await harness.createThread();
  await turnStart(harness, thread);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(clients[0].prompts, []);
  assert.equal(current(harness, thread.id).turns[0].status, 'failed');
  assert.equal(clients[0].closed, true);
});

test('write and Bash confirmations map to Host interactions, with only per-call permission', async () => {
  const { harness, clients } = setup({ tools: ['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls'] });
  const events = [];
  harness.subscribe(event => events.push(event));
  const thread = await harness.createThread();
  await turnStart(harness, thread);
  clients[0].event({ type: 'tool_execution_start', toolCallId: 'write-call', toolName: 'write', args: { path: 'fixture.txt', content: 'fixture' } });
  approvalRequest(clients[0], 'write-confirm', 'write', 'write-call');
  approvalRequest(clients[0], 'bash-confirm', 'bash', 'bash-call');
  let snapshot = current(harness, thread.id);
  assert.equal(snapshot.status, 'waiting_for_approval');
  assert.equal(snapshot.turns[0].items[0].status, 'awaiting_approval');
  assert.equal(snapshot.turns[0].interactions.length, 2);
  assert.equal(snapshot.items.filter(item => item.kind === 'approval').length, 2);
  const [writeInteraction, bashInteraction] = snapshot.turns[0].interactions;
  assert.match(writeInteraction.description, /fixture.txt/);
  assert.equal(writeInteraction.toolCall.id, 'write-call');
  await assert.rejects(() => harness.respondInteraction({ interactionId: writeInteraction.id, response: 'allow-always' }), { code: 'INVALID_PARAMS' });
  assert.equal(clients[0].uiResponses.length, 0);
  assert.equal((await harness.respondInteraction({ interactionId: writeInteraction.id, response: { optionId: 'allow-once' } })).interaction.status, 'approved');
  assert.deepEqual(clients[0].uiResponses[0], { id: 'write-confirm', confirmed: true });
  assert.equal(current(harness, thread.id).status, 'waiting_for_approval');
  assert.equal((await harness.respondInteraction({ interactionId: bashInteraction.id, response: false })).interaction.status, 'rejected');
  assert.deepEqual(clients[0].uiResponses[1], { id: 'bash-confirm', confirmed: false });
  assert.equal(current(harness, thread.id).status, 'running');
  assert.equal(current(harness, thread.id).turns[0].items[0].status, 'running');
  await assert.rejects(() => harness.respondInteraction({ interactionId: writeInteraction.id, response: true }), { code: 'NOT_FOUND' });
  assert.equal(events.filter(event => event.type === 'interaction.requested').length, 2);
  assert.equal(events.filter(event => event.type === 'interaction.resolved').length, 2);
  clients[0].event({ type: 'agent_settled', aborted: false });
});

test('approval timeout rejects; cancelling pending approval cannot authorize a delayed response', async () => {
  const { harness, clients } = setup({ tools: ['read', 'write', 'bash'] });
  const thread = await harness.createThread();
  await turnStart(harness, thread);
  approvalRequest(clients[0], 'short-confirm', 'write', 'short-tool', 10);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(current(harness, thread.id).turns[0].interactions[0].status, 'rejected');
  assert.equal(current(harness, thread.id).turns[0].interactions[0].reason, 'timeout');
  assert.deepEqual(clients[0].uiResponses[0], { id: 'short-confirm', confirmed: false });
  approvalRequest(clients[0], 'cancel-confirm', 'bash', 'cancel-tool');
  const interactionId = current(harness, thread.id).turns[0].interactions[1].id;
  const cancellation = harness.cancelTurn({ threadId: thread.id });
  clients[0].event({ type: 'agent_settled', aborted: true });
  await cancellation;
  assert.deepEqual(clients[0].uiResponses[1], { id: 'cancel-confirm', confirmed: false });
  assert.equal(current(harness, thread.id).turns[0].interactions[1].status, 'cancelled');
  await assert.rejects(() => harness.respondInteraction({ interactionId, response: true }), { code: 'NOT_FOUND' });
});

test('approval delivery failure and extension runtime errors stop the run safely', async () => {
  const { harness, clients } = setup({ tools: ['read', 'write'] });
  const thread = await harness.createThread();
  await turnStart(harness, thread);
  approvalRequest(clients[0], 'fail-confirm');
  const interactionId = current(harness, thread.id).turns[0].interactions[0].id;
  clients[0].sendExtensionUiResponse = async () => { throw new Error('token private-credential'); };
  await assert.rejects(() => harness.respondInteraction({ interactionId, response: true }), { code: 'UNAVAILABLE' });
  assert.equal(current(harness, thread.id).turns[0].status, 'failed');
  assert.equal(clients[0].closed, true);
  assert.equal(JSON.stringify(harness.snapshot()).includes('private-credential'), false);
  await turnStart(harness, thread);
  clients[1].event({ type: 'extension_error', event: 'tool_call', error: 'private-credential' });
  await tick();
  assert.equal(current(harness, thread.id).turns[1].status, 'failed');
  assert.equal(clients[1].closed, true);
});

test('unrecognized extension dialogs are cancelled instead of being silently approved', async () => {
  const { harness, clients } = setup({ tools: ['read', 'write'] });
  const thread = await harness.createThread();
  await turnStart(harness, thread);
  clients[0].event({ type: 'extension_ui_request', id: 'unknown', method: 'confirm', title: 'Untrusted', message: 'run anything' });
  await tick();
  assert.deepEqual(clients[0].uiResponses, [{ id: 'unknown', confirmed: false }]);
  assert.equal(current(harness, thread.id).turns[0].status, 'failed');
});

test('approval state survives restart as cancelled and is never replayed', async () => {
  const { harness, clients, options } = setup({ tools: ['read', 'write'] });
  const thread = await harness.createThread();
  await turnStart(harness, thread);
  approvalRequest(clients[0], 'pending-at-close');
  await harness.close();
  let starts = 0;
  const restored = new PiHarness({ ...options, clientFactory: () => { starts++; throw new Error('must not spawn'); } });
  cleanups.push(() => restored.close());
  const recovered = current(restored, thread.id);
  assert.equal(recovered.turns[0].status, 'interrupted');
  assert.equal(recovered.turns[0].interactions[0].status, 'cancelled');
  assert.equal(recovered.activeTurnId, null);
  assert.equal(starts, 0);
});

test('tampered or symlinked permission extension and unsafe tool configuration are rejected', async () => {
  const { options, root } = setup();
  const tampered = join(root, 'untrusted.mjs');
  writeFileSync(tampered, 'export default function () {}');
  assert.throws(() => new PiHarness({ ...options, tools: ['write'], approvalExtension: tampered }), /受控版本/);
  const link = join(root, 'linked.mjs');
  symlinkSync(tampered, link);
  assert.throws(() => new PiHarness({ ...options, tools: ['write'], approvalExtension: link }), /regular files/);
  assert.throws(() => new PiHarness({ ...options, tools: ['write'], args: ['--extension', tampered] }), /不得覆盖/);
  assert.throws(() => new PiHarness({ ...options, tools: ['write'], approvalTimeoutMs: 0 }), { code: 'INVALID_PARAMS' });
  assert.throws(() => new PiHarness({ ...options, tools: ['powershell'] }), { code: 'INVALID_PARAMS' });
  assert.throws(() => new PiHarness({ ...options, tools: ['read', 'read'] }), { code: 'INVALID_PARAMS' });
});

test('the shipped Pi extension allows reads and requires one-shot consent for every mutating tool', async () => {
  const handlers = new Map();
  approvalExtension({ on: (type, handler) => handlers.set(type, handler) });
  const notifications = [];
  const signal = new AbortController().signal;
  const confirmations = [];
  const ctx = { mode: 'rpc', signal, ui: {
    notify: (...args) => notifications.push(args),
    confirm: async (...args) => { confirmations.push(args); return true; },
  } };
  handlers.get('session_start')({}, ctx);
  assert.deepEqual(notifications, [[APPROVAL_READY, 'info']]);
  for (const toolName of ['read', 'grep', 'find', 'ls']) {
    assert.equal(await handlers.get('tool_call')({ toolName, toolCallId: 'read-one', input: {} }, ctx), undefined);
  }
  assert.equal(confirmations.length, 0);
  for (const toolName of ['edit', 'write', 'bash', 'write']) {
    assert.equal(await handlers.get('tool_call')({ toolName, toolCallId: `call-${toolName}`, input: { path: 'fixture' } }, ctx), undefined);
  }
  assert.equal(confirmations.length, 4);
  for (const [title, message, opts] of confirmations) {
    assert.equal(title, APPROVAL_TITLE);
    assert.equal(JSON.parse(message).protocol, APPROVAL_PROTOCOL);
    assert.equal(opts.signal, signal);
    assert.ok(opts.timeout >= 1_000);
  }
  const denied = { ...ctx, ui: { ...ctx.ui, confirm: async () => false } };
  assert.equal((await handlers.get('tool_call')({ toolName: 'bash', input: {} }, denied)).block, true);
  const broken = { ...ctx, ui: { ...ctx.ui, confirm: async () => { throw new Error('UI missing'); } } };
  assert.equal((await handlers.get('tool_call')({ toolName: 'write', input: {} }, broken)).block, true);
  assert.equal((await handlers.get('tool_call')({ toolName: 'write', input: {} }, { ...ctx, mode: 'print' })).block, true);
  assert.equal((await handlers.get('tool_call')({ toolName: 'unknown', input: {} }, ctx)).block, true);
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await handlers.get('tool_call')({ toolName: 'edit', input: {} }, { ...ctx, signal: aborted.signal })).block, true);
});

const officialCatalog = [
  { id: 'hy4', name: 'HY 4', api: 'openai-completions', provider: 'workbuddy-official', supportsToolCall: true },
  { id: 'official-responses', name: 'Official Responses', api: 'openai-responses', provider: 'workbuddy-official', supportsToolCall: true },
  { id: 'disabled-model', name: 'Unavailable', api: 'openai-completions', provider: 'workbuddy-official', disabled: true },
];

function officialSetup(overrides = {}) {
  const bridge = overrides.officialBridgeClient ?? { models: async () => structuredClone(officialCatalog) };
  return setup({ officialOnly: true, officialBridgeDir: '/test/private-official-bridge',
    provider: 'workbuddy-official', model: 'hy4',
    ...overrides, officialBridgeClient: { ...bridge, models: async options => normalizeOfficialCatalog({ data: await bridge.models(options) }) } });
}

test('official directory exposes all models, RPC selection persists per thread, and never copies tickets into Pi config', async () => {
  const { harness, clients, options, root } = officialSetup();
  const thread = await harness.createThread();
  assert.deepEqual(thread.models.availableModels.map(model => model.id), officialCatalog.map(model => model.id));
  await turnStart(harness, thread);
  assert.deepEqual(clients[0].modelCalls, [{ provider: 'workbuddy-official', modelId: 'hy4' }]);
  const contextFile = clients[0].options.env.WORKBUDDY_PI_REQUEST_CONTEXT_FILE;
  const requestContext = JSON.parse(readFileSync(contextFile, 'utf8'));
  assert.equal(requestContext.threadId, thread.id);
  assert.equal(requestContext.turnId, current(harness, thread.id).activeTurnId);
  assert.equal(statSync(contextFile).mode & 0o777, 0o600);
  assert.equal(clients[0].options.env.WORKBUDDY_PI_OFFICIAL_BRIDGE_DIR, '/test/private-official-bridge');
  assert.equal(clients[0].options.args.includes('ollama'), false);
  await assert.rejects(() => harness.setModel({ threadId: thread.id, model: 'official-responses' }), { code: 'CONFLICT' });
  clients[0].event({ type: 'agent_settled', aborted: false });
  const selected = await harness.setModel({ threadId: thread.id, model: 'official-responses' });
  assert.equal(selected.models.currentModelId, 'official-responses');
  assert.deepEqual(clients[0].modelCalls.at(-1), { provider: 'workbuddy-official', modelId: 'official-responses' });
  await assert.rejects(() => harness.setModel({ threadId: thread.id, model: 'disabled-model' }), { code: 'OFFICIAL_MODEL_FORBIDDEN' });
  await assert.rejects(() => harness.setModel({ threadId: thread.id, model: 'ollama/qwen' }), { code: 'INVALID_PARAMS' });
  await harness.close();
  const restored = new PiHarness(options); cleanups.push(() => restored.close());
  assert.equal(current(restored, thread.id).models.currentModelId, 'official-responses');
  await restored.refreshOfficialModels();
  assert.equal(current(restored, thread.id).models.currentModelId, 'official-responses');
  assert.equal(readFileSync(join(root, 'state', 'threads.json'), 'utf8').includes('ticket'), false);
});

test('official catalog refresh merges concurrent requests, updates metadata, and rejects auth failures without starting a process', async () => {
  let calls = 0, release;
  const waiting = new Promise(resolve => { release = resolve; });
  let catalog = officialCatalog, fail;
  const { harness, clients } = officialSetup({ officialBridgeClient: { models: async () => {
    calls++; await waiting; if (fail) throw fail; return structuredClone(catalog);
  } } });
  const events = []; harness.subscribe(event => events.push(event));
  const one = harness.refreshOfficialModels(), two = harness.refreshOfficialModels();
  release(); await Promise.all([one, two]);
  assert.equal(calls, 1);
  const thread = await harness.createThread();
  assert.equal(calls, 1);
  catalog = [...officialCatalog, { id: 'new-official', name: 'New', api: 'openai-completions' }];
  await harness.refreshOfficialModels({ force: true });
  assert.equal(current(harness, thread.id).models.availableModels.length, 4);
  const changedCount = events.filter(event => event.type === 'thread.updated').length;
  await harness.refreshOfficialModels({ force: true });
  assert.equal(events.filter(event => event.type === 'thread.updated').length, changedCount);
  fail = Object.assign(new Error('登录不可用'), { code: 'OFFICIAL_AUTH_REQUIRED' });
  await assert.rejects(() => harness.refreshOfficialModels({ force: true }), { code: 'OFFICIAL_AUTH_REQUIRED' });
  assert.equal(clients.length, 0);
});

test('official mode migrates old Ollama model selection without replaying completed history', async () => {
  const { harness, clients, options } = setup();
  const thread = await harness.createThread();
  await turnStart(harness, thread);
  clients[0].event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Old answer' }], stopReason: 'stop' } });
  clients[0].event({ type: 'agent_settled', aborted: false });
  await harness.close();
  let created = 0;
  const migrated = new PiHarness({ ...options, provider: 'workbuddy-official', model: 'hy4', officialOnly: true,
    officialBridgeDir: '/test/official', officialBridgeClient: { models: async () => normalizeOfficialCatalog({ data: officialCatalog }) },
    clientFactory: () => { created++; throw new Error('no automatic prompt'); } });
  cleanups.push(() => migrated.close());
  const restored = current(migrated, thread.id);
  assert.equal(restored.models.currentModelId, 'hy4');
  assert.equal(restored.provider, 'workbuddy-official');
  assert.equal(restored.turns[0].items[0].text, 'Old answer');
  assert.equal(created, 0);
  await migrated.refreshOfficialModels();
  assert.equal(created, 0);
});

test('official initial authorization or network failure does not create a runnable thread', async () => {
  for (const code of ['OFFICIAL_AUTH_REQUIRED', 'OFFICIAL_BRIDGE_UNAVAILABLE', 'OFFICIAL_MODEL_FORBIDDEN']) {
    const { harness, clients } = officialSetup({ officialBridgeClient: { models: async () => { throw Object.assign(new Error('官方连接暂不可用'), { code }); } } });
    await assert.rejects(() => harness.createThread(), { code });
    assert.equal(harness.listThreads().length, 0);
    assert.equal(clients.length, 0);
  }
});

test('thinking and usage preserve real model identifiers and omit unknown cost without double counting reasoning', async () => {
  const { harness, clients } = officialSetup();
  const events = []; harness.subscribe(event => events.push(event));
  const thread = await harness.createThread();
  const turn = await turnStart(harness, thread);
  clients[0].event({ type: 'message_start', message: { role: 'assistant' } });
  clients[0].event({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '考虑中' } });
  clients[0].event({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop',
    content: [{ type: 'thinking', thinking: '考虑完成', thinkingSignature: 'opaque-not-for-ui' }, { type: 'text', text: '结果' }],
    usage: { input: 10, output: 6, cacheRead: 3, cacheWrite: 2, totalTokens: 21, reasoning: 4,
      cost: { input: 123, output: 456, total: 579 } } } });
  clients[0].event({ type: 'agent_settled', aborted: false });
  const final = current(harness, thread.id).turns[0];
  assert.equal(final.model, 'hy4');
  assert.equal(final.provider, 'workbuddy-official');
  assert.equal(final.items.find(item => item.type === 'thinking').thinking, '考虑完成');
  assert.deepEqual(final.usage, { costKnown: false, input: 10, output: 6, cacheRead: 3, cacheWrite: 2, totalTokens: 21, reasoning: 4 });
  assert.equal(JSON.stringify(events).includes('opaque-not-for-ui'), false);
  assert.ok(events.some(event => event.type === 'thinking.delta' && event.turnId === turn.id));
  assert.ok(events.some(event => event.type === 'turn.usage' && event.payload.usage.output === 6));
});

test('hy4 default is an explicit alias to the first enabled real Hy4 id, and persists the resolved id', async () => {
  const catalog = [
    { id: 'fast-model', name: 'Auto', api: 'openai-completions' },
    { id: 'hy4-hidden', name: 'Hy4preview', api: 'openai-completions', disabled: true },
    { id: 'hy4-preview-ioa', name: 'Hy4preview', api: 'openai-completions' },
    { id: 'hy4-preview-dev', name: 'Hy4preview', api: 'openai-completions' },
  ];
  const { harness, clients, options } = officialSetup({ officialBridgeClient: { models: async () => catalog } });
  const thread = await harness.createThread();
  assert.equal(thread.models.currentModelId, 'hy4-preview-ioa');
  assert.equal(thread.models.availableModels.find(model => model.id === 'hy4-preview-ioa').description, 'hy4-preview-ioa');
  const turn = await turnStart(harness, thread);
  assert.equal(turn.model, 'hy4-preview-ioa');
  assert.deepEqual(clients[0].modelCalls[0], { provider: 'workbuddy-official', modelId: 'hy4-preview-ioa' });
  clients[0].event({ type: 'agent_settled', aborted: false });
  await harness.close();
  const restored = new PiHarness(options); cleanups.push(() => restored.close());
  await restored.refreshOfficialModels();
  assert.equal(current(restored, thread.id).models.currentModelId, 'hy4-preview-ioa');
});

test('exact enabled hy4 wins over aliases regardless of catalog order', async () => {
  const { harness } = officialSetup({ officialBridgeClient: { models: async () => [
    { id: 'hy4-preview-ioa', name: 'Preview', api: 'openai-completions' },
    { id: 'hy4', name: 'Exact', api: 'openai-completions' },
  ] } });
  assert.equal((await harness.createThread()).models.currentModelId, 'hy4');
});

test('missing or disabled Hy4 requires an explicit model choice and never silently selects Auto', async () => {
  const { harness, clients } = officialSetup({ officialBridgeClient: { models: async () => [
    { id: 'fast-model', name: 'Auto', api: 'openai-completions' },
    { id: 'hy40-not-hy4', name: 'Different', api: 'openai-completions' },
    { id: 'hy4-unavailable', name: 'Hy4', api: 'openai-completions', disabled: true },
  ] } });
  const thread = await harness.createThread();
  assert.equal(thread.models.currentModelId, null);
  assert.equal(thread.models.selectionRequired, true);
  await assert.rejects(() => harness.startTurn({ threadId: thread.id, prompt: 'must not run Auto' }), { code: 'OFFICIAL_MODEL_SELECTION_REQUIRED' });
  assert.equal(clients.length, 0);
  assert.equal(current(harness, thread.id).turns.length, 0);
  assert.equal((await harness.setModel({ threadId: thread.id, model: 'fast-model' })).models.currentModelId, 'fast-model');
});

test('official error classifier only emits safe fixed messages and distinguishes 401/403/429', () => {
  const samples = [
    ['401 WORKBUDDY_LOGIN_REQUIRED credential-secret', 'OFFICIAL_AUTH_REQUIRED'],
    ['HTTP 403 AICC_PERMISSION_REQUIRED bearer-secret', 'OFFICIAL_MODEL_FORBIDDEN'],
    ['429 OFFICIAL_REQUEST_REJECTED token-secret', 'OFFICIAL_RATE_LIMITED'],
    ['OFFICIAL_REQUEST_REJECTED {"upstreamStatus":429,"upstreamCode":"quota-secret"}', 'OFFICIAL_RATE_LIMITED'],
    [{ status: 403, code: 'OFFICIAL_REQUEST_REJECTED', message: 'raw-secret' }, 'OFFICIAL_MODEL_FORBIDDEN'],
    ['AICC_RESPONSE_DECRYPT_FAILED raw-secret', 'OFFICIAL_STREAM_ERROR'],
    ['OFFICIAL_STREAM_TRUNCATED raw-secret', 'OFFICIAL_STREAM_ERROR'],
    ['request failed because private value 401 is not an HTTP status', 'OFFICIAL_MODEL_ERROR'],
    ['token=WORKBUDDY_LOGIN_REQUIREDsuffix', 'OFFICIAL_MODEL_ERROR'],
    ['unknown_provider_error raw-secret', 'OFFICIAL_MODEL_ERROR'],
  ];
  for (const [input, code] of samples) {
    const safe = safeOfficialModelError(input);
    assert.equal(safe.code, code);
    assert.doesNotMatch(JSON.stringify(safe), /secret|credential|bearer|quota-secret|private value/i);
  }
});

test('official model failure preserves safe auth/permission/rate codes through agent_settled and retry exhaustion', async () => {
  const { harness, clients } = officialSetup();
  const events = []; harness.subscribe(event => events.push(event));
  const thread = await harness.createThread();
  for (const [raw, code] of [['401 WORKBUDDY_LOGIN_REQUIRED secret-one', 'OFFICIAL_AUTH_REQUIRED'],
    ['403 AICC_PERMISSION_REQUIRED secret-two', 'OFFICIAL_MODEL_FORBIDDEN'],
    ['429 OFFICIAL_REQUEST_REJECTED secret-three', 'OFFICIAL_RATE_LIMITED']]) {
    await turnStart(harness, thread);
    clients[0].event({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', content: [], errorMessage: raw } });
    clients[0].event({ type: 'auto_retry_end', success: false, finalError: 'unknown raw retry error' });
    clients[0].event({ type: 'agent_settled', aborted: false });
    const failed = current(harness, thread.id).turns.at(-1);
    assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, code);
    assert.doesNotMatch(JSON.stringify(failed), /secret-|raw retry/);
  }
  assert.doesNotMatch(JSON.stringify(events), /secret-|raw retry/);
});

const hy4Overlay = [
  { id: 'fast-model', name: 'Auto', api: 'openai-completions' },
  { id: 'hy4-preview-ioa', name: 'Hy4preview', api: 'openai-completions' },
];

test('restart preserves the requested real Hy4 id across a static-only startup catalog and later overlay', async () => {
  let catalog = hy4Overlay;
  const { harness, clients, options } = officialSetup({ officialBridgeClient: { models: async () => structuredClone(catalog) } });
  const thread = await harness.createThread();
  assert.equal(thread.models.requestedModelId, 'hy4-preview-ioa');
  await harness.close();
  catalog = [hy4Overlay[0]];
  const restored = new PiHarness(options); cleanups.push(() => restored.close());
  await restored.refreshOfficialModels();
  let selected = current(restored, thread.id).models;
  assert.equal(selected.currentModelId, null); assert.equal(selected.requestedModelId, 'hy4-preview-ioa');
  await assert.rejects(() => restored.startTurn({ threadId: thread.id, prompt: 'not Auto' }), { code: 'OFFICIAL_MODEL_SELECTION_REQUIRED' });
  catalog = hy4Overlay;
  await restored.refreshOfficialModels({ force: true });
  selected = current(restored, thread.id).models;
  assert.equal(selected.currentModelId, 'hy4-preview-ioa'); assert.equal(selected.requestedModelId, 'hy4-preview-ioa');
  assert.equal(current(restored, thread.id).turns.length, 0); assert.equal(clients.length, 0);
});

test('initial hy4 alias survives an early static catalog miss and resolves only when Hy4 appears', async () => {
  let catalog = [hy4Overlay[0]];
  const { harness, clients } = officialSetup({ officialBridgeClient: { models: async () => structuredClone(catalog) } });
  const thread = await harness.createThread();
  assert.equal(thread.models.currentModelId, null); assert.equal(thread.models.requestedModelId, 'hy4');
  catalog = hy4Overlay;
  await harness.refreshOfficialModels({ force: true });
  assert.equal(current(harness, thread.id).models.currentModelId, 'hy4-preview-ioa');
  assert.equal(current(harness, thread.id).models.requestedModelId, 'hy4-preview-ioa');
  assert.equal(clients.length, 0);
});

test('temporarily disabled preferred model stays closed and restores without a model request', async () => {
  let catalog = hy4Overlay;
  const { harness, clients } = officialSetup({ officialBridgeClient: { models: async () => structuredClone(catalog) } });
  const thread = await harness.createThread();
  catalog = [hy4Overlay[0], { ...hy4Overlay[1], disabled: true, disabledReason: 'MODEL_UNAVAILABLE' }];
  await harness.refreshOfficialModels({ force: true });
  assert.equal(current(harness, thread.id).models.currentModelId, null);
  assert.equal(current(harness, thread.id).models.requestedModelId, 'hy4-preview-ioa');
  await assert.rejects(() => harness.startTurn({ threadId: thread.id, prompt: 'must remain closed' }), { code: 'OFFICIAL_MODEL_SELECTION_REQUIRED' });
  await assert.rejects(() => harness.setModel({ threadId: thread.id, model: 'hy4-preview-ioa' }), { code: 'OFFICIAL_MODEL_FORBIDDEN' });
  catalog = hy4Overlay;
  await harness.refreshOfficialModels({ force: true });
  assert.equal(current(harness, thread.id).models.currentModelId, 'hy4-preview-ioa');
  assert.equal(clients.length, 0);
});

test('explicit selection during a missing preference replaces it and is not overwritten by later Hy4 recovery', async () => {
  let catalog = hy4Overlay;
  const { harness } = officialSetup({ officialBridgeClient: { models: async () => structuredClone(catalog) } });
  const thread = await harness.createThread();
  catalog = [hy4Overlay[0]];
  await harness.refreshOfficialModels({ force: true });
  const selected = await harness.setModel({ threadId: thread.id, model: 'fast-model' });
  assert.equal(selected.models.requestedModelId, 'fast-model');
  catalog = hy4Overlay;
  await harness.refreshOfficialModels({ force: true });
  assert.equal(current(harness, thread.id).models.currentModelId, 'fast-model');
  assert.equal(current(harness, thread.id).models.requestedModelId, 'fast-model');
});

test('null current with a retained request survives restart; legacy null state retries only the configured alias', async () => {
  let catalog = hy4Overlay;
  const { harness, clients, options, root } = officialSetup({ officialBridgeClient: { models: async () => structuredClone(catalog) } });
  const thread = await harness.createThread();
  catalog = [hy4Overlay[0]];
  await harness.refreshOfficialModels({ force: true });
  await harness.close();
  const retained = new PiHarness(options); cleanups.push(() => retained.close());
  await retained.refreshOfficialModels();
  assert.equal(current(retained, thread.id).models.currentModelId, null);
  assert.equal(current(retained, thread.id).models.requestedModelId, 'hy4-preview-ioa');
  await retained.close();
  const stateFile = join(root, 'state', 'threads.json');
  const legacy = JSON.parse(readFileSync(stateFile, 'utf8'));
  delete legacy.threads[0].models.requestedModelId;
  writeFileSync(stateFile, JSON.stringify(legacy), { mode: 0o600 });
  const restoredLegacy = new PiHarness(options); cleanups.push(() => restoredLegacy.close());
  await restoredLegacy.refreshOfficialModels();
  assert.equal(current(restoredLegacy, thread.id).models.currentModelId, null);
  assert.equal(current(restoredLegacy, thread.id).models.requestedModelId, 'hy4');
  catalog = hy4Overlay;
  await restoredLegacy.refreshOfficialModels({ force: true });
  assert.equal(current(restoredLegacy, thread.id).models.currentModelId, 'hy4-preview-ioa');
  assert.equal(current(restoredLegacy, thread.id).turns.length, 0); assert.equal(clients.length, 0);
});

test('official startup overlay restores selection automatically through coalesced local polling without a prompt', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  let catalog = [hy4Overlay[0]], calls = 0;
  const { harness, clients } = officialSetup({ officialBridgeClient: { models: async () => {
    calls++; return structuredClone(catalog);
  } } });
  const thread = await harness.createThread();
  assert.equal(thread.models.currentModelId, null);
  assert.equal(calls, 1);
  catalog = hy4Overlay;
  t.mock.timers.tick(5_000);
  await tick();
  assert.equal(current(harness, thread.id).models.currentModelId, 'hy4-preview-ioa');
  assert.equal(current(harness, thread.id).models.requestedModelId, 'hy4-preview-ioa');
  assert.equal(calls, 2);
  assert.equal(current(harness, thread.id).turns.length, 0);
  assert.equal(clients.length, 0);
  await harness.close();
  t.mock.timers.tick(10_000);
  await tick();
  assert.equal(calls, 2);
});

test('native home creation preserves selected official model and empty workspace without starting a prompt', async () => {
  const { harness, clients, options } = officialSetup();
  await assert.rejects(() => harness.createThread({ model: 'disabled-model' }), { code: 'OFFICIAL_MODEL_FORBIDDEN' });
  await assert.rejects(() => harness.createThread({ model: 'missing-model' }), { code: 'INVALID_PARAMS' });
  await assert.rejects(() => harness.createThread({ workspaceAutoGenerated: 'true' }), { code: 'INVALID_PARAMS' });
  assert.equal(harness.listThreads().length, 0);
  const thread = await harness.createThread({ title: '原生首页', cwd: '', model: 'official-responses', workspaceAutoGenerated: true });
  assert.equal(thread.cwd, options.cwd);
  assert.equal(thread.workspaceAutoGenerated, true);
  assert.equal(thread.models.currentModelId, 'official-responses');
  assert.equal(clients.length, 0);
  await harness.close();
  const restored = new PiHarness(options); cleanups.push(() => restored.close());
  await restored.refreshOfficialModels();
  assert.equal(current(restored, thread.id).models.currentModelId, 'official-responses');
  assert.equal(current(restored, thread.id).workspaceAutoGenerated, true);
});

test('native send intent applies the explicit model before the first Pi call and refuses changes during a turn', async () => {
  const { harness, clients } = officialSetup();
  const thread = await harness.createThread();
  const turn = await harness.startTurn({ threadId: thread.id, prompt: 'home intent', model: 'official-responses' });
  await tick();
  assert.equal(turn.model, 'official-responses');
  assert.deepEqual(clients[0].modelCalls[0], { provider: 'workbuddy-official', modelId: 'official-responses' });
  assert.deepEqual(clients[0].prompts, ['home intent']);
  await assert.rejects(() => harness.startTurn({ threadId: thread.id, prompt: 'concurrent', model: 'hy4' }), { code: 'CONFLICT' });
  assert.equal(current(harness, thread.id).models.currentModelId, 'official-responses');
  clients[0].event({ type: 'agent_settled', aborted: false });
  await assert.rejects(() => harness.startTurn({ threadId: thread.id, prompt: 'invalid model', model: 'disabled-model' }), { code: 'OFFICIAL_MODEL_FORBIDDEN' });
  assert.equal(current(harness, thread.id).turns.length, 1);
});

test('workspace classification migrates legacy default tasks and preserves explicit project directories', async () => {
  const { harness, options, root } = officialSetup();
  const automatic = await harness.createThread();
  const project = await harness.createThread({ cwd: join(root, 'project'), workspaceAutoGenerated: false });
  await harness.close();
  const file = join(root, 'state/threads.json'), stored = JSON.parse(readFileSync(file));
  delete stored.threads.find(t => t.id === automatic.id).workspaceAutoGenerated;
  writeFileSync(file, JSON.stringify(stored));
  const restored = new PiHarness(options); cleanups.push(() => restored.close());
  assert.equal(current(restored, automatic.id).workspaceAutoGenerated, true);
  assert.equal(current(restored, project.id).workspaceAutoGenerated, false);
});

test('native task rename persists a user title without changing session or model', async () => {
  const {harness,options}=officialSetup();const thread=await harness.createThread({title:'新对话'});
  const renamed=await harness.renameThread({threadId:thread.id,title:'  原生任务名称  '});
  assert.equal(renamed.title,'原生任务名称');assert.equal(renamed.userDefinedTitle,true);assert.equal(renamed.models.currentModelId,thread.models.currentModelId);
  await harness.close();const restored=new PiHarness(options);cleanups.push(()=>restored.close());
  assert.equal(current(restored,thread.id).title,'原生任务名称');
});

test('model catalog refresh does not change task activity timestamps', async () => {
  let catalog=structuredClone(officialCatalog);
  const {harness}=officialSetup({officialBridgeClient:{models:async()=>structuredClone(catalog)}});
  const created=await harness.createThread();
  await new Promise(resolve=>setTimeout(resolve,5));
  catalog=catalog.map(m=>({...m,name:m.name+' updated'}));
  await harness.refreshOfficialModels({force:true});
  assert.equal(current(harness,created.id).updatedAt,created.updatedAt);
});

function workspaceTestRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-workspace-integration-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function nativeConfirmation(client, id, metadata) {
  client.event({ type: 'extension_ui_request', method: 'confirm', title: APPROVAL_TITLE, id,
    message: JSON.stringify({ protocol: APPROVAL_PROTOCOL, toolCallId: metadata.toolCallId, toolName: metadata.name, input: metadata.arguments }) });
}

function nativeInvocation(client, id, metadata) {
  client.event({ type: 'extension_ui_request', method: 'input', title: NATIVE_TITLE, id, placeholder: JSON.stringify(metadata) });
}

test('configured workspace root gives new tasks independent dated directories and matching Pi cwd', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 26, 10, 11, 12).getTime() });
  const workspaceRoot = join(workspaceTestRoot(), 'WorkBuddy');
  const { harness, clients } = setup({ workspaceRoot });
  const first = await harness.createThread(), second = await harness.createThread({ cwd: '' });
  assert.equal(first.cwd, join(workspaceRoot, '2026-10-26-10-11-12'));
  assert.equal(second.cwd, join(workspaceRoot, '2026-10-26-10-11-13'));
  assert.equal(first.workspaceAutoGenerated, true); assert.equal(second.workspaceAutoGenerated, true);
  assert.notEqual(first.cwd, second.cwd);
  await turnStart(harness, first); await turnStart(harness, second);
  assert.deepEqual(clients.map(client => client.options.cwd), [first.cwd, second.cwd]);
  clients.forEach(client => client.event({ type: 'agent_settled', aborted: false }));
});

test('configured workspace root preserves explicit project cwd and never allocates a default task for it', async () => {
  const base = workspaceTestRoot(), workspaceRoot = join(base, 'WorkBuddy'), project = join(base, 'project');
  mkdirSync(project); writeFileSync(join(project, 'retained.txt'), 'explicit project fixture');
  const { harness, clients } = setup({ workspaceRoot });
  const thread = await harness.createThread({ cwd: project, workspaceAutoGenerated: false });
  assert.equal(thread.cwd, project); assert.equal(thread.workspaceAutoGenerated, false); assert.equal(existsSync(workspaceRoot), false);
  await turnStart(harness, thread);
  assert.equal(clients[0].options.cwd, project);
  assert.equal(readFileSync(join(project, 'retained.txt'), 'utf8'), 'explicit project fixture');
  clients[0].event({ type: 'agent_settled', aborted: false });
});

test('invalid official model selection fails before allocating any task workspace or Pi client', async () => {
  const workspaceRoot = join(workspaceTestRoot(), 'not-created');
  const { harness, clients } = officialSetup({ workspaceRoot });
  await assert.rejects(harness.createThread({ model: 'missing-model' }), { code: 'INVALID_PARAMS' });
  await assert.rejects(harness.createThread({ model: 'disabled-model' }), { code: 'OFFICIAL_MODEL_FORBIDDEN' });
  await assert.rejects(harness.createThread({ title: ' ' }), { code: 'INVALID_PARAMS' });
  await assert.rejects(harness.createThread({ approvalMode: 'unrecognized' }), { code: 'INVALID_PARAMS' });
  assert.equal(existsSync(workspaceRoot), false); assert.equal(clients.length, 0); assert.equal(harness.listThreads().length, 0);
});

test('restart keeps dated cwd and task history when the configured workspace root changes', async () => {
  const base = workspaceTestRoot(), workspaceRoot = join(base, 'first-root');
  const { harness, clients, options } = setup({ workspaceRoot });
  const thread = await harness.createThread({ title: 'Persistent dated task' });
  await turnStart(harness, thread);
  clients[0].event({ type: 'message_start', message: { role: 'assistant' } });
  clients[0].event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'HISTORY-RETAINED' }], stopReason: 'stop' } });
  clients[0].event({ type: 'agent_settled', aborted: false });
  writeFileSync(join(thread.cwd, 'retained.txt'), 'dated workspace fixture');
  const folders = readdirSync(workspaceRoot);
  await harness.close();
  const changedRoot = join(base, 'new-root'), restored = new PiHarness({ ...options, workspaceRoot: changedRoot });
  cleanups.push(() => restored.close());
  const recovered = current(restored, thread.id);
  assert.equal(recovered.cwd, thread.cwd); assert.equal(recovered.workspaceAutoGenerated, true);
  assert.equal(recovered.turns[0].items[0].text, 'HISTORY-RETAINED');
  assert.equal(existsSync(changedRoot), false); assert.deepEqual(readdirSync(workspaceRoot), folders);
  await turnStart(restored, recovered);
  assert.equal(clients.at(-1).options.cwd, thread.cwd); assert.equal(existsSync(changedRoot), false);
  assert.equal(readFileSync(join(thread.cwd, 'retained.txt'), 'utf8'), 'dated workspace fixture');
  clients.at(-1).event({ type: 'agent_settled', aborted: false });
});

test('enabling per-task directories does not move old shared-cwd tasks or replay their history', async () => {
  const { harness, clients, options, root } = setup();
  const legacy = await harness.createThread();
  await turnStart(harness, legacy);
  clients[0].event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'LEGACY-ANSWER' }], stopReason: 'stop' } });
  clients[0].event({ type: 'agent_settled', aborted: false });
  writeFileSync(join(root, 'legacy-retained.txt'), 'do not move'); await harness.close();
  const workspaceRoot = join(workspaceTestRoot(), 'new-tasks'), before = clients.length;
  const restored = new PiHarness({ ...options, workspaceRoot }); cleanups.push(() => restored.close());
  assert.equal(current(restored, legacy.id).cwd, root); assert.equal(current(restored, legacy.id).turns[0].items[0].text, 'LEGACY-ANSWER');
  assert.equal(existsSync(workspaceRoot), false); assert.equal(clients.length, before);
  const fresh = await restored.createThread();
  assert.equal(fresh.cwd.startsWith(workspaceRoot + '/'), true); assert.notEqual(fresh.cwd, root);
  assert.equal(current(restored, legacy.id).cwd, root); assert.equal(readFileSync(join(root, 'legacy-retained.txt'), 'utf8'), 'do not move');
});

test('auto write and Bash approvals respond immediately, retain audit, and never request pending UI', async () => {
  const { harness, clients, options, root } = setup({ tools: ['read', 'write', 'bash'], approvalMode: 'auto' });
  const events = []; harness.subscribe(event => events.push(event));
  const thread = await harness.createThread(); await turnStart(harness, thread);
  clients[0].event({ type: 'tool_execution_start', toolCallId: 'write-auto-tool', toolName: 'write', args: { path: 'fixture.txt', content: 'fixture' } });
  approvalRequest(clients[0], 'write-auto-ui', 'write', 'write-auto-tool');
  approvalRequest(clients[0], 'bash-auto-ui', 'bash', 'bash-auto-tool'); await tick();
  const running = current(harness, thread.id);
  assert.equal(running.approvalMode, 'auto'); assert.equal(running.status, 'running'); assert.equal(running.turns[0].status, 'running');
  assert.equal(running.turns[0].items[0].status, 'running');
  assert.equal(events.some(event => event.type === 'interaction.requested'), false);
  assert.deepEqual(clients[0].uiResponses, [{ id: 'write-auto-ui', confirmed: true }, { id: 'bash-auto-ui', confirmed: true }]);
  assert.deepEqual(running.turns[0].interactions.map(item => ({ status: item.status, source: item.authorizationSource, response: item.response })), [
    { status: 'approved', source: 'automatic', response: { decision: 'allow-once' } },
    { status: 'approved', source: 'automatic', response: { decision: 'allow-once' } },
  ]);
  assert.ok(running.turns[0].interactions.every(item => item.respondedAt && item.requestedAt));
  const stored = JSON.parse(readFileSync(join(root, 'state/threads.json')));
  assert.equal(stored.threads[0].turns[0].interactions.every(item => item.status === 'approved'), true);
  clients[0].event({ type: 'agent_settled', aborted: false }); await harness.close();
  const restored = new PiHarness({ ...options, approvalMode: 'manual' }); cleanups.push(() => restored.close());
  assert.equal(current(restored, thread.id).approvalMode, 'auto');
  assert.equal(current(restored, thread.id).turns[0].interactions[0].authorizationSource, 'automatic');
});

test('manual mode can be restored and switching its pending dialog to auto allows that call once', async () => {
  const { harness, clients } = setup({ tools: ['read', 'write', 'bash'], approvalMode: 'auto' });
  const events = []; harness.subscribe(event => events.push(event));
  const thread = await harness.createThread();
  await harness.setApprovalMode({ threadId: thread.id, approvalMode: 'manual' });
  await turnStart(harness, thread); approvalRequest(clients[0], 'pending-manual', 'write', 'manual-call');
  const pending = current(harness, thread.id).turns[0].interactions[0];
  assert.equal(pending.status, 'pending'); assert.equal(current(harness, thread.id).status, 'waiting_for_approval');
  assert.deepEqual(clients[0].uiResponses, []);
  await harness.setApprovalMode({ threadId: thread.id, approvalMode: 'auto' });
  const resolved = current(harness, thread.id).turns[0].interactions[0];
  assert.equal(resolved.status, 'approved'); assert.equal(resolved.authorizationSource, 'auto-mode-change');
  assert.equal(current(harness, thread.id).status, 'running');
  assert.deepEqual(clients[0].uiResponses, [{ id: 'pending-manual', confirmed: true }]);
  await assert.rejects(harness.respondInteraction({ interactionId: pending.id, response: 'allow-once' }), { code: 'NOT_FOUND' });
  await harness.setApprovalMode({ threadId: thread.id, approvalMode: 'manual' });
  approvalRequest(clients[0], 'new-manual', 'bash', 'new-manual-call');
  assert.equal(current(harness, thread.id).turns[0].interactions[1].status, 'pending');
  assert.equal(events.filter(event => event.type === 'interaction.requested').length, 2);
  const denied = current(harness, thread.id).turns[0].interactions[1];
  await harness.respondInteraction({ interactionId: denied.id, response: 'reject' });
  assert.deepEqual(clients[0].uiResponses.at(-1), { id: 'new-manual', confirmed: false });
  clients[0].event({ type: 'agent_settled', aborted: false });
});

test('auto mode rejects unknown tools and duplicate confirmation UI IDs instead of broadening permission', async () => {
  for (const scenario of ['unknown', 'duplicate']) {
    const { harness, clients } = setup({ tools: ['read', 'write', 'bash'], approvalMode: 'auto' });
    const thread = await harness.createThread(); await turnStart(harness, thread);
    if (scenario === 'duplicate') {
      approvalRequest(clients[0], 'same-ui', 'write', 'first-call'); await tick();
      approvalRequest(clients[0], 'same-ui', 'bash', 'second-call');
    } else approvalRequest(clients[0], 'unknown-ui', 'unknown-tool', 'unknown-call');
    await tick();
    assert.equal(current(harness, thread.id).turns[0].status, 'failed');
    assert.equal(clients[0].closed, true);
    assert.equal(clients[0].uiResponses.at(-1).confirmed, false);
    assert.equal(current(harness, thread.id).turns[0].interactions.length, scenario === 'duplicate' ? 1 : 0);
  }
});

test('auto approval delivery failure stops the run and never leaves an unresolved dialog', async () => {
  const { harness, clients } = setup({ tools: ['read', 'write'], approvalMode: 'auto' });
  const thread = await harness.createThread(); await turnStart(harness, thread);
  clients[0].sendExtensionUiResponse = async () => { throw Error('private fixture delivery failure'); };
  approvalRequest(clients[0], 'delivery-failed', 'write', 'delivery-call'); await tick();
  const result = current(harness, thread.id).turns[0];
  assert.equal(result.status, 'failed'); assert.equal(result.interactions.some(item => item.status === 'pending'), false);
  assert.equal(clients[0].closed, true); assert.equal(JSON.stringify(result).includes('private fixture delivery failure'), false);
});

test('auto MCP authorization is exact and consumed once, including after external failure', async () => {
  const calls = [];
  const { harness, clients } = setup({ tools: ['read', 'write'], approvalMode: 'auto', nativeServices: {
    async listTools() { return [{ serverId: 'fixture', rawName: 'lookup', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }]; },
    async callTool(value) { calls.push(value); if (value.arguments.query === 'fails') throw Error('private fixture upstream'); return { content: [{ type: 'text', text: 'AUTO-MCP-OK' }] }; },
  } });
  const events = []; harness.subscribe(event => events.push(event));
  const thread = await harness.createThread(); await harness.setNativeContext({ threadId: thread.id, connectors: ['fixture'] });
  const turn = await turnStart(harness, thread), client = clients[0], name = nativeToolName('fixture', 'lookup');
  const metadata = { protocol: NATIVE_CALL, threadId: thread.id, turnId: turn.id, toolCallId: 'auto-mcp-one', name, arguments: { query: 'fixture' } };
  nativeConfirmation(client, 'mcp-approval-one', metadata); await tick();
  assert.deepEqual(client.uiResponses.at(-1), { id: 'mcp-approval-one', confirmed: true });
  nativeInvocation(client, 'mcp-wrong-arguments', { ...metadata, arguments: { query: 'unapproved' } }); await tick();
  assert.equal(calls.length, 0); assert.equal(JSON.parse(client.uiResponses.at(-1).value).ok, false);
  nativeInvocation(client, 'mcp-correct', metadata); await tick();
  assert.equal(calls.length, 1); assert.match(client.uiResponses.at(-1).value, /AUTO-MCP-OK/);
  nativeInvocation(client, 'mcp-replay', metadata); await tick();
  assert.equal(calls.length, 1); assert.equal(JSON.parse(client.uiResponses.at(-1).value).ok, false);
  const failing = { ...metadata, toolCallId: 'auto-mcp-failure', arguments: { query: 'fails' } };
  nativeConfirmation(client, 'mcp-approval-failure', failing); await tick();
  nativeInvocation(client, 'mcp-failure', failing); await tick();
  assert.equal(calls.length, 2); assert.equal(JSON.parse(client.uiResponses.at(-1).value).ok, false);
  nativeInvocation(client, 'mcp-failure-replay', failing); await tick(); assert.equal(calls.length, 2);
  nativeInvocation(client, 'unknown-native-tool', { ...metadata, name: 'unlisted-native-tool' }); await tick();
  assert.equal(calls.length, 2); assert.equal(events.some(event => event.type === 'interaction.requested'), false);
  client.event({ type: 'agent_settled', aborted: false });
});

test('auto MCP rejects reusing a native input UI ID even with a fresh exact approval', async () => {
  const calls = [];
  const { harness, clients } = setup({ tools: ['read', 'write'], approvalMode: 'auto', nativeServices: {
    async listTools() { return [{ serverId: 'fixture', rawName: 'lookup', inputSchema: { type: 'object' } }]; },
    async callTool(value) { calls.push(value); return { content: [] }; },
  } });
  const thread = await harness.createThread(); await harness.setNativeContext({ threadId: thread.id, connectors: ['fixture'] });
  const turn = await turnStart(harness, thread), client = clients[0], name = nativeToolName('fixture', 'lookup');
  const first = { protocol: NATIVE_CALL, threadId: thread.id, turnId: turn.id, toolCallId: 'first-call', name, arguments: {} };
  nativeConfirmation(client, 'first-approval-ui', first); await tick(); nativeInvocation(client, 'reused-input-ui', first); await tick();
  assert.equal(calls.length, 1);
  const second = { ...first, toolCallId: 'second-call' };
  nativeConfirmation(client, 'second-approval-ui', second); await tick();
  const responsesBeforeReplay = client.uiResponses.length;
  nativeInvocation(client, 'reused-input-ui', second); await tick();
  assert.equal(calls.length, 1);
  assert.equal(client.uiResponses.length, responsesBeforeReplay);
  assert.equal(client.uiResponses.filter(value => value.id === 'reused-input-ui').length, 1);
  client.event({ type: 'agent_settled', aborted: false });
});

test('unapproved native input UI ID cannot be reused after a later automatic approval', async () => {
  const calls = [];
  const { harness, clients } = setup({ tools: ['read', 'write'], approvalMode: 'auto', nativeServices: {
    async listTools() { return [{ serverId: 'fixture', rawName: 'lookup', inputSchema: { type: 'object' } }]; },
    async callTool(value) { calls.push(value); return { content: [] }; },
  } });
  const thread = await harness.createThread(); await harness.setNativeContext({ threadId: thread.id, connectors: ['fixture'] });
  const turn = await turnStart(harness, thread), client = clients[0];
  const metadata = { protocol: NATIVE_CALL, threadId: thread.id, turnId: turn.id, toolCallId: 'initially-unapproved', name: nativeToolName('fixture', 'lookup'), arguments: {} };
  nativeInvocation(client, 'unapproved-input-ui', metadata); await tick();
  assert.equal(calls.length, 0); assert.equal(JSON.parse(client.uiResponses.at(-1).value).ok, false);
  nativeConfirmation(client, 'later-approval-ui', metadata); await tick();
  const responsesBeforeReplay = client.uiResponses.length;
  nativeInvocation(client, 'unapproved-input-ui', metadata); await tick();
  assert.equal(calls.length, 0); assert.equal(client.uiResponses.length, responsesBeforeReplay);
  nativeInvocation(client, 'fresh-approved-input-ui', metadata); await tick();
  assert.equal(calls.length, 1); assert.equal(JSON.parse(client.uiResponses.at(-1).value).ok, true);
  client.event({ type: 'agent_settled', aborted: false });
});

test('cancelling auto MCP aborts the live call, discards its late result and ignores replayed authorization', async () => {
  let enter, release, signal;
  const started = new Promise(resolve => { enter = resolve; }), result = new Promise(resolve => { release = resolve; });
  const calls = [];
  const { harness, clients } = setup({ tools: ['read', 'write'], approvalMode: 'auto', nativeServices: {
    async listTools() { return [{ serverId: 'fixture', rawName: 'lookup', inputSchema: { type: 'object' } }]; },
    async callTool(value) { calls.push(value); signal = value.signal; enter(); return result; },
  } });
  const thread = await harness.createThread(); await harness.setNativeContext({ threadId: thread.id, connectors: ['fixture'] });
  const turn = await turnStart(harness, thread), client = clients[0];
  const metadata = { protocol: NATIVE_CALL, threadId: thread.id, turnId: turn.id, toolCallId: 'cancel-mcp-call', name: nativeToolName('fixture', 'lookup'), arguments: {} };
  nativeConfirmation(client, 'cancel-mcp-approval', metadata); await tick(); nativeInvocation(client, 'cancel-mcp-input', metadata); await started;
  const cancellation = harness.cancelTurn({ threadId: thread.id });
  assert.equal(signal.aborted, true);
  client.event({ type: 'agent_settled', aborted: true }); await cancellation;
  release({ content: [{ type: 'text', text: 'LATE-RESULT-MUST-NOT-APPEAR' }] }); await tick();
  nativeInvocation(client, 'cancel-mcp-replay', metadata); nativeConfirmation(client, 'cancel-late-approval', metadata); await tick();
  assert.equal(calls.length, 1); assert.equal(client.closed, true);
  assert.equal(client.uiResponses.some(value => value.id === 'cancel-mcp-input'), false);
  assert.equal(current(harness, thread.id).turns[0].status, 'cancelled');
  assert.equal(JSON.stringify(current(harness, thread.id)).includes('LATE-RESULT-MUST-NOT-APPEAR'), false);
});

const windowCatalog = [
  { id: 'hy4', name: 'Hy4', provider: 'workbuddy-official', api: 'openai-completions', contextWindow: 300000, maxTokens: 64000, maxInputTokens: 960000, supportedContextWindows: [300000, 600000, 960000] },
  { id: 'small', name: 'Small', provider: 'workbuddy-official', api: 'openai-completions', contextWindow: 64000, maxTokens: 8192, maxInputTokens: 128000, supportedContextWindows: [64000, 128000] },
];
function windowSetup(overrides = {}) {
  return officialSetup({ officialBridgeClient: { models: async () => structuredClone(windowCatalog) }, ...overrides });
}

test('context windows are isolated by thread and model, survive restart, and enter each fresh Pi process', async () => {
  const { harness, clients, options } = windowSetup();
  const a = await harness.createThread(), b = await harness.createThread();
  assert.equal(a.contextWindow, 300000);
  await harness.setContextWindow({ threadId: a.id, contextWindow: 960000 });
  assert.equal(current(harness, b.id).contextWindow, 300000);
  await turnStart(harness, a);
  assert.deepEqual(JSON.parse(clients[0].options.env.WORKBUDDY_PI_CONTEXT_WINDOWS), { hy4: 960000 });
  await assert.rejects(harness.setContextWindow({ threadId: a.id, contextWindow: 600000 }), { code: 'CONFLICT' });
  clients[0].event({ type: 'agent_settled', aborted: false });
  await harness.setContextWindow({ threadId: a.id, contextWindow: 600000 });
  assert.equal(clients[0].closed, true);
  await harness.setModel({ threadId: a.id, model: 'small' });
  assert.equal(current(harness, a.id).contextWindow, 64000);
  for (const invalid of [960000, 100000, 0, -1, '128000', NaN, Infinity]) await assert.rejects(harness.setContextWindow({ threadId: a.id, contextWindow: invalid }), { code: 'INVALID_PARAMS' });
  await harness.setContextWindow({ threadId: a.id, contextWindow: 128000 });
  await turnStart(harness, a);
  assert.deepEqual(JSON.parse(clients.at(-1).options.env.WORKBUDDY_PI_CONTEXT_WINDOWS), { hy4: 600000, small: 128000 });
  clients.at(-1).event({ type: 'agent_settled', aborted: false });
  await harness.setModel({ threadId: a.id, model: 'hy4' });
  assert.equal(current(harness, a.id).contextWindow, 600000);
  await harness.close(); const restored = new PiHarness(options); cleanups.push(() => restored.close()); await restored.refreshOfficialModels();
  assert.equal(current(restored, a.id).contextWindow, 600000); assert.equal(current(restored, b.id).contextWindow, 300000);
  await restored.setModel({ threadId: a.id, model: 'small' }); assert.equal(current(restored, a.id).contextWindow, 128000);
  await restored.setModel({ threadId: a.id, model: 'hy4' }); await restored.setContextWindow({ threadId: a.id, contextWindow: null });
  assert.equal(current(restored, a.id).contextWindow, 300000);
});

test('cold context stats use the selected budget without touching the original session or calling a model', async () => {
  const { harness, options, root } = windowSetup(); const thread = await harness.createThread();
  await harness.setContextWindow({ threadId: thread.id, contextWindow: 960000 }); await harness.close();
  const session = join(options.stateDir, 'sessions', `${thread.id}.jsonl`); const bytes = 'synthetic read-only session copy\n'; writeFileSync(session, bytes);
  const stats = [];
  const restored = new PiHarness({ ...options, clientFactory: launch => {
    const client = new FakeClient(launch); const window = JSON.parse(launch.env.WORKBUDDY_PI_CONTEXT_WINDOWS).hy4 ?? 300000;
    client.modelState = { id: 'hy4', contextWindow: window, maxTokens: 64000 };
    client.sessionStats = { contextUsage: { tokens: 60000, contextWindow: window, percent: 60000 / window * 100 } };
    stats.push(client); return client;
  } }); cleanups.push(() => restored.close()); await restored.refreshOfficialModels();
  const summary = await restored.refreshContextUsage({ threadId: thread.id });
  assert.equal(summary.contextWindow, 960000); assert.equal(summary.tokens, 60000); assert.equal(summary.percent, 6.25);
  assert.equal(stats.length, 1); assert.equal(stats[0].options.args.includes('--no-tools'), true); assert.equal(stats[0].prompts.length, 0); assert.equal(stats[0].closed, true);
  assert.equal(readFileSync(session, 'utf8'), bytes);
});

test('a delayed old stats refresh cannot restore the old window after a selection change', async () => {
  const { harness, options } = windowSetup(); const thread = await harness.createThread(); await harness.close();
  writeFileSync(join(options.stateDir, 'sessions', `${thread.id}.jsonl`), 'synthetic session\n');
  let release, entered; const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { entered = resolve; }); let calls = 0;
  const restored = new PiHarness({ ...options, clientFactory: launch => {
    const client = new FakeClient(launch); const window = JSON.parse(launch.env.WORKBUDDY_PI_CONTEXT_WINDOWS).hy4 ?? 300000;
    client.modelState = { id: 'hy4', contextWindow: window }; client.sessionStats = { contextUsage: { tokens: 10, contextWindow: window, percent: 10 / window * 100 } };
    if (++calls === 1) { client.statsGate = gate; client.getSessionStats = async () => { entered(); await gate; return client.sessionStats; }; }
    return client;
  } }); cleanups.push(() => restored.close()); await restored.refreshOfficialModels();
  const old = restored.refreshContextUsage({ threadId: thread.id }); await ready;
  const change = restored.setContextWindow({ threadId: thread.id, contextWindow: 960000 }); await tick();
  release(); await Promise.all([old, change]);
  const summary = await restored.refreshContextUsage({ threadId: thread.id });
  assert.equal(summary.contextWindow, 960000); assert.equal(current(restored, thread.id).contextWindow, 960000);
});

test('context changes fail without saving a preference if an existing Pi process cannot close', async () => {
  const { harness, clients } = windowSetup(); const thread = await harness.createThread(); await turnStart(harness, thread);
  clients[0].event({ type: 'agent_settled', aborted: false }); clients[0].close = async () => { throw Error('fixture close failure'); };
  await assert.rejects(harness.setContextWindow({ threadId: thread.id, contextWindow: 960000 }), { code: 'UNAVAILABLE' });
  assert.equal(current(harness, thread.id).contextWindow, 300000); assert.deepEqual(current(harness, thread.id).contextWindows, {});
});

test('idle context statistics discard a cached model when the authoritative default changes', async () => {
  const catalog = structuredClone(windowCatalog), observed = [];
  const { harness, options } = windowSetup({ officialBridgeClient: { models: async () => structuredClone(catalog) }, clientFactory: launch => {
    const client = new FakeClient(launch); const window = JSON.parse(launch.env.WORKBUDDY_PI_CONTEXT_WINDOWS).hy4 ?? catalog[0].contextWindow;
    client.modelState = { id: 'hy4', contextWindow: window }; client.sessionStats = { contextUsage: { tokens: 20, contextWindow: window, percent: 20 / window * 100 } };
    observed.push(client); return client;
  } });
  const thread = await harness.createThread(); await turnStart(harness, thread); observed[0].event({ type: 'agent_settled', aborted: false }); await tick();
  const session = join(options.stateDir, 'sessions', `${thread.id}.jsonl`); writeFileSync(session, 'synthetic session\n');
  catalog[0].contextWindow = 600000; await harness.refreshOfficialModels({ force: true });
  const summary = await harness.refreshContextUsage({ threadId: thread.id });
  assert.equal(summary.contextWindow, 600000); assert.equal(observed[0].closed, true);
  assert.equal(observed.at(-1).options.args.includes('--no-tools'), true); assert.equal(observed.at(-1).prompts.length, 0);
  assert.equal(readFileSync(session, 'utf8'), 'synthetic session\n');
});
