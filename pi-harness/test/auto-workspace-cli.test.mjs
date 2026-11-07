import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const { PiHarness } = process.env.PI_TEST_HARNESS_MODULE
  ? await import(pathToFileURL(process.env.PI_TEST_HARNESS_MODULE).href) : await import('../src/pi-harness.mjs');
import { PiRpcClient } from '../src/pi-rpc.mjs';
import { nativeToolName } from '../src/native-tools.mjs';
import { APPROVAL_PROTOCOL, APPROVAL_TITLE } from '../package-dmg/approval-extension.mjs';
import { NATIVE_TITLE } from '../src/native-feature-extension.mjs';

const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';

// Explicit opt-in runs Pi against a fake loopback model and a synthetic native
// service, with private HOME, agent, task directories and controlled file writes.
test('actual Pi auto-approves isolated task write/bash and consumes one MCP grant, then restores saved workspaces', {
  skip: !process.env.PI_TEST_COMMAND,
  timeout: 45_000,
}, async t => {
  const officialExtension = process.env.PI_TEST_EXTENSION
    ?? fileURLToPath(new URL('../src/official-provider-extension.ts', import.meta.url));
  assert.ok(isAbsolute(officialExtension));
  assert.ok(lstatSync(officialExtension).isFile() && !lstatSync(officialExtension).isSymbolicLink());
  const args = JSON.parse(process.env.PI_TEST_ARGS ?? '[]');
  assert.ok(Array.isArray(args) && args.every(value => typeof value === 'string'));
  const cli = args.find(value => isAbsolute(value) && value.endsWith('/dist/bundle/cli.js'));
  if (cli) assert.equal(JSON.parse(readFileSync(resolve(dirname(cli), '../..', 'package.json'))).version, process.env.PI_TEST_EXPECTED_VERSION ?? '1.4.0');

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-pi-auto-workspace-')));
  const agentDir = join(root, 'agent'), stateDir = join(root, 'state');
  const bridgeDir = join(root, 'bridge'), sharedCwd = join(root, 'shared-fallback');
  const workspaceRoot = join(root, 'WorkBuddy'), temporaryDir = join(root, 'tmp');
  for (const path of [agentDir, stateDir, bridgeDir, sharedCwd, temporaryDir]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: {} }), { mode: 0o600 });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false } }), { mode: 0o600 });
  const model = { id: 'hy4', name: 'Auto workspace fixture', api: 'openai-completions',
    contextWindow: 32768, maxTokens: 512, reasoning: false, input: ['text'], supportsToolCall: true };
  const ticket = 'fake-auto-workspace-capability-no-official-account';
  const serverId = 'connector:fixture-private', connectorId = 'fixture-private';
  const rawName = 'qa_lookup', mappedName = nativeToolName(serverId, rawName);
  const markerA = 'AUTO_TASK_A_MARKER', markerB = 'AUTO_TASK_B_MARKER';
  const nativeMarker = 'AUTO_PRIVATE_NATIVE_RESULT';
  const nativeArguments = { query: 'synthetic finance query' };
  const callIds = { write: 'fixture_write_task_a', native: 'fixture_native_task_a', bash: 'fixture_bash_task_b' };
  const requests = [], clients = [], events = [], nativeCalls = [];
  const flows = new Map();
  let failure, harness, restored, closing = false;
  let releaseNative;
  const nativeGate = new Promise(resolvePromise => { releaseNative = resolvePromise; });
  let notifyNative;
  const nativeEntered = new Promise(resolvePromise => { notifyNative = resolvePromise; });
  const nativeServices = {
    async listTools() {
      return [{ serverId, connectorId, rawName, description: 'Read a synthetic result from the test only.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }];
    },
    async callTool(value) {
      nativeCalls.push(value);
      notifyNative();
      await nativeGate;
      return { content: [{ type: 'text', text: nativeMarker }], isError: false };
    },
  };
  const server = createServer((req, res) => {
    void (async () => {
      assert.equal(req.headers.authorization, `Bearer ${ticket}`);
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [model] })); return;
      }
      assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.method, 'POST');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const threadId = req.headers['x-workbuddy-pi-thread-id'];
      const flow = flows.get(threadId);
      assert.ok(flow, 'Every request must retain the owned thread association');
      assert.equal(body.model, model.id);
      flow.requests++;
      assert.ok(flow.requests <= 2, 'Each fixture task has one tool batch and one continuation');
      requests.push({ threadId, turnId: req.headers['x-workbuddy-pi-turn-id'], stage: flow.requests });
      const declared = body.tools?.map(tool => tool.function.name) ?? [];
      for (const name of ['read', 'write', 'bash']) assert.ok(declared.includes(name));
      assert.equal(declared.includes(mappedName), flow.kind === 'write-native');
      if (flow.requests === 2) {
        const toolResults = body.messages.filter(message => message.role === 'tool');
        if (flow.kind === 'write-native') {
          assert.ok(toolResults.some(message => message.tool_call_id === callIds.write));
          assert.ok(toolResults.some(message => message.tool_call_id === callIds.native && text(message.content).includes(nativeMarker)));
          assert.equal(readFileSync(join(flow.cwd, 'marker.txt'), 'utf8'), markerA);
        } else {
          assert.ok(toolResults.some(message => message.tool_call_id === callIds.bash));
          assert.equal(readFileSync(join(flow.cwd, 'marker.txt'), 'utf8'), markerB + '\n');
        }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const frame = value => res.write(`data: ${JSON.stringify({ id: `fixture-${flow.kind}-${flow.requests}`,
        object: 'chat.completion.chunk', created: 1, model: model.id, ...value })}\n\n`);
      frame({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      if (flow.requests === 1) {
        const calls = flow.kind === 'write-native' ? [
          { id: callIds.write, name: 'write', arguments: { path: 'marker.txt', content: markerA } },
          { id: callIds.native, name: mappedName, arguments: nativeArguments },
        ] : [{ id: callIds.bash, name: 'bash', arguments: { command: `printf '%s\\n' '${markerB}' > marker.txt` } }];
        frame({ choices: [{ index: 0, delta: { tool_calls: calls.map((call, index) => ({ index, id: call.id,
          type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }, finish_reason: null }] });
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
      } else {
        frame({ choices: [{ index: 0, delta: { content: `AUTO_${flow.kind}_COMPLETE` }, finish_reason: null }] });
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33 } });
      }
      res.end('data: [DONE]\n\n');
    })().catch(error => { failure ??= error; if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  t.after(async () => {
    closing = true; releaseNative();
    await restored?.close(); await harness?.close();
    await Promise.allSettled(clients.map(entry => entry.client.close()));
    if (server.listening) { server.closeAllConnections(); await new Promise(resolvePromise => server.close(resolvePromise)); }
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise); });
  writeFileSync(join(bridgeDir, 'locator.json'), JSON.stringify({ version: 1, port: server.address().port,
    pid: process.pid, ticket, expiresAt: Date.now() + 600_000 }), { mode: 0o600 });

  const clientFactory = options => {
    const launch = { ...options, args: options.args.map(value => /official-provider-extension\.(?:mjs|ts)$/.test(value) ? officialExtension : value) };
    const client = new PiRpcClient(launch);
    const entry = { client, launch, confirms: [], inputs: [], responses: [] };
    const respond = client.sendExtensionUiResponse.bind(client);
    client.sendExtensionUiResponse = async response => { entry.responses.push(structuredClone(response)); return respond(response); };
    client.on('event', record => {
      if (record.type !== 'extension_ui_request') return;
      if (record.method === 'confirm') {
        assert.equal(record.title, APPROVAL_TITLE);
        assert.equal(JSON.parse(record.message).protocol, APPROVAL_PROTOCOL);
        entry.confirms.push(record);
      } else if (record.method === 'input' && record.title === NATIVE_TITLE) entry.inputs.push(record);
    });
    client.on('failure', error => { if (!closing && !['PI_RPC_CLOSED'].includes(error.code)) failure ??= error; });
    clients.push(entry); return client;
  };
  const options = { command: process.env.PI_TEST_COMMAND, args, cwd: sharedCwd, workspaceRoot,
    stateDir, agentDir, provider: 'workbuddy-official', model: model.id, modelName: model.name,
    officialOnly: true, officialBridgeDir: bridgeDir, approvalMode: 'auto', tools: ['read', 'write', 'bash'],
    nativeServices, clientFactory, requestTimeoutMs: 10_000, approvalTimeoutMs: 5_000,
    env: { HOME: root, PATH: process.env.PATH ?? '', SHELL: '/bin/bash', TMPDIR: temporaryDir,
      XDG_CONFIG_HOME: join(root, 'xdg'), PI_OFFLINE: '1', PI_TELEMETRY: '0' } };
  harness = new PiHarness(options);
  harness.subscribe(event => events.push(event));
  const first = await harness.createThread({ title: 'Auto write and private native fixture' });
  const second = await harness.createThread({ title: 'Auto bash fixture', cwd: '' });
  for (const thread of [first, second]) {
    assert.equal(thread.approvalMode, 'auto');
    assert.equal(thread.workspaceAutoGenerated, true);
    assert.equal(dirname(thread.cwd), workspaceRoot);
    assert.match(basename(thread.cwd), /^\d{4}(?:-\d{2}){5}$/);
    assert.ok(lstatSync(thread.cwd).isDirectory());
  }
  assert.notEqual(first.cwd, second.cwd);
  flows.set(first.id, { kind: 'write-native', cwd: first.cwd, requests: 0 });
  flows.set(second.id, { kind: 'bash', cwd: second.cwd, requests: 0 });
  await harness.setNativeContext({ threadId: first.id, connectors: [connectorId] });
  const current = (owner, id) => owner.listThreads().find(value => value.id === id);
  const waitFor = async predicate => {
    const deadline = Date.now() + 12_000;
    while (!predicate()) {
      if (failure) throw failure;
      const failed = harness.listThreads().flatMap(thread => thread.turns).find(turn => turn.status === 'failed');
      if (failed) throw Error(`Auto fixture failed: ${failed.error?.code ?? 'unknown'}`);
      if (Date.now() > deadline) throw Error('Actual Pi auto workspace fixture timed out');
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    }
    if (failure) throw failure;
  };
  const firstTurn = await harness.startTurn({ threadId: first.id, prompt: 'Execute the synthetic write and selected native lookup, then finish.' });
  await Promise.race([nativeEntered, waitFor(() => nativeCalls.length > 0)]);
  assert.equal(nativeCalls.length, 1);
  assert.equal(nativeCalls[0].threadId, first.id);
  assert.equal(nativeCalls[0].turnId, firstTurn.id);
  assert.equal(nativeCalls[0].cwd, first.cwd);
  assert.equal(nativeCalls[0].serverId, serverId);
  assert.equal(nativeCalls[0].rawName, rawName);
  assert.deepEqual(nativeCalls[0].connectors, [connectorId]);
  assert.deepEqual(nativeCalls[0].arguments, nativeArguments);

  // Replay the exact already-consumed metadata while the first native result is
  // pending. This synthetic extra input has no Pi dialog and must not call again.
  const firstClient = clients.find(entry => entry.launch.cwd === first.cwd);
  const nativeInput = firstClient.inputs.find(record => JSON.parse(record.placeholder).toolCallId === callIds.native);
  assert.ok(nativeInput);
  const replayId = 'fixture-replayed-native-dialog';
  firstClient.client.emit('event', { ...nativeInput, id: replayId });
  await waitFor(() => firstClient.responses.some(response => response.id === replayId));
  assert.equal(JSON.parse(firstClient.responses.find(response => response.id === replayId).value).ok, false);
  assert.equal(nativeCalls.length, 1);
  releaseNative();
  await waitFor(() => current(harness, first.id).turns[0]?.status === 'completed');
  await harness.startTurn({ threadId: second.id, prompt: 'Execute the synthetic bash command and finish.' });
  await waitFor(() => current(harness, second.id).turns[0]?.status === 'completed');
  assert.equal(requests.length, 4);
  assert.equal(readFileSync(join(first.cwd, 'marker.txt'), 'utf8'), markerA);
  assert.equal(readFileSync(join(second.cwd, 'marker.txt'), 'utf8'), markerB + '\n');
  assert.equal(existsSync(join(sharedCwd, 'marker.txt')), false);
  assert.equal(events.filter(event => event.type === 'interaction.requested').length, 0);
  const interactions = [first, second].flatMap(thread => current(harness, thread.id).turns[0].interactions);
  assert.equal(interactions.length, 3);
  for (const interaction of interactions) {
    assert.equal(interaction.status, 'approved');
    assert.equal(interaction.authorizationSource, 'automatic');
    assert.deepEqual(interaction.response, { decision: 'allow-once' });
  }
  assert.deepEqual(interactions.map(value => value.toolName).sort(), ['write', 'bash', mappedName].sort());
  const confirmations = clients.flatMap(entry => entry.confirms);
  assert.equal(confirmations.length, 3);
  assert.equal(clients.flatMap(entry => entry.responses).filter(value => value.confirmed === true).length, 3);
  assert.equal(clients.flatMap(entry => entry.responses).filter(value => value.confirmed === false).length, 0);
  assert.deepEqual(clients.map(entry => entry.launch.cwd).sort(), [first.cwd, second.cwd].sort());

  const directories = readdirSync(workspaceRoot).sort();
  const clientsBeforeRestore = clients.length;
  const persistedCwds = new Map(harness.listThreads().map(thread => [thread.id, thread.cwd]));
  await harness.close();
  restored = new PiHarness(options);
  for (const thread of restored.listThreads()) {
    assert.equal(thread.cwd, persistedCwds.get(thread.id));
    assert.equal(thread.workspaceAutoGenerated, true);
    assert.equal(thread.approvalMode, 'auto');
    assert.equal(thread.turns[0].status, 'completed');
    assert.ok(thread.turns[0].interactions.every(value => value.authorizationSource === 'automatic'));
  }
  assert.deepEqual(readdirSync(workspaceRoot).sort(), directories);
  assert.equal(clients.length, clientsBeforeRestore, 'Restoring saved cwd must not launch another Pi process');
  assert.equal(requests.length, 4);
  assert.equal(nativeCalls.length, 1);
});
