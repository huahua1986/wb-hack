import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtemp, mkdir, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createPiHttpServer } from '../src/pi-http-server.mjs';
import { docx, zip } from './helpers/document-fixtures.mjs';

const tokens = ['test_A'.repeat(8), 'test_B'.repeat(8)];
const digest = token => createHash('sha256').update(token).digest('hex');
const id = () => 'pi-thread-' + randomUUID();
const commandId = () => randomUUID();

async function harness(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-http-test-')));
  const agentDir = join(root, 'agent');
  await mkdir(agentDir, { mode: 0o700 });
  const launches = [];
  function launcher({ input, output, home, thread, onExit }) {
    const seen = [];
    const launch = { home, seen, emit: event => output.write(JSON.stringify(event) + '\n') };
    launches.push(launch);
    mkdirSync(join(home, '.workbuddy-pi-ssh', 'workspaces', thread), { recursive: true, mode: 0o700 });
    createInterface({ input }).on('line', line => {
      const record = JSON.parse(line);
      seen.push(record);
      launch.emit({ type: 'response', id: record.id, command: record.type, success: true });
      if (record.type === 'abort') launch.emit({ type: 'agent_settled', aborted: true });
    });
    input.once('end', () => onExit(0));
  }
  const { server, closeThreads } = await createPiHttpServer({
    dataDir: join(root, 'data'), agentDir, launcher,
    tokens: tokens.map((token, i) => ({ owner: 'owner' + i, sha256: digest(token) })),
    ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    closeThreads();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = (thread, action, { owner = 0, method, body, bytes, epoch, headers, signal } = {}) => fetch(
    base + '/v1/pi/threads/' + thread + '/' + action,
    {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      signal,
      headers: {
        ...(owner === null ? {} : { Authorization: 'Bearer ' + tokens[owner] }),
        ...(epoch ? { 'X-Pi-Epoch': epoch } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(bytes === undefined ? (body === undefined ? {} : { body: JSON.stringify(body) }) : { body: bytes }),
    },
  );
  const open = async (thread, owner = 0, body = {}) => {
    const res = await call(thread, 'open', { owner, body });
    assert.equal(res.status, 200);
    return res.json();
  };
  return { call, open, launches };
}

function events(res) {
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  let buffer = '';
  const decode = new TextDecoder();
  return {
    async next() {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith(':')) continue;
          const [, rawId, data] = /^id: (\d+)\ndata: (.+)$/.exec(block);
          return { id: Number(rawId), record: JSON.parse(data) };
        }
        const { done, value } = await reader.read();
        assert.equal(done, false, 'SSE ended before the expected event');
        buffer += decode.decode(value, { stream: true });
      }
    },
    async close() { await reader.cancel(); },
  };
}

test('SSE reconnect replays only missed frames and explicit stop is separate from network disconnect', async t => {
  const { call, open, launches } = await harness(t);
  const thread = id(), { epoch, cursor } = await open(thread);
  assert.equal(cursor, 0);
  let stream = events(await call(thread, 'events?after=0&epoch=' + epoch));
  t.after(() => stream.close());
  const prompt = { id: commandId(), type: 'prompt', message: 'synthetic' };
  const accepted = await call(thread, 'rpc', { epoch, body: prompt });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { accepted: true, duplicate: false });
  assert.equal((await stream.next()).record.id, prompt.id);
  launches[0].emit({ type: 'message_update', text: 'first' });
  const first = await stream.next();
  assert.equal(first.record.text, 'first');
  await stream.close();
  launches[0].emit({ type: 'message_update', text: 'second' });
  assert.deepEqual(launches[0].seen, [prompt], 'detaching SSE must not stop or replay prompt');
  const busy = await call(thread, 'open', { body: {} });
  assert.equal(busy.status, 409);
  stream = events(await call(thread, 'events?after=0&epoch=' + epoch, {
    headers: { 'Last-Event-ID': String(first.id) },
  }));
  assert.deepEqual(await stream.next(), { id: first.id + 1, record: { type: 'message_update', text: 'second' } });
  const abort = { id: commandId(), type: 'abort' };
  assert.equal((await call(thread, 'rpc', { epoch, body: abort })).status, 202);
  assert.equal((await stream.next()).record.id, abort.id);
  assert.deepEqual((await stream.next()).record, { type: 'agent_settled', aborted: true });
  const stopped = await call(thread, 'close', { epoch, method: 'POST' });
  assert.equal(stopped.status, 202);
  assert.deepEqual((await stream.next()).record, { type: 'workbuddy_transport_closed', code: 0 });
  const reopened = await open(thread);
  assert.notEqual(reopened.epoch, epoch);
  assert.equal(reopened.cursor, 0);
  assert.equal(launches[0].home, launches[1].home);
});

