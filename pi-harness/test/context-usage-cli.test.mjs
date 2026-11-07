import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const { PiHarness } = process.env.PI_TEST_HARNESS_MODULE
  ? await import(pathToFileURL(process.env.PI_TEST_HARNESS_MODULE).href) : await import('../src/pi-harness.mjs');
import { PiRpcClient } from '../src/pi-rpc.mjs';

// Explicit opt-in runs real Pi against synthetic loopback responses and private
// HOME/agent/session directories. No user session, official account or model is used.
test('actual Pi context stats auto-refresh and cold legacy refresh preserve the original session without model/tool calls', {
  skip: !process.env.PI_TEST_COMMAND,
  timeout: 45_000,
}, async t => {
  const officialExtension = process.env.PI_TEST_EXTENSION
    ?? fileURLToPath(new URL('../src/official-provider-extension.ts', import.meta.url));
  assert.ok(isAbsolute(officialExtension));
  const extensionStat = lstatSync(officialExtension);
  assert.ok(extensionStat.isFile() && !extensionStat.isSymbolicLink());
  const args = JSON.parse(process.env.PI_TEST_ARGS ?? '[]');
  assert.ok(Array.isArray(args) && args.every(value => typeof value === 'string'));

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-pi-context-cli-')));
  const agentDir = join(root, 'agent'), stateDir = join(root, 'state');
  const bridgeDir = join(root, 'bridge'), temporaryDir = join(root, 'tmp');
  for (const path of [agentDir, stateDir, bridgeDir, temporaryDir]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: {} }), { mode: 0o600 });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false } }), { mode: 0o600 });
  const ticket = 'fake-context-fixture-capability-no-official-credentials';
  const model = { id: 'hy4', name: 'Context fixture', api: 'openai-completions',
    contextWindow: 32768, maxTokens: 512, reasoning: false, input: ['text'], supportsToolCall: true };
  const usage = [
    { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230 },
    { prompt_tokens: 80, completion_tokens: 5, total_tokens: 85 },
  ];
  const modelRequests = [];
  const clients = [];
  const summaries = [];
  let serverFailure;
  let harness;
  let restored;
  let expectedSessionBytes;
  let nativeCalls = 0;
  const coldStages = [];
  const server = createServer((req, res) => {
    void (async () => {
      assert.equal(req.headers.authorization, `Bearer ${ticket}`);
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [model] }));
        return;
      }
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, model.id);
      modelRequests.push({ model: body.model });
      const index = modelRequests.length - 1;
      assert.ok(index < usage.length, 'Statistics refresh must never create another model request');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const frame = value => res.write(`data: ${JSON.stringify({ id: `fixture-context-${index}`,
        object: 'chat.completion.chunk', created: 1, model: body.model, ...value })}\n\n`);
      frame({ choices: [{ index: 0, delta: { role: 'assistant', content: `CONTEXT_FIXTURE_${index}` }, finish_reason: null }] });
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: usage[index] });
      res.end('data: [DONE]\n\n');
    })().catch(error => {
      serverFailure ??= error;
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  t.after(async () => {
    await restored?.close();
    await harness?.close();
    await Promise.allSettled(clients.map(entry => entry.client.close()));
    if (server.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  writeFileSync(join(bridgeDir, 'locator.json'), JSON.stringify({ version: 1,
    port: server.address().port, pid: process.pid, ticket, expiresAt: Date.now() + 600_000 }), { mode: 0o600 });

  const clientFactory = options => {
    // Match the existing CLI opt-in contract while keeping the Harness's owned
    // provider selection and every other controlled flag intact.
    const launch = { ...options, args: options.args.map(value => /official-provider-extension\.(?:mjs|ts)$/.test(value) ? officialExtension : value) };
    const cold = launch.args.includes('--no-tools');
    const sessionPath = launch.args[launch.args.indexOf('--session') + 1];
    const entry = { options: launch, cold, sessionPath, commands: [], stats: [] };
    if (cold) {
      coldStages.push('factory');
      assert.notEqual(dirname(sessionPath), join(stateDir, 'sessions'));
      assert.match(dirname(sessionPath), /\/stats-[^/]+$/);
      assert.equal(lstatSync(dirname(sessionPath)).mode & 0o777, 0o700);
      assert.equal(lstatSync(sessionPath).mode & 0o777, 0o600);
      coldStages.push('private-copy');
      assert.deepEqual(readFileSync(sessionPath), expectedSessionBytes);
      coldStages.push('identical-copy');
      const requestContextFile = launch.env.WORKBUDDY_PI_REQUEST_CONTEXT_FILE;
      assert.equal(dirname(requestContextFile), dirname(sessionPath));
      const requestContextStat = lstatSync(requestContextFile);
      assert.ok(requestContextStat.isFile() && !requestContextStat.isSymbolicLink());
      assert.equal(requestContextStat.mode & 0o777, 0o600);
      const requestContext = JSON.parse(readFileSync(requestContextFile, 'utf8'));
      assert.deepEqual(Object.keys(requestContext).sort(), ['threadId', 'turnId']);
      assert.equal(requestContext.threadId, thread.id);
      assert.match(requestContext.turnId, /^pi-turn-[a-f0-9-]{36}$/);
      assert.ok(!saved.threads[0].turns.some(turn => turn.id === requestContext.turnId));
      coldStages.push('private-request-context');
    }
    const client = new PiRpcClient(launch);
    entry.client = client;
    const request = client.request.bind(client);
    client.request = async (type, fields, requestOptions) => {
      entry.commands.push(type);
      let response;
      try { response = await request(type, fields, requestOptions); }
      catch (error) { entry.failure = { name: error.name, code: error.code, command: type }; throw error; }
      if (type === 'get_session_stats') entry.stats.push(response);
      return response;
    };
    client.on('failure', error => { entry.failure = { name: error.name, code: error.code }; });
    clients.push(entry);
    return client;
  };
  const options = { command: process.env.PI_TEST_COMMAND, args, cwd: root, stateDir, agentDir,
    provider: 'workbuddy-official', model: model.id, modelName: model.name, officialOnly: true,
    officialBridgeDir: bridgeDir, clientFactory, requestTimeoutMs: 10_000, tools: ['read'],
    env: { HOME: root, PATH: process.env.PATH ?? '', TMPDIR: temporaryDir,
      XDG_CONFIG_HOME: join(root, 'xdg'), PI_OFFLINE: '1', PI_TELEMETRY: '0' } };
  harness = new PiHarness(options);
  harness.subscribe(event => { if (event.type === 'context.usage.updated') summaries.push(event.payload.summary); });
  const thread = await harness.createThread({ title: 'Synthetic context usage fixture' });
  const current = owner => owner.listThreads().find(value => value.id === thread.id);
  const waitFor = async predicate => {
    const deadline = Date.now() + 12_000;
    while (!predicate()) {
      if (serverFailure) throw serverFailure;
      if (Date.now() > deadline) throw Error('Real Pi context usage fixture timed out');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (serverFailure) throw serverFailure;
  };
  for (let index = 0; index < usage.length; index++) {
    await harness.startTurn({ threadId: thread.id, prompt: `Return synthetic marker ${index}.` });
    await waitFor(() => current(harness).turns.length === index + 1
      && current(harness).turns[index].status === 'completed'
      && current(harness).piContextUsage?.status === 'available'
      && current(harness).piContextUsage.tokens === usage[index].total_tokens);
  }
  assert.equal(modelRequests.length, 2);
  assert.ok(summaries.some(summary => summary.tokens === 85));
  const liveStats = clients.flatMap(entry => entry.stats).at(-1);
  assert.equal(liveStats.tokens.total, 1315);
  assert.equal(liveStats.contextUsage.tokens, 85);
  assert.notEqual(liveStats.tokens.total, current(harness).piContextUsage.tokens);
  assert.equal(current(harness).piContextUsage.breakdown, null);
  assert.ok(!Object.hasOwn(current(harness).piContextUsage, 'byCategory'));
  await harness.close();

  const sessionPath = join(stateDir, 'sessions', `${thread.id}.jsonl`);
  expectedSessionBytes = readFileSync(sessionPath);
  const statePath = join(stateDir, 'threads.json');
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  for (const value of saved.threads) delete value.piContextUsage;
  writeFileSync(statePath, JSON.stringify(saved), { mode: 0o600 });
  assert.ok(!Object.hasOwn(JSON.parse(readFileSync(statePath, 'utf8')).threads[0], 'piContextUsage'));
  const extensionDir = join(agentDir, 'extensions');
  mkdirSync(extensionDir, { mode: 0o700 });
  const poisonMarker = join(root, 'unexpected-auto-extension');
  writeFileSync(join(extensionDir, 'must-not-load.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(poisonMarker)}, 'unexpected'); export default () => {};`, { mode: 0o600 });
  const clientCount = clients.length;
  restored = new PiHarness({ ...options, nativeServices: {
    async listTools() { nativeCalls++; throw Error('Cold stats must not initialize native MCP'); },
    async callTool() { nativeCalls++; throw Error('Cold stats must not call native MCP'); },
  } });
  assert.equal(current(restored).piContextUsage, undefined);
  const summary = await restored.refreshContextUsage({ threadId: thread.id });
  assert.deepEqual(readFileSync(sessionPath), expectedSessionBytes, 'Cold refresh must preserve every original session byte');
  assert.equal(readdirSync(stateDir).some(name => name.startsWith('stats-')), false, 'Private statistics copies must be removed');
  assert.equal(summary.status, 'available', JSON.stringify({ summary, coldStages,
    cold: clients.filter(entry => entry.cold).map(entry => ({ commands: entry.commands, failure: entry.failure,
      contextUsage: entry.stats.at(-1)?.contextUsage, diagnostics: entry.client.diagnostics })) }));
  assert.equal(summary.tokens, 85);
  assert.equal(summary.contextWindow, 32768);
  assert.equal(summary.percent, 85 / 32768 * 100);
  assert.equal(summary.configuredMaxOutputTokens, 512);
  assert.equal(modelRequests.length, 2, 'Cold refresh must not send another model request');
  assert.equal(nativeCalls, 0);
  assert.equal(clients.length, clientCount + 1);
  const cold = clients.at(-1);
  assert.equal(cold.cold, true);
  assert.deepEqual(cold.commands, ['get_state', 'get_session_stats']);
  for (const flag of ['--no-tools', '--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--offline']) {
    assert.ok(cold.options.args.includes(flag), flag);
  }
  assert.equal(cold.options.args[cold.options.args.indexOf('--thinking') + 1], 'off');
  const explicitExtensions = cold.options.args.flatMap((arg, index) => arg === '--extension' ? [cold.options.args[index + 1]] : []);
  assert.deepEqual(explicitExtensions, [officialExtension]);
  assert.deepEqual(readFileSync(sessionPath), expectedSessionBytes, 'Cold refresh must preserve every original session byte');
  assert.equal(readdirSync(stateDir).some(name => name.startsWith('stats-')), false, 'Private statistics copies must be removed');
  assert.equal(readdirSync(root).includes('unexpected-auto-extension'), false);
  const persisted = JSON.parse(readFileSync(statePath, 'utf8')).threads.find(value => value.id === thread.id);
  assert.equal(persisted.piContextUsage.tokens, 85);
  await restored.close();
  assert.deepEqual(readFileSync(sessionPath), expectedSessionBytes);
});
