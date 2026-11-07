import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/pi-140-contract.json', import.meta.url)));
const source = name => {
  const slice = fixture.slices.find(value => value.name === name);
  assert.ok(slice, `Missing original Pi 1.4.0 source slice: ${name}`);
  assert.equal(createHash('sha256').update(slice.source).digest('hex'), slice.sha256);
  return slice.source;
};
const plain = value => JSON.parse(JSON.stringify(value));

function dialogs() {
  const records = [], pending = new Map();
  let sequence = 0;
  const context = vm.createContext({
    crypto: { randomUUID: () => `fixture-pi-140-dialog-${++sequence}` },
    output: record => records.push(plain(record)), pendingExtensionRequests: pending,
    setTimeout, clearTimeout, theme: {},
  });
  const ui = new vm.Script(`${source('dialogPromise')}\n${source('rpcUIContext')}\ncreateExtensionUIContext();`).runInContext(context);
  const respond = new vm.Script(`(function(parsed) { ${source('uiResponseDispatch')} })`).runInContext(context);
  return { ui, respond, records, pending };
}

function commandHandler(session, records) {
  return vm.runInNewContext(`(async function(command) {
    const id = command.id;
    switch(command.type) {
      ${['promptCase', 'abortCase', 'getStateCase', 'getSessionStatsCase'].map(source).join('\n')}
    }
  })`, {
    session, output: value => records.push(plain(value)),
    success: (id, command, data) => ({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) }),
    error: (id, command) => ({ id, type: 'response', command, success: false }),
  });
}

test('Pi 1.4.0 namespace, entrypoint contract and source provenance are pinned', () => {
  assert.equal(fixture.version, '1.4.0');
  assert.equal(fixture.name, '@earendil-works/pi-coding-agent');
  assert.equal(fixture.repository.url, 'git+https://github.com/earendil-works/pi.git');
  assert.equal(fixture.nodeRequirement, '>=22.19.0');
  assert.match(fixture.npmIntegrity, /^sha512-/);
  for (const slice of fixture.slices) source(slice.name);
  for (const comparison of fixture.rpcComparisonTo110) {
    assert.equal(comparison.identical, true, comparison.member);
    assert.equal(comparison.currentSHA256, comparison.baselineSHA256);
  }
});

test('original get_state and get_session_stats return different authoritative data', async () => {
  const stats = { tokens: { total: 500000 }, contextUsage: { tokens: 85, contextWindow: 32768, percent: 85 / 32768 * 100 } };
  const session = { model: { id: 'fixture', contextWindow: 32768, maxTokens: 512 },
    messages: [], sessionId: 'private-fixture', thinkingLevel: 'off', getSessionStats: () => stats };
  const handle = commandHandler(session, []);
  const state = await handle({ id: 'state', type: 'get_state' });
  assert.equal(state.data.model, session.model);
  assert.equal(Object.hasOwn(state.data, 'contextUsage'), false);
  const response = await handle({ id: 'stats', type: 'get_session_stats' });
  assert.equal(response.data, stats);
  assert.equal(response.data.contextUsage.tokens, 85);
  assert.notEqual(response.data.contextUsage.tokens, response.data.tokens.total);
  assert.doesNotMatch(source('rpcTypes'), /type: "get_context_usage"/);
});

test('original prompt ACK is preflight acceptance and abort waits for session cancellation', async () => {
  const records = [];
  let promptOptions, releaseAbort;
  const abortGate = new Promise(resolve => { releaseAbort = resolve; });
  const handle = commandHandler({
    prompt(message, options) { assert.equal(message, 'synthetic prompt'); promptOptions = options; options.preflightResult('started'); return Promise.resolve(); },
    async abort() { await abortGate; },
  }, records);
  assert.equal(await handle({ id: 'prompt', type: 'prompt', message: 'synthetic prompt' }), undefined);
  assert.equal(promptOptions.source, 'rpc');
  assert.deepEqual(records, [{ id: 'prompt', type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } }]);
  assert.ok(!records.some(record => record.type === 'agent_settled'));
  let resolved = false;
  const pending = handle({ id: 'abort', type: 'abort' }).then(value => { resolved = true; return value; });
  await Promise.resolve();
  assert.equal(resolved, false);
  releaseAbort();
  assert.equal((await pending).command, 'abort');
  assert.match(source('settledSubscription'), /event\.type === "agent_settled"/);
});

