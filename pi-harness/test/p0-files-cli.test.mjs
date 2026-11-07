import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PiRpcClient } from '../src/pi-rpc.mjs';
import { createNativeDiffReplay, findNativeDiffView } from './fixtures/native-diff-592.replay.mjs';

const { PiHarness } = process.env.PI_TEST_HARNESS_MODULE
  ? await import(pathToFileURL(process.env.PI_TEST_HARNESS_MODULE).href) : await import('../src/pi-harness.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p.text ?? '').join('') : '';

// Opt-in actual Pi 1.4 execution. Every prompt, file, model response and token is synthetic.
// The loopback provider never calls an official account or an external business system.
test('real Pi write/diff/checkpoint rewind restores file and JSONL prefix across Host restart without replay', {
  skip: !process.env.PI_TEST_COMMAND,
  timeout: 60_000,
}, async t => {
  const args = JSON.parse(process.env.PI_TEST_ARGS ?? '[]');
  assert.ok(Array.isArray(args) && args.every(value => typeof value === 'string'));
  const entry = args.find(value => path.isAbsolute(value) && value.endsWith('/dist/bundle/cli.js'));
  if (entry) {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(entry), '../..', 'package.json')));
    assert.equal(pkg.name, '@earendil-works/pi-coding-agent'); assert.equal(pkg.version, process.env.PI_TEST_EXPECTED_VERSION ?? '1.4.0');
  }
  const extension = process.env.PI_TEST_EXTENSION ?? fileURLToPath(new URL('../src/official-provider-extension.ts', import.meta.url));
  const approval = process.env.PI_TEST_APPROVAL_EXTENSION ?? fileURLToPath(new URL('../package-dmg/approval-extension.mjs', import.meta.url));
  for (const filename of [extension, approval]) {
    assert.equal(path.isAbsolute(filename), true); assert.equal(fs.lstatSync(filename).isFile(), true); assert.equal(fs.lstatSync(filename).isSymbolicLink(), false);
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pi-p0-files-')));
  const cwd = path.join(root, 'work'), stateDir = path.join(root, 'state'), agentDir = path.join(root, 'agent');
  const bridgeDir = path.join(root, 'bridge'), temporaryDir = path.join(root, 'tmp');
  for (const filename of [cwd, stateDir, agentDir, bridgeDir, temporaryDir]) fs.mkdirSync(filename, { mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: {} }), { mode: 0o600 });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false } }), { mode: 0o600 });
  const model = { id: 'hy4-p0-files-fixture', name: 'P0 file fixture only', api: 'openai-completions',
    reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 512, supportsToolCall: true };
  const ticket = 'synthetic-loopback-p0-files-no-official-credentials';
  const first = 'P0_REAL_FILE_FIRST_PAYLOAD\n', second = 'P0_REAL_FILE_SECOND_PAYLOAD\n';
  const target = path.join(cwd, 'journal-fixture.txt');
  const requestCounts = { first: 0, second: 0, restored: 0 }, requests = [], records = [], launches = [];
  let phase = 'first', threadId, failure, harness, restored, closing = false;
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, 'Bearer ' + ticket);
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [model] })); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers['x-workbuddy-pi-thread-id'], threadId);
      const parts = []; for await (const chunk of request) parts.push(chunk);
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      assert.equal(body.model, model.id); const currentPhase = phase, count = ++requestCounts[currentPhase];
      requests.push({ phase: currentPhase, turnId: request.headers['x-workbuddy-pi-turn-id'], body });
      assert.ok(count <= (currentPhase === 'restored' ? 1 : 2), 'No hidden model round, compaction or repeated tool execution is expected');
      assert.deepEqual(body.tools.map(tool => tool.function.name), ['write']);
      if (currentPhase === 'restored') {
        const history = JSON.stringify(body.messages);
        assert.ok(history.includes(first.trim()), 'The restored Pi branch must retain the first actual tool-call payload');
        assert.ok(!history.includes(second.trim()), 'The removed tool-call payload must not reappear after restarting Pi');
        assert.ok(!history.includes('P0_SECOND_COMPLETED'), 'The removed assistant answer must not reappear');
        assert.equal(fs.readFileSync(target, 'utf8'), first);
      } else if (count === 2) {
        const callId = 'synthetic-write-' + currentPhase;
        assert.ok(body.messages.some(message => message.role === 'tool' && message.tool_call_id === callId));
        assert.equal(fs.readFileSync(target, 'utf8'), currentPhase === 'first' ? first : second);
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const frame = (delta, finishReason = null, usage) => response.write(`data: ${JSON.stringify({ id: `synthetic-p0-${currentPhase}-${count}`,
        object: 'chat.completion.chunk', created: 1, model: model.id, choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) })}\n\n`);
      frame({ role: 'assistant' });
      if (currentPhase !== 'restored' && count === 1) {
        frame({ tool_calls: [{ index: 0, id: 'synthetic-write-' + currentPhase, type: 'function', function: {
          name: 'write', arguments: JSON.stringify({ path: 'journal-fixture.txt', content: currentPhase === 'first' ? first : second }),
        } }] });
        frame({}, 'tool_calls', { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 });
      } else {
        frame({ content: currentPhase === 'restored' ? 'P0_RESTORED_PREFIX_OK' : currentPhase === 'first' ? 'P0_FIRST_COMPLETED' : 'P0_SECOND_COMPLETED' });
        frame({}, 'stop', { prompt_tokens: 150, completion_tokens: 10, total_tokens: 160 });
      }
      response.end('data: [DONE]\n\n');
    })().catch(error => { failure ??= error; if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  const clients = [];
  t.after(async () => {
    closing = true; await restored?.close(); await harness?.close();
    await Promise.allSettled(clients.map(client => client.close()));
    if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  fs.writeFileSync(path.join(bridgeDir, 'locator.json'), JSON.stringify({ version: 1, pid: process.pid, port: server.address().port,
    ticket, expiresAt: Date.now() + 600_000 }), { mode: 0o600 });
  const replacements = new Map([
    ['official-provider-extension.ts', extension],
    ...(process.env.PI_TEST_NATIVE_EXTENSION ? [['native-feature-extension.mjs', process.env.PI_TEST_NATIVE_EXTENSION]] : []),
    ...(process.env.PI_TEST_SETTINGS_EXTENSION ? [['turn-settings-extension.mjs', process.env.PI_TEST_SETTINGS_EXTENSION]] : []),
  ]);
  const options = { command: process.env.PI_TEST_COMMAND, args, cwd, stateDir, agentDir, provider: 'workbuddy-official', model: model.id,
    modelName: model.name, officialOnly: true, officialBridgeDir: bridgeDir, approvalMode: 'auto', tools: ['write'], approvalExtension: approval,
    requestTimeoutMs: 12_000, approvalTimeoutMs: 5_000,
    env: { HOME: root, PATH: process.env.PATH ?? '', TMPDIR: temporaryDir, XDG_CONFIG_HOME: path.join(root, 'xdg'), PI_OFFLINE: '1', PI_TELEMETRY: '0' },
    clientFactory(launch) {
      const selected = { ...launch, args: launch.args.map(value => replacements.get(path.basename(value)) ?? value) };
      const client = new PiRpcClient(selected); clients.push(client); launches.push(selected);
      client.on('event', record => records.push(record));
      client.on('failure', error => { if (!closing && error.code !== 'PI_RPC_CLOSED') failure ??= error; });
      return client;
    } };
  const current = owner => owner.listThreads().find(thread => thread.id === threadId);
  const settled = async (owner, turnId) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (failure) throw failure;
      const turn = current(owner)?.turns.find(turn => turn.id === turnId);
      if (turn && !['running', 'waiting_for_approval'].includes(turn.status)) {
        assert.equal(turn.status, 'completed', `Synthetic turn must complete: ${turn.error?.code ?? 'unknown'}`); return turn;
      }
      if (Date.now() > deadline) throw new Error('Actual Pi file checkpoint fixture timed out');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  harness = new PiHarness(options); const thread = await harness.createThread({ title: 'Synthetic P0 file checkpoints', cwd }); threadId = thread.id;
  const one = await harness.startTurn({ threadId, prompt: 'Create the synthetic round-one file using the write tool, then finish.' });
  await settled(harness, one.id); assert.equal(fs.readFileSync(target, 'utf8'), first);
  const session = path.join(stateDir, 'sessions', threadId + '.jsonl'), firstPrefix = fs.readFileSync(session);
  assert.ok(firstPrefix.toString('utf8').includes(first.trim())); assert.ok(!firstPrefix.toString('utf8').includes(second.trim()));
  phase = 'second';
  const two = await harness.startTurn({ threadId, prompt: 'Replace the same synthetic file with the round-two content using write, then finish.' });
  await settled(harness, two.id); assert.equal(fs.readFileSync(target, 'utf8'), second);
  const resources = await harness.fileResources({ threadId });
  assert.equal(resources.artifacts.length, 1); assert.equal(resources.artifacts[0].filePath, target); assert.equal(resources.artifacts[0].requestId, two.id);
  assert.deepEqual(resources.manifests.map(m => m.files[0].action), ['create', 'modify']);
  const nativeDiff = createNativeDiffReplay(), summaries = nativeDiff.project(resources.manifests, threadId);
  assert.equal(summaries.length, 1); assert.equal(summaries[0].changeRequestId, two.id); assert.equal(summaries[0].fileChangeInfo.changeType, 'modified');
  let currentFileReads = 0;
  const summaryTree = await nativeDiff.view(summaries[0], { readFile: async filename => { currentFileReads++; assert.equal(filename, target); return fs.readFileSync(filename, 'utf8'); } });
  const summaryEditor = findNativeDiffView(summaryTree); assert.ok(summaryEditor);
  assert.equal(summaryEditor.props.original, first, 'The native summary must reconstruct the original FIRST side, not inherit an all-green creation');
  assert.equal(summaryEditor.props.modified, second); assert.equal(currentFileReads, 0);
  const detail = (await harness.fileResources({ threadId, detailRef: two.id })).detail;
  assert.equal(detail.requestId, two.id); assert.equal(detail.files.length, 1); assert.equal(detail.files[0].detailStatus, 'available');
  assert.ok(detail.files[0].hunks.some(h => h.lines.includes('-' + first.trim()) && h.lines.includes('+' + second.trim())));
  const preview = await harness.checkpointRead({ threadId, turnId: two.id });
  assert.equal(preview.available, true); assert.deepEqual(preview.diff.changes, [{ path: target, operation: 'write' }]);
  assert.equal(preview.restoreInfo[0].versionRequestId, one.id);
  const originalSession = fs.readFileSync(session);
  const internal = JSON.parse(fs.readFileSync(path.join(stateDir, 'threads.json'), 'utf8'));
  const internalThread = internal.threads.find(t => t.id === threadId), checkpoint = internalThread.turns.find(t => t.id === two.id).sessionCheckpoint;
  const expectedPrefix = originalSession.subarray(0, checkpoint.bytes);
  assert.equal(sha(expectedPrefix), checkpoint.sha256); assert.ok(expectedPrefix.length >= firstPrefix.length);
  assert.deepEqual(expectedPrefix.subarray(0, firstPrefix.length), firstPrefix);
  const rewind = await harness.rewindThread({ threadId, turnId: two.id });
  assert.equal(rewind.ok, true); assert.equal(rewind.branchChanged, true); assert.deepEqual(rewind.removedRequestIds, [two.id]);
  assert.equal(fs.readFileSync(target, 'utf8'), first); assert.deepEqual(current(harness).turns.map(t => t.id), [one.id]);
  assert.deepEqual(fs.readFileSync(session), expectedPrefix, 'The live session must be the exact original validated prefix');
  const backupRoot = path.join(stateDir, 'rewind-backups'), operations = fs.readdirSync(backupRoot);
  assert.equal(operations.length, 1); const backupDir = path.join(backupRoot, operations[0]);
  const originalBackup = path.join(backupDir, 'session-before-rewind.jsonl');
  assert.deepEqual(fs.readFileSync(originalBackup), originalSession, 'The entire unmodified Pi JSONL must remain backed up');
  assert.equal(JSON.parse(fs.readFileSync(path.join(backupDir, 'transaction.json'))).status, 'complete');
  assert.equal(JSON.parse(fs.readFileSync(path.join(backupDir, 'thread-before-rewind.json'))).turns.length, 2);
  const afterRewind = await harness.fileResources({ threadId }); assert.equal(afterRewind.manifests.length, 1); assert.equal(afterRewind.artifacts[0].requestId, one.id);
  const revertedDiffs = nativeDiff.project(afterRewind.manifests, threadId); assert.equal(revertedDiffs.length, 1);
  const revertedEditor = findNativeDiffView(await nativeDiff.view(revertedDiffs[0], { currentText: first }));
  assert.equal(revertedEditor.props.original, ''); assert.equal(revertedEditor.props.modified, first);
  await assert.rejects(harness.fileResources({ threadId, detailRef: two.id }), error => error.code === 'NOT_FOUND');
  await harness.close(); harness = null;
  const clientsBeforeRestart = clients.length; restored = new PiHarness(options);
  assert.equal(clients.length, clientsBeforeRestart, 'Reading restored Host state must not launch or replay Pi');
  assert.deepEqual(current(restored).turns.map(t => t.id), [one.id]); assert.equal(current(restored).cwd, cwd);
  phase = 'restored';
  const continued = await restored.startTurn({ threadId, prompt: 'Without invoking any tools, use the restored conversation context and acknowledge the retained branch.' });
  const final = await settled(restored, continued.id);
  assert.ok(final.items.some(item => item.type === 'text' && item.text === 'P0_RESTORED_PREFIX_OK'));
  assert.equal(fs.readFileSync(target, 'utf8'), first); assert.deepEqual(fs.readFileSync(originalBackup), originalSession);
  assert.equal(records.filter(r => r.type === 'tool_execution_end' && r.toolName === 'write').length, 2, 'Exactly two real writes, with no tool replay');
  assert.equal(records.filter(r => r.type === 'tool_execution_end' && r.isError).length, 0);
  assert.deepEqual(requestCounts, { first: 2, second: 2, restored: 1 }); assert.equal(requests.length, 5);
  assert.ok(launches.every(launch => launch.cwd === cwd));
  assert.ok(!fs.readFileSync(session, 'utf8').includes(second.trim()));
  assert.equal(text(requests.at(-1).body.messages.at(-1).content).includes('retained branch'), true);
  if (failure) throw failure;
});
