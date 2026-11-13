import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readPiConfig } from '../src/config.mjs';
import { PiHarness } from '../src/pi-harness.mjs';
import { sshPiCommand } from '../src/ssh-pi.mjs';
import { nativeToolName, OFFICE_SERVER_ID } from '../src/native-tools.mjs';
import { NATIVE_CALL, NATIVE_READY, NATIVE_TITLE } from '../src/native-feature-extension.mjs';
import { APPROVAL_PROTOCOL, APPROVAL_READY, APPROVAL_TITLE } from '../package-dmg/approval-extension.mjs';

function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-ssh-test-')));
  const hosts = [];
  t.after(async () => {
    try { await Promise.all(hosts.map(host => host.close())); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  const key = join(dir, 'key'), knownHosts = join(dir, 'pinned hosts');
  writeFileSync(key, 'synthetic identity\n', { mode: 0o600 });
  writeFileSync(knownHosts, 'synthetic host key\n', { mode: 0o600 });
  const file = join(dir, 'pi.json');
  const config = { ssh: { host: '192.0.2.5', user: 'executor', port: 36000, identityFile: key, knownHostsFile: knownHosts },
    cwd: dir, stateDir: join(dir, 'state'), agentDir: join(dir, 'agent'), provider: 'tokenlink', model: 'hy4' };
  function load(value = config) {
    writeFileSync(file, JSON.stringify(value));
    return readPiConfig(file);
  }
  return { config, load, makeHost(options) {
    const host = new PiHarness(options);
    hosts.push(host);
    return host;
  } };
}

test('SSH config uses a fixed launcher and rejects shell input and local tools', t => {
  const { config, load } = setup(t);
  const result = load();
  assert.equal(result.command, undefined);
  const id = 'pi-thread-2e8c9411-f5b6-40ec-9018-2242056ac2ec';
  const command = sshPiCommand(result.ssh, id);
  assert.equal(command.command, '/usr/bin/ssh');
  assert.deepEqual(command.args.slice(-4), ['--', config.ssh.host, '/usr/local/libexec/workbuddy-pi-rpc', id]);
  assert.ok(command.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(command.args.includes(`UserKnownHostsFile="${config.ssh.knownHostsFile}"`));
  assert.throws(() => sshPiCommand(result.ssh, id + ' && echo bad'), /thread ID/);
  assert.throws(() => load({ ...config, ssh: { ...config.ssh, host: '-oProxyCommand=evil' } }), /destination/);
  assert.throws(() => load({ ...config, ssh: { ...config.ssh, knownHostsFile: '/tmp/%h' } }), /knownHostsFile/);
  assert.throws(() => load({ ...config, tools: ['read'] }), /SSH mode/);
});

class RemoteClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.started = new Promise(resolve => { this.promptReceived = resolve; });
    this.model = { provider: 'tokenlink', id: 'hy4' };
  }
  async start() {}
  async getState() { return { model: this.model }; }
  async prompt(message, options) { this.promptReceived({ message, options }); }
  async abort() { this.emit('event', { type: 'agent_settled', aborted: true }); }
  async close() { this.closed = true; }
}

test('SSH Office forwards only selected DOCX calls, keeps local paths out of replies and restores saved bytes', { timeout: 3000 }, async t => {
  const { config, load, makeHost } = setup(t);
  const selected = 'selected.docx', filename = join(config.cwd, selected);
  const sshOffice = { mode: 'edit', stagingRoot: join(config.cwd, 'staging'), documents: [selected] };
  assert.throws(() => load({ ...config, sshOffice: { ...sshOffice, documents: ['../outside.docx'] } }), /DOCX filenames/);
  writeFileSync(filename, 'before');
  const allowed = ['open_file', 'office_catalog', 'office_read', 'close_file', 'office_edit', 'save_file'];
  const fileId = 'pi-office-2e8c9411-f5b6-40ec-9018-2242056ac2ec';
  const calls = [], releases = [], responses = new EventEmitter();
  const nativeServices = {
    async listTools() {
      return [...allowed, 'shutdown'].map(rawName => ({ serverId: OFFICE_SERVER_ID, rawName, inputSchema: { type: 'object' } }));
    },
    async callTool(params) {
      calls.push(params.rawName);
      if (params.rawName === 'open_file') return { structuredContent: { file_id: fileId, file_path: filename } };
      if (params.rawName === 'save_file') writeFileSync(filename, 'after');
      return { content: [{ type: 'text', text: 'Read from ' + filename }] };
    },
    async releaseOffice(params) { releases.push(params); },
  };
  let client;
  const connections = new EventEmitter();
  const host = makeHost({ ...load({ ...config, sshOffice }), nativeOffice: true, nativeServices, clientFactory(options) {
    client = new RemoteClient(options);
    client.request = async (name, fields) => {
      assert.equal(name, 'office_configure');
      assert.deepEqual(fields.context.tools.map(tool => tool.rawName), allowed);
      assert.match(fields.context.instructions, /selected\.docx/);
      assert.ok(!fields.context.instructions.includes(config.cwd));
      for (const message of [APPROVAL_READY, NATIVE_READY]) {
        client.emit('event', { type: 'extension_ui_request', method: 'notify', message });
      }
      return { turnId: fields.context.turnId };
    };
    client.sendExtensionUiResponse = async result => { responses.emit(result.id, result); };
    connections.emit('connected', client);
    return client;
  } });
  const events = new EventEmitter();
  host.subscribe(event => events.emit(event.type, event));
  const thread = await host.createThread();
  const connected = once(connections, 'connected');
  const turn = await host.startTurn({ threadId: thread.id, prompt: 'Open and edit the selected synthetic document.' });
  await connected;
  await client.started;
  assert.equal(host.describe().capabilities.nativeMcp, false);
  assert.deepEqual(host.describe().toolPolicy.enabledTools, []);
  assert.equal(client.options.args.at(-2), '/usr/local/libexec/workbuddy-pi-office-rpc');
  const tool = (rawName, suffix, args, method) => {
    const name = nativeToolName(OFFICE_SERVER_ID, rawName);
    const metadata = { toolCallId: suffix, name, arguments: args, threadId: thread.id, turnId: turn.id, protocol: NATIVE_CALL };
    if (method === 'confirm') client.emit('event', { type: 'extension_ui_request', method,
      id: 'confirm-' + suffix, title: APPROVAL_TITLE, message: JSON.stringify({ protocol: APPROVAL_PROTOCOL,
        toolCallId: suffix, toolName: name, input: args }) });
    else client.emit('event', { type: 'extension_ui_request', method, id: 'call-' + suffix, title: NATIVE_TITLE,
      placeholder: JSON.stringify(metadata) });
  };
  async function approve(rawName, suffix, args) {
    const requested = once(events, 'interaction.requested');
    tool(rawName, suffix, args, 'confirm');
    const [pending] = await requested;
    assert.equal(pending.payload.source, 'ssh-office');
    assert.match(pending.payload.description, /远端 Pi/);
    await host.respondInteraction({ interactionId: pending.interactionId, response: 'allow-once' });
    const result = once(responses, 'call-' + suffix);
    tool(rawName, suffix, args, 'input');
    return JSON.parse((await result)[0].value);
  }
  const denied = once(responses, 'confirm-outside');
  tool('open_file', 'outside', { file_path: '../outside.docx' }, 'confirm');
  assert.equal((await denied)[0].confirmed, false);
  assert.deepEqual(calls, []);
  const opened = await approve('open_file', 'open', { file_path: selected });
  assert.deepEqual(opened.result.structuredContent, { file_id: fileId, file_path: selected });
  const read = await approve('office_read', 'read', { name: 'doc_find', arguments: { file_id: fileId } });
  assert.ok(!JSON.stringify(read).includes(config.cwd));
  const saved = await approve('save_file', 'save', { file_path: selected, file_id: fileId });
  assert.equal(saved.ok, true);
  assert.equal(readFileSync(filename, 'utf8'), 'after');
  const completed = once(events, 'turn.completed');
  client.emit('event', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Done' } });
  client.emit('event', { type: 'agent_settled', aborted: false });
  await completed;
  assert.equal(releases.at(-1).turnId, turn.id);
  assert.equal(host.listThreads()[0].officeRestoreTurnId, turn.id);
  const restored = await host.restoreOfficeFiles({ threadId: thread.id, turnId: turn.id });
  assert.deepEqual(restored.files, [selected]);
  assert.equal(restored.thread.officeRestoreTurnId, null);
  assert.equal(restored.thread.turns.length, 1);
  assert.equal(readFileSync(filename, 'utf8'), 'before');
  await assert.rejects(host.restoreOfficeFiles({ threadId: thread.id, turnId: turn.id }), /只能恢复/);
  await assert.rejects(host.rewindThread({ threadId: thread.id, turnId: turn.id }), /暂不支持回退/);
});

test('SSH thread resumes with its remote ID, streams text and confirms cancellation', { timeout: 2000 }, async t => {
  const { config, load, makeHost } = setup(t);
  const clients = [];
  const connections = new EventEmitter();
  const options = { ...load(), cancelTimeoutMs: 100, clientFactory(command) {
    const client = new RemoteClient(command);
    clients.push(client);
    connections.emit('connection', client);
    return client;
  } };
  let host = makeHost(options);
  assert.equal(host.describe().capabilities.remoteExecution, true);
  assert.deepEqual(host.describe().toolPolicy.enabledTools, []);
  await assert.rejects(host.createThread({ cwd: '/my-files' }), /服务器分配/);
  const thread = await host.createThread();
  await assert.rejects(host.startTurn({ threadId: thread.id, promptContentBlocks: [{ type: 'image' }] }), /纯文本/);
  assert.equal(clients.length, 0);
  const events = new EventEmitter();
  host.subscribe(event => events.emit(event.type, event));
  const connecting = once(connections, 'connection');
  await host.startTurn({ threadId: thread.id, prompt: 'Remote test text' });
  const [client] = await connecting;
  assert.equal((await client.started).message, 'Remote test text');
  assert.equal(client.options.args.at(-1), thread.id);
  assert.deepEqual(client.options.env, { LANG: 'C' });
  const streamed = once(events, 'message.delta');
  client.emit('event', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'A partial response' } });
  assert.equal((await streamed)[0].payload.delta, 'A partial response');
  assert.equal((await host.cancelTurn({ threadId: thread.id })).status, 'cancelled');
  assert.equal(client.closed, true);
  await host.close();
  assert.equal(existsSync(join(config.stateDir, 'sessions')), false);
  assert.equal(JSON.parse(readFileSync(join(config.stateDir, 'threads.json'))).threads[0].turns[0].sessionCheckpoint, undefined);

  host = makeHost(options);
  assert.equal(host.listThreads()[0].turns[0].status, 'cancelled');
  const reconnecting = once(connections, 'connection');
  await host.startTurn({ threadId: thread.id, prompt: 'Continue' });
  const [resumed] = await reconnecting;
  assert.equal((await resumed.started).message, 'Continue');
  assert.deepEqual(resumed.options.args, client.options.args);
});

test('SSH stop without a terminal event surfaces an unconfirmed cancellation', { timeout: 2000 }, async t => {
  const { load, makeHost } = setup(t);
  const connections = new EventEmitter();
  const host = makeHost({ ...load(), cancelTimeoutMs: 30, clientFactory(options) {
    const client = new RemoteClient(options);
    client.abort = async () => {};
    connections.emit('connection', client);
    return client;
  } });
  const thread = await host.createThread();
  const connecting = once(connections, 'connection');
  await host.startTurn({ threadId: thread.id, prompt: 'Remote test text' });
  const [client] = await connecting;
  await client.started;
  const result = await host.cancelTurn({ threadId: thread.id });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'PI_SSH_CANCEL_UNCONFIRMED');
  assert.equal(client.closed, true);
});