test('original confirm/input preserve Pi dialog ID and replies emit no command ACK', async () => {
  const { ui, respond, records, pending } = dialogs();
  const confirmation = ui.confirm('Fixture approval', 'Synthetic tool', { timeout: 1000 });
  assert.deepEqual(records[0], { type: 'extension_ui_request', id: 'fixture-pi-140-dialog-1',
    method: 'confirm', title: 'Fixture approval', message: 'Synthetic tool', timeout: 1000 });
  respond({ type: 'extension_ui_response', id: records[0].id, confirmed: true });
  assert.equal(await confirmation, true);
  assert.equal(records.length, 1);
  assert.equal(pending.size, 0);
  const input = ui.input('Fixture native bridge', 'Synthetic metadata', { timeout: 1000 });
  assert.equal(records[1].method, 'input');
  assert.equal(records[1].placeholder, 'Synthetic metadata');
  respond({ type: 'extension_ui_response', id: records[1].id, value: 'synthetic-result' });
  assert.equal(await input, 'synthetic-result');
  assert.equal(records.length, 2);
  assert.equal(pending.size, 0);
});

test('original dialog abort and timeout are fail-closed and clean pending requests', async () => {
  const { ui, records, pending } = dialogs();
  const before = new AbortController(); before.abort();
  assert.equal(await ui.confirm('Denied', 'Already aborted', { signal: before.signal }), false);
  assert.equal(records.length, 0);
  const controller = new AbortController();
  const input = ui.input('Cancelled', 'Synthetic metadata', { signal: controller.signal });
  controller.abort();
  assert.equal(await input, undefined);
  assert.equal(pending.size, 0);
  assert.equal(await ui.confirm('Timed out', 'Synthetic tool', { timeout: 5 }), false);
  assert.equal(pending.size, 0);
});

test('extension execute/tool_call and old namespace imports remain compatible', () => {
  assert.match(source('toolDefinition'), /execute\(toolCallId: string, params: Static<TParams>, signal: AbortSignal \| undefined, onUpdate: AgentToolUpdateCallback<TDetails> \| undefined, ctx: ExtensionToolContext\)/);
  assert.match(source('toolCall'), /toolCallId: string/);
  assert.match(source('toolCall'), /parentToolCallId\?: string/);
  assert.match(source('toolCallResult'), /block\?: boolean/);
  assert.match(source('toolCallResult'), /terminate\?: boolean/);
  const aliases = source('loaderAliases');
  for (const namespace of ['@earendil-works', '@mariozechner']) {
    assert.ok(aliases.includes(`"${namespace}/pi-ai": piAiCompatEntry`));
    assert.ok(aliases.includes(`"${namespace}/pi-ai/models": piAiModelsEntry`));
    assert.ok(aliases.includes(`"${namespace}/pi-coding-agent": piCodingAgentEntry`));
  }
});

test('1.4 custom before_agent_start has no guaranteed prompt, while user prompt and system override remain supported', () => {
  const types = source('beforeAgentStart');
  assert.match(types, /BeforeAgentStartUserEvent[\s\S]*messageType: "user";[\s\S]*prompt: string/);
  assert.match(types, /BeforeAgentStartCustomEvent[\s\S]*messageType: "custom";[\s\S]*message: CustomMessage/);
  assert.match(types, /readonly systemPrompt: string/);
  assert.match(types, /BeforeAgentStartUserEvent \| BeforeAgentStartCustomEvent/);
});

test('current context usage remains an estimate with explicit null after compaction, never cumulative billing', () => {
  assert.match(source('contextType'), /tokens: number \| null/);
  assert.match(source('getContextUsage'), /tokens: null, contextWindow, percent: null/);
  assert.match(source('getContextUsage'), /estimateProjectedContextTokens\(projection, branch\)/);
  assert.match(source('limitsModel'), /routedModel\?\.model \?\? this\.model/);
  assert.match(source('getSessionStats'), /contextUsage: this\.getContextUsage\(\)/);
  assert.match(source('getSessionStats'), /this\.sessionManager\.getEntries\(\)/);
  assert.match(source('usageFormula'), /usage\.totalTokens \|\| usage\.input \+ usage\.output \+ usage\.cacheRead \+ usage\.cacheWrite/);
});

