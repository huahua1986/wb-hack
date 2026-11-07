import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PiRpcClient } from '../src/pi-rpc.mjs';

// Explicit opt-in executes the installed/bundled Pi, against this fake loopback
// server only. It neither loads user Pi auth nor calls any external model.
test('actual Pi loader/provider/RPC/set_model/SSE/cancel work with a fake local bridge', {
  skip: !process.env.PI_TEST_COMMAND,
  timeout: 30_000,
}, async t => {
  const extension = process.env.PI_TEST_EXTENSION
    ?? fileURLToPath(new URL('../src/official-provider-extension.ts', import.meta.url));
  assert.ok(isAbsolute(extension), 'PI_TEST_EXTENSION must be absolute');
  const extensionStat = lstatSync(extension);
  assert.ok(extensionStat.isFile() && !extensionStat.isSymbolicLink(), 'PI_TEST_EXTENSION must be an existing regular file');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-pi-official-cli-')));
  const agentDir = join(root, 'agent'), bridgeDir = join(root, 'bridge');
  mkdirSync(agentDir, { mode: 0o700 }); mkdirSync(bridgeDir, { mode: 0o700 });
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: {} }), { mode: 0o600 });
  const ticket = 'fake-local-capability-no-official-credentials';
  const requestContext = { threadId: `pi-thread-${randomUUID()}`, turnId: `pi-turn-${randomUUID()}` };
  const contextFile = join(root, 'request-context.json');
  writeFileSync(contextFile, JSON.stringify(requestContext), { mode: 0o600 });
  const requests = [];
  let upstreamAborted = false;
  const models = ['hy4', 'hy4-fixture-second'].map(id => ({ id, name: id, api: 'openai-completions',
    contextWindow: 32768, maxTokens: 512, reasoning: false, input: ['text'], supportsToolCall: true }));
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${ticket}`) { res.writeHead(401); res.end(); return; }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: models })); return; }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ model: body.model, threadId: req.headers['x-workbuddy-pi-thread-id'], turnId: req.headers['x-workbuddy-pi-turn-id'] });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = value => res.write(`data: ${JSON.stringify({ id: 'fixture-response', object: 'chat.completion.chunk', created: 1, model: body.model, ...value })}\n\n`);
    frame({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    if (requests.length === 2) {
      res.on('close', () => { if (!res.writableEnded) upstreamAborted = true; });
      return;
    }
    frame({ choices: [{ index: 0, delta: { content: 'FAKE_PROVIDER_' }, finish_reason: null }] });
    frame({ choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] });
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(bridgeDir, 'locator.json'), JSON.stringify({ version: 1, port: server.address().port,
    pid: process.pid, ticket, expiresAt: Date.now() + 600_000 }), { mode: 0o600 });
  const args = JSON.parse(process.env.PI_TEST_ARGS ?? '[]');
  const client = new PiRpcClient({ command: process.env.PI_TEST_COMMAND,
    args: [...args, '--mode', 'rpc', '--provider', 'workbuddy-official', '--model', 'hy4', '--thinking', 'off',
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-mcp', '--no-context-files', '--offline',
      '--tools', 'read', '--extension', extension,
      '--session', join(root, 'session.jsonl')],
    cwd: root, env: { HOME: process.env.HOME, PATH: process.env.PATH, PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1', PI_TELEMETRY: '0', WORKBUDDY_PI_OFFICIAL_BRIDGE_DIR: bridgeDir,
      WORKBUDDY_PI_REQUEST_CONTEXT_FILE: contextFile }, timeoutMs: 10_000,
  });
  const records = [];
  client.on('event', record => records.push(record)); client.on('failure', () => {});
  t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const waitFor = async predicate => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) { if (Date.now() > deadline) throw Error('Fake Pi provider event timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const state = await client.getState();
  assert.equal(state.model.provider, 'workbuddy-official'); assert.equal(state.model.id, 'hy4');
  assert.ok(records.some(record => record.type === 'extension_ui_request' && record.message === 'workbuddy-official-provider-ready-v1'));
  assert.deepEqual((await client.getAvailableModels()).models.filter(model => model.provider === 'workbuddy-official').map(model => model.id).sort(), ['hy4', 'hy4-fixture-second']);
  assert.equal((await client.setModel('workbuddy-official', 'hy4-fixture-second')).id, 'hy4-fixture-second');
  assert.equal((await client.prompt('Return fake fixture text.')).disposition, 'started');
  await waitFor(() => records.some(record => record.type === 'agent_settled'));
  const message = records.find(record => record.type === 'message_end' && record.message?.role === 'assistant').message;
  assert.equal(message.stopReason, 'stop');
  assert.equal(message.content.filter(part => part.type === 'text').map(part => part.text).join(''), 'FAKE_PROVIDER_OK');
  assert.equal(message.usage.totalTokens, 12);
  assert.deepEqual(requests[0], { model: 'hy4-fixture-second', ...requestContext });
  const before = records.length;
  await client.prompt('Hold fake response for cancellation.');
  await waitFor(() => requests.length === 2);
  await client.abort();
  await waitFor(() => records.slice(before).some(record => record.type === 'agent_settled' && record.aborted));
  await waitFor(() => upstreamAborted);
  assert.equal(requests.length, 2);
});
