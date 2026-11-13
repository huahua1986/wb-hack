import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:https';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiHttpClient, normalizeHttpPi } from '../src/pi-http-client.mjs';
import { createPiHttpServer } from '../src/pi-http-server.mjs';
import { docx, zip } from './helpers/document-fixtures.mjs';

async function fixture(t, { office = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-https-client-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cert = join(root, 'cert.pem'), key = join(root, 'key.pem'), tokenFile = join(root, 'token');
  const config = join(root, 'openssl.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-config', config, '-keyout', key, '-out', cert], { encoding: 'utf8' });
  if (generated.error?.code === 'ENOENT') { t.skip('openssl is unavailable'); return null; }
  assert.equal(generated.status, 0, generated.stderr);
  const token = randomUUID().replaceAll('-', '');
  await writeFile(tokenFile, token + '\n', { mode: 0o600 });
  const agentDir = join(root, 'agent');
  await mkdir(agentDir, { mode: 0o700 });
  const launches = [], subscribers = [];
  const digest = createHash('sha256').update(token).digest('hex');
  const { server, closeThreads } = await createPiHttpServer({
    dataDir: join(root, 'data'), agentDir, tokens: [{ owner: 'test', sha256: digest }],
    ...(office ? { officeExtension: new URL(import.meta.url).pathname } : {}),
    launcher({ input, output, onExit, home, thread }) {
      mkdirSync(join(home, '.workbuddy-pi-ssh', 'workspaces', thread), { recursive: true, mode: 0o700 });
      const emit = value => output.write(JSON.stringify(value) + '\n');
      const seen = [];
      launches.push({ emit, seen });
      createInterface({ input }).on('line', line => {
        const record = JSON.parse(line);
        seen.push(record.type);
        emit({ type: 'response', id: record.id, command: record.type, success: true,
          data: record.type === 'get_state' ? { model: { provider: 'tokenlink', id: 'hy4' } } : {} });
        if (record.type === 'prompt') emit({ type: 'message_update', delta: '开始' });
        if (record.type === 'abort') emit({ type: 'agent_settled', aborted: true });
      });
      input.once('end', () => onExit(0));
    },
  });
  const tls = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    if (req.url.includes('/events?')) subscribers.push({ socket: res.socket, cursor: req.headers['last-event-id'] });
    server.emit('request', req, res);
  });
  t.after(async () => {
    closeThreads();
    tls.closeAllConnections();
    await new Promise(resolve => tls.close(resolve));
  });
  tls.listen(0, '127.0.0.1');
  await once(tls, 'listening');
  const url = 'https://127.0.0.1:' + tls.address().port;
  const settings = normalizeHttpPi({ url, tokenFile, caFile: cert, mode: office ? 'fileOffice' : 'text' });
  return { launches, subscribers, settings, url, tokenFile };
}

test('Pi HTTPS streams, resumes after an SSE disconnect, and explicitly cancels a turn', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  if (!f) return;
  const { launches, subscribers, settings, url, tokenFile } = f;
  const threadId = 'pi-thread-' + randomUUID();
  const untrusted = new PiHttpClient({ url, tokenFile, threadId, timeoutMs: 1000 });
  await assert.rejects(untrusted.start(), { code: 'PI_HTTP_TLS' });
  await untrusted.close();

  const client = new PiHttpClient({ ...settings, threadId, timeoutMs: 3000 });
  t.after(() => client.close().catch(() => {}));
  assert.deepEqual(await client.getState(), { model: { provider: 'tokenlink', id: 'hy4' } });
  const first = once(client, 'event');
  await client.prompt('synthetic');
  assert.deepEqual(await first, [{ type: 'message_update', delta: '开始' }]);
  assert.equal(subscribers.length, 1);
  const second = once(client, 'event');
  subscribers[0].socket.destroy();
  launches[0].emit({ type: 'message_update', delta: '恢复' });
  assert.deepEqual(await second, [{ type: 'message_update', delta: '恢复' }]);
  assert.equal(subscribers.length, 2);
  assert.equal(subscribers[1].cursor, '3');
  assert.deepEqual(launches[0].seen, ['get_state', 'prompt']);

  const cancelled = once(client, 'event');
  await client.abort();
  assert.deepEqual(await cancelled, [{ type: 'agent_settled', aborted: true }]);
  await client.close();
  assert.equal(client.isRunning, false);
  const reopened = new PiHttpClient({ ...settings, threadId, timeoutMs: 3000 });
  t.after(() => reopened.close().catch(() => {}));
  assert.equal((await reopened.getState()).model.id, 'hy4');
  assert.equal(launches.length, 2);
  await reopened.close();
});

test('Pi HTTPS uploads a DOCX idempotently and verifies the downloaded bytes', { timeout: 12000 }, async t => {
  const f = await fixture(t, { office: true });
  if (!f) return;
  const client = new PiHttpClient({ ...f.settings, threadId: 'pi-thread-' + randomUUID(), timeoutMs: 3000 });
  t.after(() => client.close().catch(() => {}));
  await client.start();
  const bytes = zip(docx('HTTPS transport fixture'));
  const entry = { name: 'Fixture input.docx', kind: 'input', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  assert.deepEqual(await client.putFile(entry.name, bytes), entry);
  assert.deepEqual(await client.putFile(entry.name, bytes), entry);
  assert.deepEqual(await client.listFiles(), [entry]);
  assert.deepEqual(await client.getFile(entry.name), bytes);
  await assert.rejects(client.putFile('../Fixture input.docx', bytes), /Invalid remote Pi DOCX filename/);
  await client.close();
});