test('actual Pi grep/find work offline using only bundled tools and an empty private agent bin', {
  skip: !process.env.PI_TEST_TOOLS_DIR || !process.env.PI_TEST_SDK_ROOT,
  timeout: 15_000,
}, t => {
  const tools = realpathSync(process.env.PI_TEST_TOOLS_DIR);
  const sdk = realpathSync(process.env.PI_TEST_SDK_ROOT);
  assert.ok(isAbsolute(tools) && isAbsolute(sdk));
  assert.equal(JSON.parse(readFileSync(join(sdk, 'package.json'))).version, process.env.PI_TEST_EXPECTED_VERSION ?? '1.4.0');
  const provenance = JSON.parse(readFileSync(join(tools, 'provenance.json')));
  const manifest = process.env.PI_TEST_BUILD_MANIFEST ? JSON.parse(readFileSync(process.env.PI_TEST_BUILD_MANIFEST)) : null;
  if (manifest) { assert.ok(['0.4.0', '0.4.1', '0.4.2', '0.4.3', '0.4.4', '0.4.5', '0.4.6', '0.4.7', '0.4.8', '0.4.9', '0.4.10', '0.4.11', '0.4.12', '0.4.13'].includes(manifest.buildVersion)); assert.equal(manifest.pi.version, process.env.PI_TEST_EXPECTED_VERSION ?? '1.4.0'); }
  for (const entry of provenance.files) {
    assert.ok(!isAbsolute(entry.path) && !entry.path.split('/').includes('..'));
    const filename = join(tools, entry.path);
    const stat = lstatSync(filename);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    const expectedSHA256 = manifest && ['rg', 'fd'].includes(entry.path) ? manifest.pi.tools.signedBinaries[entry.path] : entry.sha256;
    assert.equal(createHash('sha256').update(readFileSync(filename)).digest('hex'), expectedSHA256);
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-pi-140-tools-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, 'agent');
  mkdirSync(agentDir, { mode: 0o700 });
  mkdirSync(join(agentDir, 'bin'), { mode: 0o700 });
  writeFileSync(join(root, 'financial-fixture.txt'), 'OFFLINE_TOOL_FIXTURE_2048\n', { mode: 0o600 });
  const rgConfig = join(root, 'must-not-apply-rg-config');
  writeFileSync(rgConfig, '--fixed-strings\n', { mode: 0o600 });
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    import { readdirSync } from 'node:fs';
    const [sdk, root, agent] = process.argv.slice(1);
    const load = path => import(pathToFileURL(join(sdk, path)).href);
    const manager = await load('dist/utils/tools-manager.js');
    assert.equal(manager.getToolPath('rg'), 'rg');
    assert.equal(manager.getToolPath('fd'), 'fd');
    const { createGrepToolDefinition } = await load('dist/core/tools/grep.js');
    const { createFindToolDefinition } = await load('dist/core/tools/find.js');
    const grep = await createGrepToolDefinition(root).execute('fixture-grep',
      { pattern: 'OFFLINE_TOOL_FIXTURE_[0-9]+', path: root }, undefined, undefined, { cwd: root });
    assert.ok(grep.content.some(part => part.text?.includes('OFFLINE_TOOL_FIXTURE_2048')));
    const find = await createFindToolDefinition(root).execute('fixture-find',
      { pattern: '*.txt', path: root }, undefined, undefined, { cwd: root });
    assert.ok(find.content.some(part => part.text?.includes('financial-fixture.txt')));
    assert.deepEqual(readdirSync(join(agent, 'bin')), []);
    process.stdout.write(JSON.stringify({ grep: true, find: true, offline: process.env.PI_OFFLINE === '1',
      privateAgentBinEmpty: true, ripgrepUserConfigIgnored: true }) + '\n');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, sdk, root, agentDir], {
    cwd: root, env: { HOME: root, PATH: tools, TMPDIR: root, PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1', PI_TELEMETRY: '0', RIPGREP_CONFIG_PATH: rgConfig },
    encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(result.stdout), { grep: true, find: true, offline: true,
    privateAgentBinEmpty: true, ripgrepUserConfigIgnored: true });
  assert.deepEqual(readdirSync(join(agentDir, 'bin')), []);
});
