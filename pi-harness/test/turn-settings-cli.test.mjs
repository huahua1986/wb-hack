import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { PiRpcClient } from '../src/pi-rpc.mjs';
const { ensureTurnRuntime, TURN_SETTINGS_ENV, TURN_SETTINGS_READY } = await import(process.env.PI_TEST_SETTINGS_MODULE || '../src/turn-settings.mjs');
const { startOfficialModelBridge } = createRequire(import.meta.url)(process.env.PI_TEST_HARNESS_MODULE
  ? path.join(path.dirname(process.env.PI_TEST_HARNESS_MODULE), 'official-model-bridge.cjs') : '../src/official-model-bridge.cjs');

test('real Pi applies reasoning/compaction settings, native zero threshold and overflow recovery after restart', {
  skip: !process.env.PI_TEST_COMMAND, timeout: 45000,
}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync('/private/tmp/pi-settings-cli-'));
  const stateDir = path.join(root, 'state'), bridgeDir = path.join(root, 'bridge'); fs.mkdirSync(stateDir, { mode: 0o700 });
  const model = { id: 'settings-fixture', provider: 'workbuddy-official', contextWindow: 8192, maxTokens: 512, reasoning: true,
    capabilities: { onlyReasoning: true, reasoning: { defaultEffort: 'high', supportedEfforts: ['high'], canDisableThinking: false, summary: 'auto' } } };
  const threadId = 'pi-thread-00000000-0000-4000-8000-000000000005', turnId = 'pi-turn-00000000-0000-4000-8000-000000000001';
  let runtime = ensureTurnRuntime({ stateDir, threadId, model, settings: { preMessageCompactPct: 80 }, baseSettings: { retry: { enabled: false } } });
  const contextFile = path.join(root, 'request.json'); fs.writeFileSync(contextFile, JSON.stringify({ threadId, turnId }), { mode: 0o600 });
  const sessionFile = path.join(root, 'session.jsonl');
  const requests = [], events = []; let phase = 'history', failure, client;
  const session = { account: { uid: 'settings-fixture-user' }, auth: { accessToken: 'synthetic-official-fixture' } };
  const product = { endpoint: 'https://www.workbuddy.cn', models: [{ id: model.id, contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens, supportsReasoning: true, onlyReasoning: true, supportsImages: false, reasoning: model.capabilities.reasoning }] };
  const bridge = await startOfficialModelBridge({ bridgeDir,
    authenticationManager: { currentSessionSubject: { getValue: () => session, subscribe: () => ({ unsubscribe() {} }) }, waitForSessionRefresh: async () => {}, refreshSessionForAuthenticationFailure: async () => {} },
    productManager: { waitConfiguration: async () => product, getEndpoint: () => product.endpoint },
    productEnvService: { getCurrent: async () => '' },
    restOperations: { async request(request) {
      try {
        const body = request.data; assert.equal(body.reasoning_effort, 'high'); assert.ok(!Object.hasOwn(body, '__workbuddy_pi_thinking_level'));
        requests.push({ phase, text: body.messages.map(m => typeof m.content === 'string' ? m.content
          : Array.isArray(m.content) ? m.content.map(part => part.text ?? '').join('') : '').join('\n') });
        if (phase === 'restart') assert.ok(requests.at(-1).text.includes('SETTINGS_COMPACTION_OK'), 'Restored model context must include the generated summary');
        const inPhase = requests.filter(r => r.phase === phase).length;
        if (phase === 'overflow' && inPhase === 1) return { status: 400, data: { error: { code: 'context_length_exceeded', message: 'Synthetic context overflow fixture' } } };
        if (phase === 'overflow' && inPhase === 3) assert.ok(requests.at(-1).text.includes('SETTINGS_OVERFLOW_SUMMARY'), 'Overflow retry must use the generated summary');
        const answer = phase === 'compact' ? 'SETTINGS_COMPACTION_OK\nThe synthetic user asked for numbered fixture replies; no tools or business data were used.'
          : phase === 'restart' ? 'SETTINGS_RESTART_OK' : phase === 'auto' ? inPhase === 1 ? 'SETTINGS_AUTO_SUMMARY' : 'SETTINGS_AUTO_OK'
          : phase === 'zero' ? 'SETTINGS_ZERO_OK' : phase === 'overflow' ? inPhase === 2 ? 'SETTINGS_OVERFLOW_SUMMARY' : 'SETTINGS_OVERFLOW_OK'
          : `SETTINGS_HISTORY_${requests.length}`;
        const inputTokens = phase === 'history' ? requests.length * 2000 : phase === 'restart' ? 1000 : 100;
        const usage = { prompt_tokens: inputTokens, completion_tokens: 20, total_tokens: inputTokens + 20 };
        const frame = (delta, finish, tokens) => `data: ${JSON.stringify({ id: 'settings-fixture', object: 'chat.completion.chunk', created: 1,
          model: model.id, choices: [{ index: 0, delta, finish_reason: finish }], ...(tokens ? { usage: tokens } : {}) })}\n\n`;
        return { status: 200, data: Readable.from([frame({ role: 'assistant', content: answer }, null), frame({}, 'stop', usage), 'data: [DONE]\n\n']) };
      } catch (error) { failure = error; throw error; }
    } },
  });
  t.after(async () => { await client?.close(); await bridge.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const extraArgs = JSON.parse(process.env.PI_TEST_ARGS ?? '[]');
  function create() {
    const next = new PiRpcClient({ command: process.env.PI_TEST_COMMAND,
      args: [...extraArgs, '--mode', 'rpc', '--provider', model.provider, '--model', model.id, '--thinking', runtime.effective.thinkingLevel,
        '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-mcp', '--no-context-files', '--offline', '--tools', 'read',
        '--extension', process.env.PI_TEST_EXTENSION ?? fileURLToPath(new URL('../src/official-provider-extension.ts', import.meta.url)),
        '--extension', process.env.PI_TEST_SETTINGS_EXTENSION ?? fileURLToPath(new URL('../src/turn-settings-extension.mjs', import.meta.url)), '--session', sessionFile],
      cwd: root, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: runtime.agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0',
        WORKBUDDY_PI_OFFICIAL_BRIDGE_DIR: bridgeDir, WORKBUDDY_PI_REQUEST_CONTEXT_FILE: contextFile, [TURN_SETTINGS_ENV]: runtime.extensionValue }, timeoutMs: 15000 });
    next.on('event', event => events.push(event)); next.on('failure', () => {}); return next;
  }
  const wait = async predicate => {
    const deadline = Date.now() + 15000;
    while (!predicate()) { if (failure) throw failure; if (Date.now() > deadline) throw Error('Settings fixture did not settle: ' + JSON.stringify({ requests: requests.map(r => r.phase), events: events.slice(-12).map(e => ({ type: e.type, level: e.level, stopReason: e.message?.stopReason, error: e.message?.errorMessage, reason: e.reason })) })); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  client = create();
  const actual = await client.getState(); assert.equal(actual.thinkingLevel, 'high');
  assert.deepEqual((await client.request('get_available_thinking_levels')).levels, ['high']);
  assert.ok(events.some(e => e.type === 'extension_ui_request' && e.message === TURN_SETTINGS_READY));
  for (let i = 0; i < 3; i++) {
    const from = events.length; await client.prompt(`Fixture round ${i}. ${'Q'.repeat(8000)}`);
    await wait(() => events.slice(from).some(e => e.type === 'agent_settled'));
  }
  assert.equal(requests.length, 3, 'The 80% threshold must not generate a hidden summary before manual compact');
  phase = 'compact'; const compacted = await client.request('compact', {}, { timeoutMs: 20000 });
  assert.ok(compacted.summary.includes('SETTINGS_COMPACTION_OK')); assert.ok(compacted.estimatedTokensAfter < compacted.tokensBefore);
  assert.ok(fs.readFileSync(sessionFile, 'utf8').includes('"type":"compaction"'));
  const afterCompactBytes = fs.readFileSync(sessionFile);
  await client.close(); client = create(); assert.equal((await client.getState()).thinkingLevel, 'high');
  assert.deepEqual(fs.readFileSync(sessionFile), afterCompactBytes, 'Cold settings initialization must not rewrite the existing compacted transcript');
  phase = 'restart'; const from = events.length; await client.prompt('Return only the fixture marker from the summary.');
  await wait(() => events.slice(from).some(e => e.type === 'agent_settled'));
  if (failure) throw failure;
  assert.deepEqual(requests.map(r => r.phase), ['history', 'history', 'history', 'compact', 'restart']);
  await client.close(); runtime = ensureTurnRuntime({ stateDir, threadId, model, settings: { preMessageCompactPct: 5 }, baseSettings: { retry: { enabled: false } } });
  client = create(); await client.getState(); phase = 'auto'; const autoFrom = events.length;
  await client.prompt('Automatic compaction fixture. ' + 'R'.repeat(6000));
  await wait(() => events.slice(autoFrom).some(e => e.type === 'agent_settled'));
  assert.ok(events.slice(autoFrom).some(e => e.type === 'compaction_start' && e.reason === 'threshold'));
  assert.equal(requests.filter(r => r.phase === 'auto').length, 2, '5% runtime setting must produce a real automatic summary and the requested answer');
  await client.close(); runtime = ensureTurnRuntime({ stateDir, threadId, model, settings: { preMessageCompactPct: 0 }, baseSettings: { retry: { enabled: false } } });
  client = create(); await client.getState(); phase = 'zero'; const zeroFrom = events.length;
  for (let i = 0; i < 2; i++) {
    const from = events.length; await client.prompt('Zero threshold fixture. ' + 'S'.repeat(6000));
    await wait(() => events.slice(from).some(e => e.type === 'agent_settled'));
  }
  assert.ok(!events.slice(zeroFrom).some(e => e.type === 'compaction_start'));
  assert.equal(requests.filter(r => r.phase === 'zero').length, 2, '0% disables proactive compaction, never requesting an immediate summary');
  phase = 'overflow'; const overflowFrom = events.length;
  await client.prompt('Handle only the synthetic provider overflow and then return its fixture marker.');
  await wait(() => events.slice(overflowFrom).some(e => e.type === 'agent_settled'));
  assert.ok(events.slice(overflowFrom).some(e => e.type === 'compaction_start' && e.reason === 'overflow'), 'Native 0% must retain real provider-overflow recovery: '
    + JSON.stringify({ requests: requests.filter(r => r.phase === 'overflow').length, events: events.slice(overflowFrom).map(e => ({ type: e.type, reason: e.reason, stopReason: e.message?.stopReason, error: e.message?.errorMessage })) }));
  assert.equal(requests.filter(r => r.phase === 'overflow').length, 3, 'Overflow has one rejected request, one real summary and exactly one retry');
  assert.ok(events.slice(overflowFrom).some(e => e.type === 'message_end' && e.message?.content?.some(part => part.text?.includes('SETTINGS_OVERFLOW_OK'))));
  if (failure) throw failure;
});