test('Office files stay within an authenticated idle thread and persist across worker epochs', async t => {
  const { call, open, launches } = await harness(t, {
    officeExtension: fileURLToPath(new URL('../remote-office/extension.ts', import.meta.url)),
  });
  const thread = id(), { epoch } = await open(thread, 0, { mode: 'fileOffice' });
  const bytes = zip(docx('Synthetic source'));
  const upload = await call(thread, 'files/demo.docx', {
    method: 'PUT', epoch, bytes,
    headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  });
  assert.equal(upload.status, 201);
  assert.equal((await upload.json()).file.sha256, digest(bytes));
  assert.equal((await call(thread, 'files/demo.docx', { owner: 1, epoch })).status, 404);
  assert.equal((await call(thread, 'files/%2e%2e%2fsecret.docx', { epoch })).status, 400);

  const stream = events(await call(thread, 'events?epoch=' + epoch));
  t.after(() => stream.close());
  await call(thread, 'rpc', { epoch, body: { id: commandId(), type: 'prompt', message: 'synthetic' } });
  assert.equal((await call(thread, 'files', { epoch })).status, 409);
  launches[0].emit({ type: 'agent_settled', aborted: false });
  const source = await call(thread, 'files/demo.docx', { epoch });
  assert.equal(source.status, 200);
  assert.deepEqual(Buffer.from(await source.arrayBuffer()), bytes);
  await call(thread, 'close', { epoch, method: 'POST' });
  assert.equal((await stream.next()).record.type, 'response');
  assert.equal((await stream.next()).record.type, 'agent_settled');
  assert.equal((await stream.next()).record.type, 'workbuddy_transport_closed');
  const reopened = await open(thread, 0, { mode: 'fileOffice' });
  assert.equal((await call(thread, 'files/demo.docx', { epoch })).status, 409);
  assert.equal((await call(thread, 'files/demo.docx', { epoch: reopened.epoch })).status, 200);
});

test('owner isolation, authentication, epoch fences, and idempotent command acceptance', async t => {
  const { call, open, launches } = await harness(t);
  const thread = id();
  assert.equal((await call(thread, 'open', { owner: null, body: {} })).status, 401);
  const { epoch } = await open(thread);
  assert.equal((await call(thread, 'events?epoch=' + epoch, { owner: 1 })).status, 404);
  const other = await open(thread, 1);
  assert.notEqual(other.epoch, epoch);
  assert.notEqual(launches[0].home, launches[1].home);
  assert.equal((await stat(launches[0].home)).mode & 0o777, 0o700);
  assert.equal((await call(thread, 'rpc', { owner: 1, epoch, body: { id: commandId(), type: 'get_state' } })).status, 409);

  const request = { id: commandId(), type: 'prompt', message: 'one' };
  assert.equal((await call(thread, 'rpc', { epoch, body: request })).status, 202);
  const duplicate = await call(thread, 'rpc', { epoch, body: request });
  assert.deepEqual(await duplicate.json(), { accepted: true, duplicate: true });
  assert.equal((await call(thread, 'rpc', { epoch, body: { ...request, message: 'changed' } })).status, 409);
  assert.equal((await call(thread, 'rpc', { epoch, body: { id: commandId(), type: 'prompt', message: 'another' } })).status, 409);
  assert.equal((await call(thread, 'rpc', { epoch, body: { id: commandId(), type: 'set_model' } })).status, 400);
  assert.equal(launches[0].seen.length, 1);
  assert.equal(launches[1].seen.length, 0);
});

test('a replay gap fails explicitly and thread mode remains fixed across restart', async t => {
  const { call, open, launches } = await harness(t, { eventLimit: 2, allowOffice: true });
  const thread = id(), { epoch } = await open(thread);
  for (let i = 0; i < 3; i++) launches[0].emit({ type: 'message_update', count: i });
  const gap = await call(thread, 'events?after=0&epoch=' + epoch);
  assert.equal(gap.status, 409);
  assert.equal((await gap.json()).error.code, 'PI_EVENT_GAP');
  const stream = events(await call(thread, 'events?after=1&epoch=' + epoch));
  t.after(() => stream.close());
  assert.equal((await stream.next()).id, 2);
  assert.equal((await stream.next()).id, 3);
  await call(thread, 'close', { epoch, method: 'POST' });
  assert.equal((await stream.next()).record.type, 'workbuddy_transport_closed');
  const differentMode = await call(thread, 'open', { body: { mode: 'office' } });
  assert.equal(differentMode.status, 409);
  assert.equal((await differentMode.json()).error.code, 'THREAD_MODE_MISMATCH');
  await open(thread);
  assert.equal(launches.length, 2);
});
