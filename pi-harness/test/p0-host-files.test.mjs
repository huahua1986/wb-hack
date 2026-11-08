import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PiHarness } from '../src/pi-harness.mjs';
import { SessionCheckpoints } from '../src/session-checkpoints.mjs';
import { FileJournal } from '../src/file-journal.mjs';
import { APPROVAL_READY, APPROVAL_TITLE, APPROVAL_PROTOCOL } from '../package-dmg/approval-extension.mjs';
import { NATIVE_READY, NATIVE_CALL, NATIVE_TITLE } from '../src/native-feature-extension.mjs';
import { nativeToolName, OFFICE_SERVER_ID } from '../src/native-tools.mjs';

const wait = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(read, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = read(); if (value) return value;
    await wait();
  }
  assert.fail(message);
}

class FileClient extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.prompts = []; this.uiResponses = [];
    this.executions = new Map(); this.closed = false;
    this.sessionFile = options.args[options.args.indexOf('--session') + 1];
  }
  event(value) { this.emit('event', value); }
  async start() {
    this.event({ type: 'extension_ui_request', method: 'notify', message: APPROVAL_READY });
    if (this.options.args.some(arg => arg.endsWith('/native-feature-extension.mjs'))) {
      this.event({ type: 'extension_ui_request', method: 'notify', message: NATIVE_READY });
    }
  }
  async getState() { return { isStreaming: false }; }
  async getSessionStats() { return { contextUsage: { tokens: null, contextWindow: 32768, percent: null } }; }
  append(value) { fs.appendFileSync(this.sessionFile, JSON.stringify(value) + '\n', { mode: 0o600 }); }
  async prompt(message) {
    if (!fs.existsSync(this.sessionFile)) this.append({ type: 'session', id: 'synthetic-pi-session' });
    this.append({ type: 'message', id: randomUUID(), message: { role: 'user', content: message } });
    this.prompts.push(message); return { disposition: 'started' };
  }
  async abort() { this.event({ type: 'agent_settled', aborted: true }); }
  async sendExtensionUiResponse(response) {
    this.uiResponses.push(structuredClone(response));
    const execute = this.executions.get(response.id);
    if (response.confirmed === true && execute) { this.executions.delete(response.id); execute(); }
  }
  async close() { this.closed = true; }
}

function setup(t, overrides = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-p0-host-files-')));
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd, { mode: 0o700 });
  const clients = [], events = [], harnesses = [];
  const options = {
    command: '/synthetic/pi-not-executed', cwd, stateDir: path.join(root, 'state'), agentDir: path.join(root, 'agent'),
    provider: 'local-fixture', model: 'synthetic-model', tools: ['read', 'write', 'edit', 'bash'], approvalMode: 'auto',
    cancelTimeoutMs: 30, requestTimeoutMs: 1000,
    clientFactory: config => { const client = new FileClient(config); clients.push(client); return client; },
    ...overrides,
  };
  const f = { root, cwd, clients, events, options };
  f.open = () => {
    const harness = new PiHarness(options); harnesses.push(harness); harness.subscribe(event => events.push(event));
    f.harness = harness; return harness;
  };
  f.open();
  t.after(async () => {
    await Promise.allSettled(harnesses.map(harness => harness.close()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}
const threadOf = (f, id) => f.harness.listThreads().find(thread => thread.id === id);
async function start(f, thread, marker = 'synthetic-write-turn') {
  const turn = await f.harness.startTurn({ threadId: thread.id, prompt: marker });
  await until(() => f.clients.findLast(client => client.prompts.includes(marker)), 'Synthetic Pi prompt was not started');
  return { turn, client: f.clients.findLast(client => client.prompts.includes(marker)) };
}
function request(client, { id, toolCallId, toolName, input, execute }) {
  if (execute) client.executions.set(id, execute);
  client.event({ type: 'extension_ui_request', id, method: 'confirm', title: APPROVAL_TITLE,
    message: JSON.stringify({ protocol: APPROVAL_PROTOCOL, toolName, toolCallId, input }) });
}
async function approvedWrite(f, thread, turn, client, name, content, { beforeMutation } = {}) {
  const id = `approve-${randomUUID()}`, toolCallId = `write-${randomUUID()}`;
  let mutations = 0;
  request(client, { id, toolCallId, toolName: 'write', input: { path: name, content }, execute: () => {
    beforeMutation?.(); mutations++;
    client.event({ type: 'tool_execution_start', toolCallId, toolName: 'write', args: { path: name, content } });
    fs.writeFileSync(path.join(thread.cwd, name), content, { mode: 0o600 });
    client.append({ type: 'message', id: randomUUID(), message: { role: 'toolResult', toolCallId, content: [{ type: 'text', text: 'synthetic write complete' }] } });
    client.event({ type: 'tool_execution_end', toolCallId, toolName: 'write', result: { content: [{ type: 'text', text: 'synthetic write complete' }] }, isError: false });
  } });
  await until(() => mutations === 1, 'Write did not execute after the approval true response');
  assert.equal(client.uiResponses.filter(response => response.id === id && response.confirmed === true).length, 1);
  assert.equal(mutations, 1);
  return toolCallId;
}
async function finish(f, thread, turn, client) {
  const message = { role: 'assistant', content: [{ type: 'text', text: 'P0-SYNTHETIC-DONE' }], stopReason: 'stop' };
  client.append({ type: 'message', id: randomUUID(), timestamp: new Date().toISOString(), message });
  client.event({ type: 'message_start', message: { role: 'assistant' } });
  client.event({ type: 'message_end', message });
  client.event({ type: 'agent_settled', aborted: false });
  await until(() => threadOf(f, thread.id).turns.find(value => value.id === turn.id)?.status === 'completed', 'Turn did not settle after file records');
}

test('Office save is approved, snapshots the existing target and can rewind the saved bytes', async t => {
  const rawName = 'save_file', toolName = nativeToolName(OFFICE_SERVER_ID, rawName);
  const calls = [], released = [];
  const f = setup(t, { nativeOffice: true, approvalMode: 'manual', nativeServices: {
    async listTools({ connectors }) {
      assert.ok(connectors.includes(OFFICE_SERVER_ID));
      return [{ serverId: OFFICE_SERVER_ID, rawName, inputSchema: { type: 'object' } }];
    },
    async callTool(params) {
      calls.push(params);
      fs.writeFileSync(path.join(params.cwd, params.arguments.file_path), 'changed by the editor');
      return { content: [{ type: 'text', text: 'saved' }] };
    },
    async releaseOffice(params) { released.push(params); },
  } });
  const thread = await f.harness.createThread();
  const baseline = await start(f, thread, 'office baseline');
  await finish(f, thread, baseline.turn, baseline.client);
  const file = path.join(f.cwd, 'sample.pptx');
  fs.writeFileSync(file, 'original');
  const { turn, client } = await start(f, thread, 'office edit');
  const filePath = { file_id: 'synthetic-document', file_path: 'sample.pptx' };
  const emitCall = (id, toolCallId, args) => client.event({ type: 'extension_ui_request', method: 'input',
    title: NATIVE_TITLE, id, placeholder: JSON.stringify({ protocol: NATIVE_CALL,
      threadId: thread.id, turnId: turn.id, toolCallId, name: toolName, arguments: args }) });
  async function authorize(id, args) {
    request(client, { id: `approve-${id}`, toolCallId: id, toolName, input: args });
    const pending = await until(() => threadOf(f, thread.id).turns.at(-1).interactions.find(x => x.toolItemId === id), 'Missing Office approval');
    await f.harness.respondInteraction({ interactionId: pending.id, response: 'allow-once' });
    emitCall(id, id, args);
    const response = await until(() => client.uiResponses.find(x => x.id === id), 'Missing Office response');
    return JSON.parse(response.value);
  }
  emitCall('unapproved', 'unknown', filePath);
  await until(() => client.uiResponses.some(x => x.id === 'unapproved'), 'Missing denial');
  assert.equal(calls.length, 0);
  assert.equal((await authorize('outside', { ...filePath, file_path: '../outside.pptx' })).code, 'NATIVE_OFFICE_SAVE_REFUSED');
  assert.equal(calls.length, 0);
  client.event({ type: 'tool_execution_start', toolCallId: 'save', toolName, args: filePath });
  assert.equal((await authorize('save', filePath)).ok, true);
  client.event({ type: 'tool_execution_end', toolCallId: 'save', toolName, result: { content: [{ type: 'text', text: 'saved' }] } });
  const saveAs = { ...filePath, file_path: 'copy.pptx' };
  client.event({ type: 'tool_execution_start', toolCallId: 'save-as', toolName, args: saveAs });
  assert.equal((await authorize('save-as', saveAs)).ok, true);
  client.event({ type: 'tool_execution_end', toolCallId: 'save-as', toolName, result: { content: [{ type: 'text', text: 'saved' }] } });
  await finish(f, thread, turn, client);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].connectors, [OFFICE_SERVER_ID]);
  assert.equal(released.at(-1).turnId, turn.id);
  assert.equal(fs.readFileSync(file, 'utf8'), 'changed by the editor');
  const undo = await f.harness.rewindThread({ threadId: thread.id, turnId: turn.id });
  assert.equal(undo.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(f.cwd, 'copy.pptx')), false);
});

test('Office shutdown requires a specific confirmation even in automatic mode', async t => {
  const rawName = 'shutdown', toolName = nativeToolName(OFFICE_SERVER_ID, rawName);
  const calls = [];
  const f = setup(t, { nativeOffice: true, nativeServices: {
    async listTools() { return [{ serverId: OFFICE_SERVER_ID, rawName, inputSchema: { type: 'object' } }]; },
    async callTool(params) { calls.push(params); return { content: [{ type: 'text', text: 'stopped' }] }; },
  } });
  const thread = await f.harness.createThread();
  const { turn, client } = await start(f, thread, 'Office shutdown');
  request(client, { id: 'approve-shutdown', toolCallId: 'shutdown-one', toolName, input: {} });
  const pending = await until(() => threadOf(f, thread.id).turns.at(-1).interactions.find(x => x.status === 'pending'), 'Missing shutdown confirmation');
  await f.harness.setApprovalMode({ threadId: thread.id, approvalMode: 'auto' });
  assert.equal(client.uiResponses.some(x => x.id === 'approve-shutdown'), false);
  const input = id => client.event({ type: 'extension_ui_request', method: 'input', title: NATIVE_TITLE, id,
    placeholder: JSON.stringify({ protocol: NATIVE_CALL, threadId: thread.id, turnId: turn.id,
      toolCallId: 'shutdown-one', name: toolName, arguments: {} }) });
  input('shutdown-before-confirm');
  await until(() => client.uiResponses.find(x => x.id === 'shutdown-before-confirm'), 'Missing denial');
  assert.equal(calls.length, 0);
  await f.harness.respondInteraction({ interactionId: pending.id, response: 'allow-once' });
  input('shutdown-after-confirm');
  const response = await until(() => client.uiResponses.find(x => x.id === 'shutdown-after-confirm'), 'Missing shutdown reply');
  assert.equal(JSON.parse(response.value).ok, true);
  assert.equal(calls.length, 1);
  await finish(f, thread, turn, client);
});
async function twoWrites(f) {
  const thread = await f.harness.createThread({ cwd: f.cwd });
  const first = await start(f, thread, 'first-synthetic-write');
  await approvedWrite(f, thread, first.turn, first.client, 'report.txt', 'FIRST-VERSION\n');
  await finish(f, thread, first.turn, first.client);
  const prefix = fs.readFileSync(first.client.sessionFile);
  const second = await start(f, thread, 'second-synthetic-write');
  await approvedWrite(f, thread, second.turn, second.client, 'report.txt', 'SECOND-VERSION\n');
  await finish(f, thread, second.turn, second.client);
  return { thread, first, second, prefix, full: fs.readFileSync(second.client.sessionFile), filename: path.join(f.cwd, 'report.txt') };
}

test('Host snapshots old file bytes before its true approval callback executes and projects durable resources on settlement', async t => {
  const f = setup(t), filename = path.join(f.cwd, 'report.txt');
  fs.writeFileSync(filename, 'ORIGINAL-BEFORE-APPROVAL\n', { mode: 0o600 });
  const thread = await f.harness.createThread({ cwd: f.cwd });
  const { turn, client } = await start(f, thread);
  await approvedWrite(f, thread, turn, client, 'report.txt', 'AFTER-APPROVAL\n', {
    beforeMutation: () => assert.equal(fs.readFileSync(filename, 'utf8'), 'ORIGINAL-BEFORE-APPROVAL\n'),
  });
  await finish(f, thread, turn, client);
  const resources = await f.harness.fileResources({ threadId: thread.id });
  assert.equal(resources.artifacts.length, 1);
  assert.equal(resources.artifacts[0].filePath, filename);
  assert.equal(resources.artifacts[0].requestId, turn.id);
  assert.equal(resources.manifests.length, 1);
  assert.equal(resources.manifests[0].files[0].action, 'modify');
  const detail = await f.harness.fileResources({ threadId: thread.id, detailRef: turn.id });
  assert.equal(detail.detail.requestId, turn.id);
  assert.equal(detail.detail.files[0].content, 'AFTER-APPROVAL\n');
  assert.deepEqual(detail.detail.files[0].hunks.flatMap(hunk => hunk.lines), ['-ORIGINAL-BEFORE-APPROVAL', '+AFTER-APPROVAL']);
  assert.ok(f.events.some(event => event.type === 'files.updated' && event.threadId === thread.id));
});

test('manual approval snapshots the latest user bytes and rejected operations never mutate a file', async t => {
  const f = setup(t, { approvalMode: 'manual' }), filename = path.join(f.cwd, 'report.txt');
  fs.writeFileSync(filename, 'BEFORE-REQUEST\n', { mode: 0o600 });
  const thread = await f.harness.createThread({ cwd: f.cwd }), { turn, client } = await start(f, thread);
  let mutations = 0;
  const id = 'manual-write', toolCallId = 'manual-write-tool';
  request(client, { id, toolCallId, toolName: 'write', input: { path: 'report.txt', content: 'AFTER-MANUAL-APPROVAL\n' }, execute: () => {
    assert.equal(fs.readFileSync(filename, 'utf8'), 'USER-EDIT-WHILE-WAITING\n'); mutations++;
    client.event({ type: 'tool_execution_start', toolCallId, toolName: 'write', args: { path: 'report.txt' } });
    fs.writeFileSync(filename, 'AFTER-MANUAL-APPROVAL\n');
    client.event({ type: 'tool_execution_end', toolCallId, toolName: 'write', result: { content: [{ type: 'text', text: 'done' }] }, isError: false });
  } });
  const pending = await until(() => threadOf(f, thread.id).turns[0].interactions.find(value => value.status === 'pending'), 'Manual approval was not exposed');
  assert.equal(mutations, 0); assert.equal(fs.readFileSync(filename, 'utf8'), 'BEFORE-REQUEST\n');
  fs.writeFileSync(filename, 'USER-EDIT-WHILE-WAITING\n');
  await f.harness.respondInteraction({ interactionId: pending.id, response: true });
  assert.equal(mutations, 1);
  const rejectId = 'manual-reject';
  request(client, { id: rejectId, toolCallId: 'rejected-tool', toolName: 'write', input: { path: 'report.txt', content: 'MUST-NOT-WRITE' },
    execute: () => { mutations++; fs.writeFileSync(filename, 'MUST-NOT-WRITE'); } });
  const rejected = await until(() => threadOf(f, thread.id).turns[0].interactions.find(value => value.status === 'pending'), 'Second manual approval was not exposed');
  await f.harness.respondInteraction({ interactionId: rejected.id, response: false });
  assert.equal(mutations, 1);
  assert.ok(client.uiResponses.some(value => value.id === rejectId && value.confirmed === false));
  await finish(f, thread, turn, client);
  const { detail } = await f.harness.fileResources({ threadId: thread.id, detailRef: turn.id });
  assert.deepEqual(detail.files[0].hunks.flatMap(hunk => hunk.lines), ['-USER-EDIT-WHILE-WAITING', '+AFTER-MANUAL-APPROVAL']);
});

test('snapshot failure denies the mutation and produces a failed turn instead of an untracked write', async t => {
  const f = setup(t), filename = path.join(f.cwd, 'report.txt');
  fs.writeFileSync(filename, 'UNCHANGED\n');
  const thread = await f.harness.createThread({ cwd: f.cwd }), { turn, client } = await start(f, thread);
  const original = FileJournal.prototype.beforeTool;
  FileJournal.prototype.beforeTool = async () => { throw new Error('synthetic-snapshot-unavailable'); };
  let mutations = 0;
  try {
    request(client, { id: 'failed-snapshot', toolCallId: 'blocked-write', toolName: 'write', input: { path: 'report.txt', content: 'UNTRACKED' },
      execute: () => { mutations++; fs.writeFileSync(filename, 'UNTRACKED'); } });
    await until(() => threadOf(f, thread.id).turns.find(value => value.id === turn.id)?.status === 'failed', 'Snapshot failure was not surfaced');
  } finally { FileJournal.prototype.beforeTool = original; }
  assert.equal(mutations, 0); assert.equal(fs.readFileSync(filename, 'utf8'), 'UNCHANGED\n');
  assert.ok(client.uiResponses.some(value => value.id === 'failed-snapshot' && value.confirmed === false));
});

test('cancelling a pending snapshot cannot deliver a late positive authorization', async t => {
  const f = setup(t), filename = path.join(f.cwd, 'report.txt');
  fs.writeFileSync(filename, 'UNCHANGED\n');
  const thread = await f.harness.createThread({ cwd: f.cwd }), { turn, client } = await start(f, thread);
  const original = FileJournal.prototype.beforeTool;
  let entered = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  FileJournal.prototype.beforeTool = async function (params) { entered = true; await gate; return original.call(this, params); };
  let mutations = 0;
  try {
    request(client, { id: 'cancelled-snapshot', toolCallId: 'cancelled-write', toolName: 'write', input: { path: 'report.txt', content: 'LATE-WRITE' },
      execute: () => { mutations++; fs.writeFileSync(filename, 'LATE-WRITE'); } });
    await until(() => entered, 'Snapshot gate was not reached');
    const cancelling = f.harness.cancelTurn({ threadId: thread.id, turnId: turn.id });
    await until(() => client.closed, 'Cancelled Pi client was not closed');
    release(); await cancelling;
    await wait();
  } finally { release(); FileJournal.prototype.beforeTool = original; }
  assert.equal(mutations, 0); assert.equal(fs.readFileSync(filename, 'utf8'), 'UNCHANGED\n');
  assert.equal(client.uiResponses.some(value => value.id === 'cancelled-snapshot' && value.confirmed === true), false);
  assert.equal(threadOf(f, thread.id).turns.find(value => value.id === turn.id).status, 'cancelled');
});

test('two writes rewind the second turn, restore the exact Pi prefix and retain full private session backup', async t => {
  const f = setup(t), run = await twoWrites(f);
  const preview = await f.harness.checkpointRead({ threadId: run.thread.id, turnId: run.second.turn.id });
  assert.equal(preview.available, true);
  assert.ok(preview.diff.changes.some(change => change.path === run.filename && change.operation === 'write'));
  const result = await f.harness.rewindThread({ threadId: run.thread.id, turnId: run.second.turn.id });
  assert.equal(result.branchChanged, true);
  assert.equal(result.truncatedFromRequestId, run.second.turn.id);
  assert.deepEqual(result.removedRequestIds, [run.second.turn.id]);
  assert.equal(fs.readFileSync(run.filename, 'utf8'), 'FIRST-VERSION\n');
  assert.deepEqual(fs.readFileSync(run.second.client.sessionFile), run.prefix);
  assert.deepEqual(threadOf(f, run.thread.id).turns.map(turn => turn.id), [run.first.turn.id]);
  assert.equal(run.second.client.closed, true);
  const backupRoot = path.join(f.options.stateDir, 'rewind-backups');
  const operations = fs.readdirSync(backupRoot);
  assert.equal(operations.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(backupRoot, operations[0], 'session-before-rewind.jsonl')), run.full);
  const hostBackup = JSON.parse(fs.readFileSync(path.join(backupRoot, operations[0], 'thread-before-rewind.json')));
  assert.deepEqual(hostBackup.turns.map(turn => turn.id), [run.first.turn.id, run.second.turn.id]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backupRoot, operations[0], 'transaction.json'))).status, 'complete');
  const resources = await f.harness.fileResources({ threadId: run.thread.id });
  assert.equal(resources.artifacts[0].requestId, run.first.turn.id);
  assert.deepEqual(resources.manifests.map(manifest => manifest.requestId), [run.first.turn.id]);
});

test('resources and safe rewind remain available after Host restart without replaying a Pi prompt', async t => {
  const f = setup(t), run = await twoWrites(f);
  await f.harness.close(); const clientCount = f.clients.length; f.open();
  const resources = await f.harness.fileResources({ threadId: run.thread.id });
  assert.equal(resources.manifests.length, 2);
  assert.equal(f.clients.length, clientCount);
  await f.harness.rewindThread({ threadId: run.thread.id, turnId: run.second.turn.id });
  assert.equal(f.clients.length, clientCount);
  assert.equal(fs.readFileSync(run.filename, 'utf8'), 'FIRST-VERSION\n');
  assert.deepEqual(fs.readFileSync(run.second.client.sessionFile), run.prefix);
});

test('external file edits reject rewind before file or history mutation', async t => {
  const f = setup(t), run = await twoWrites(f);
  fs.writeFileSync(run.filename, 'EXTERNAL-USER-EDIT\n');
  const stateBefore = threadOf(f, run.thread.id);
  await assert.rejects(f.harness.rewindThread({ threadId: run.thread.id, turnId: run.second.turn.id }), { code: 'PI_CHECKPOINT_CONFLICT' });
  assert.equal(fs.readFileSync(run.filename, 'utf8'), 'EXTERNAL-USER-EDIT\n');
  assert.deepEqual(fs.readFileSync(run.second.client.sessionFile), run.full);
  assert.deepEqual(threadOf(f, run.thread.id).turns, stateBefore.turns);
});

test('a real synthetic native MCP call prevents whole-turn rewind of external effects', async t => {
  const serverId = 'custom-mcp:p0-synthetic', rawName = 'synthetic_effect', name = nativeToolName(serverId, rawName);
  let nativeCalls = 0;
  const f = setup(t, { nativeServices: {
    async listTools() { return [{ sourceType: 'user', selectedGlobally: true, serverId, connectorId: serverId, rawName,
      description: 'Synthetic in-memory side effect, no external service.', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }]; },
    async callTool() { nativeCalls++; return { content: [{ type: 'text', text: 'SYNTHETIC-EFFECT-RESULT' }], isError: false }; },
  } });
  const thread = await f.harness.createThread({ cwd: f.cwd }), { turn, client } = await start(f, thread);
  const id = 'native-approval', toolCallId = 'synthetic-native-tool', args = { value: 'fixture' };
  request(client, { id, toolCallId, toolName: name, input: args });
  await until(() => client.uiResponses.some(response => response.id === id && response.confirmed === true), 'Native tool approval missing');
  client.event({ type: 'tool_execution_start', toolCallId, toolName: name, args });
  client.event({ type: 'extension_ui_request', id: 'native-call', method: 'input', title: NATIVE_TITLE,
    placeholder: JSON.stringify({ protocol: NATIVE_CALL, threadId: thread.id, turnId: turn.id, name, toolCallId, arguments: args }) });
  const reply = await until(() => client.uiResponses.find(response => response.id === 'native-call' && response.value), 'Synthetic native call result missing');
  assert.equal(JSON.parse(reply.value).ok, true); assert.equal(nativeCalls, 1);
  client.event({ type: 'tool_execution_end', toolCallId, toolName: name, result: JSON.parse(reply.value).result, isError: false });
  await finish(f, thread, turn, client);
  const history = fs.readFileSync(client.sessionFile);
  await assert.rejects(f.harness.rewindThread({ threadId: thread.id, turnId: turn.id }), { code: 'PI_CHECKPOINT_EXTERNAL_EFFECT' });
  assert.equal(nativeCalls, 1);
  assert.deepEqual(fs.readFileSync(client.sessionFile), history);
  assert.equal(threadOf(f, thread.id).turns.length, 1);
});

test('legacy turns without captured checkpoints remain readable and cannot be rewound', async t => {
  const f = setup(t), run = await twoWrites(f);
  await f.harness.close();
  const stateFile = path.join(f.options.stateDir, 'threads.json');
  const state = JSON.parse(fs.readFileSync(stateFile));
  const thread = state.threads.find(thread => thread.id === run.thread.id);
  delete thread.turns[0].sessionCheckpoint;
  fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 }); f.open();
  assert.equal((await f.harness.checkpointRead({ threadId: thread.id, turnId: run.first.turn.id })).available, false);
  await assert.rejects(f.harness.rewindThread({ threadId: thread.id, turnId: run.first.turn.id }), { code: 'PI_CHECKPOINT_UNAVAILABLE' });
  assert.equal(fs.readFileSync(run.filename, 'utf8'), 'SECOND-VERSION\n');
  assert.deepEqual(fs.readFileSync(run.second.client.sessionFile), run.full);
  assert.equal(threadOf(f, thread.id).turns.length, 2);
});

test('file commit rejection leaves session and Host history unchanged', async t => {
  const f = setup(t), run = await twoWrites(f), original = FileJournal.prototype.rollbackTurn;
  FileJournal.prototype.rollbackTurn = async () => ({ applied: false, reason: 'synthetic-precommit-conflict' });
  try {
    await assert.rejects(f.harness.rewindThread({ threadId: run.thread.id, turnId: run.second.turn.id }), { code: 'PI_CHECKPOINT_CONFLICT' });
  } finally { FileJournal.prototype.rollbackTurn = original; }
  assert.equal(fs.readFileSync(run.filename, 'utf8'), 'SECOND-VERSION\n');
  assert.deepEqual(fs.readFileSync(run.second.client.sessionFile), run.full);
  assert.equal(threadOf(f, run.thread.id).turns.length, 2);
  assert.equal(threadOf(f, run.thread.id).pendingRewind, undefined);
});

test('coordinator interruption after file commit records recoverable partial state and blocks replay', async t => {
  const f = setup(t), run = await twoWrites(f), original = SessionCheckpoints.prototype.restore;
  SessionCheckpoints.prototype.restore = () => { throw new Error('synthetic-session-commit-interruption'); };
  try {
    await assert.rejects(f.harness.rewindThread({ threadId: run.thread.id, turnId: run.second.turn.id }), { code: 'PI_CHECKPOINT_RECOVERY_REQUIRED' });
  } finally { SessionCheckpoints.prototype.restore = original; }
  // This deliberately verifies a recoverable partial transaction, not cross-filesystem atomicity.
  assert.equal(fs.readFileSync(run.filename, 'utf8'), 'FIRST-VERSION\n');
  assert.deepEqual(fs.readFileSync(run.second.client.sessionFile), run.full);
  const current = threadOf(f, run.thread.id);
  assert.equal(current.turns.length, 2);
  assert.equal(current.pendingRewind, undefined, 'Private recovery coordinates must not leak in public thread data');
  const saved = JSON.parse(fs.readFileSync(path.join(f.options.stateDir, 'threads.json'))).threads.find(thread => thread.id === run.thread.id);
  assert.equal(saved.pendingRewind.phase, 'files-restored');
  assert.equal(current.status, 'error');
  const backup = path.join(f.options.stateDir, 'rewind-backups', saved.pendingRewind.backupId, 'session-before-rewind.jsonl');
  assert.deepEqual(fs.readFileSync(backup), run.full);
  await assert.rejects(f.harness.startTurn({ threadId: run.thread.id, prompt: 'MUST-NOT-REPLAY' }),
    error => ['PI_CHECKPOINT_RECOVERY_REQUIRED', 'UNAVAILABLE'].includes(error.code));
  await f.harness.close(); const clientCount = f.clients.length; f.open();
  await assert.rejects(f.harness.startTurn({ threadId: run.thread.id, prompt: 'MUST-NOT-REPLAY-AFTER-RESTART' }),
    error => ['PI_CHECKPOINT_RECOVERY_REQUIRED', 'UNAVAILABLE'].includes(error.code));
  assert.equal(f.clients.length, clientCount);
});

test('immediate Host close cancels a rewind before commit and leaves file, Pi history and Host turns unchanged', async t => {
  const f = setup(t), run = await twoWrites(f), original = FileJournal.prototype.rollbackTurn;
  let commits = 0;
  FileJournal.prototype.rollbackTurn = function (params) { commits++; return original.call(this, params); };
  try {
    const rewinding = f.harness.rewindThread({ threadId: run.thread.id, turnId: run.second.turn.id });
    const rejected = assert.rejects(rewinding, error => error.code === 'CONFLICT' || error.code === 'PI_HOST_CLOSED');
    await f.harness.close();
    await rejected;
    await wait();
  } finally { FileJournal.prototype.rollbackTurn = original; }
  assert.equal(commits, 0);
  assert.equal(fs.readFileSync(run.filename, 'utf8'), 'SECOND-VERSION\n');
  assert.deepEqual(fs.readFileSync(run.second.client.sessionFile), run.full);
  const saved = JSON.parse(fs.readFileSync(path.join(f.options.stateDir, 'threads.json'))).threads.find(thread => thread.id === run.thread.id);
  assert.deepEqual(saved.turns.map(turn => turn.id), [run.first.turn.id, run.second.turn.id]);
  assert.equal(saved.pendingRewind, undefined);
  assert.deepEqual(fs.readdirSync(path.join(f.options.stateDir, 'rewind-backups')), []);
});

test('Host close waits for an already committing file/session rewind rather than abandoning it', async t => {
  const f = setup(t), run = await twoWrites(f), original = FileJournal.prototype.rollbackTurn;
  let entered = false, release, closeFinished = false, rewinding, closing;
  const gate = new Promise(resolve => { release = resolve; });
  FileJournal.prototype.rollbackTurn = async function (params) { entered = true; await gate; return original.call(this, params); };
  try {
    rewinding = f.harness.rewindThread({ threadId: run.thread.id, turnId: run.second.turn.id });
    await until(() => entered, 'File commit gate was not reached');
    closing = f.harness.close().then(() => { closeFinished = true; });
    await wait();
    assert.equal(closeFinished, false, 'Normal shutdown must wait for the held commit');
    assert.equal(fs.readFileSync(run.filename, 'utf8'), 'SECOND-VERSION\n');
    assert.deepEqual(fs.readFileSync(run.second.client.sessionFile), run.full);
    release();
    const result = await rewinding;
    await closing;
    assert.equal(result.branchChanged, true);
    assert.equal(closeFinished, true);
  } finally {
    release(); FileJournal.prototype.rollbackTurn = original;
    await Promise.allSettled([rewinding, closing].filter(Boolean));
  }
  assert.equal(fs.readFileSync(run.filename, 'utf8'), 'FIRST-VERSION\n');
  assert.deepEqual(fs.readFileSync(run.second.client.sessionFile), run.prefix);
  const saved = JSON.parse(fs.readFileSync(path.join(f.options.stateDir, 'threads.json'))).threads.find(thread => thread.id === run.thread.id);
  assert.deepEqual(saved.turns.map(turn => turn.id), [run.first.turn.id]);
  assert.equal(saved.pendingRewind, undefined);
  const backups = path.join(f.options.stateDir, 'rewind-backups');
  const ids = fs.readdirSync(backups); assert.equal(ids.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backups, ids[0], 'transaction.json'))).status, 'complete');
});

test('same-file mutation scope blocks a second thread until the first turn settles', async t => {
  const f = setup(t), filename = path.join(f.cwd, 'shared.txt');
  const a = await f.harness.createThread({ cwd: f.cwd }), b = await f.harness.createThread({ cwd: f.cwd });
  const first = await start(f, a, 'scope-first-thread');
  await approvedWrite(f, a, first.turn, first.client, 'shared.txt', 'FIRST-OWNER\n');
  assert.equal(threadOf(f, a.id).turns[0].status, 'running');
  const blocked = await start(f, b, 'scope-blocked-thread');
  let blockedWrites = 0;
  request(blocked.client, { id: 'scope-conflict', toolCallId: 'scope-conflict-write', toolName: 'write',
    input: { path: 'shared.txt', content: 'MUST-NOT-OVERWRITE\n' },
    execute: () => { blockedWrites++; fs.writeFileSync(filename, 'MUST-NOT-OVERWRITE\n'); } });
  await until(() => threadOf(f, b.id).turns.find(turn => turn.id === blocked.turn.id)?.status === 'failed', 'Competing file mutation was not rejected');
  assert.equal(threadOf(f, b.id).turns[0].error.code, 'PI_FILE_SCOPE_BUSY');
  assert.equal(blockedWrites, 0);
  assert.equal(blocked.client.uiResponses.some(response => response.id === 'scope-conflict' && response.confirmed === true), false);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'FIRST-OWNER\n');
  await finish(f, a, first.turn, first.client);
  const retry = await start(f, b, 'scope-retry-after-owner-settled');
  await approvedWrite(f, b, retry.turn, retry.client, 'shared.txt', 'SECOND-OWNER\n');
  await finish(f, b, retry.turn, retry.client);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'SECOND-OWNER\n');
  const firstDetail = await f.harness.fileResources({ threadId: a.id, detailRef: first.turn.id });
  assert.equal(firstDetail.detail.files[0].content, 'FIRST-OWNER\n', 'First task must not claim the later task content');
  const secondDetail = await f.harness.fileResources({ threadId: b.id, detailRef: retry.turn.id });
  assert.deepEqual(secondDetail.detail.files[0].hunks.flatMap(hunk => hunk.lines), ['-FIRST-OWNER', '+SECOND-OWNER']);
});

test('different explicit file targets may execute concurrently in the same cwd without cross-attribution', async t => {
  const f = setup(t);
  const a = await f.harness.createThread({ cwd: f.cwd }), b = await f.harness.createThread({ cwd: f.cwd });
  const first = await start(f, a, 'scope-file-a');
  await approvedWrite(f, a, first.turn, first.client, 'a.txt', 'ONLY-A\n');
  const second = await start(f, b, 'scope-file-b');
  await approvedWrite(f, b, second.turn, second.client, 'b.txt', 'ONLY-B\n');
  assert.equal(threadOf(f, a.id).turns[0].status, 'running');
  assert.equal(threadOf(f, b.id).turns[0].status, 'running');
  await finish(f, b, second.turn, second.client);
  await finish(f, a, first.turn, first.client);
  const resourcesA = await f.harness.fileResources({ threadId: a.id });
  const resourcesB = await f.harness.fileResources({ threadId: b.id });
  assert.deepEqual(resourcesA.artifacts.map(artifact => artifact.filePath), [path.join(f.cwd, 'a.txt')]);
  assert.deepEqual(resourcesB.artifacts.map(artifact => artifact.filePath), [path.join(f.cwd, 'b.txt')]);
  assert.deepEqual(resourcesA.manifests[0].files.map(file => file.filePath), [path.join(f.cwd, 'a.txt')]);
  assert.deepEqual(resourcesB.manifests[0].files.map(file => file.filePath), [path.join(f.cwd, 'b.txt')]);
});

test('a running Bash cwd scope blocks another thread explicit write even to a different filename', async t => {
  const f = setup(t);
  const a = await f.harness.createThread({ cwd: f.cwd }), b = await f.harness.createThread({ cwd: f.cwd });
  const first = await start(f, a, 'scope-bash-owner');
  let bashExecuted = 0;
  request(first.client, { id: 'bash-cwd-approval', toolCallId: 'bash-cwd-tool', toolName: 'bash',
    input: { command: 'synthetic Bash body, no shell is launched' }, execute: () => {
      bashExecuted++;
      first.client.event({ type: 'tool_execution_start', toolCallId: 'bash-cwd-tool', toolName: 'bash', args: { command: 'synthetic Bash body' } });
      fs.writeFileSync(path.join(f.cwd, 'bash-owned.txt'), 'BASH-OWNER\n');
      first.client.event({ type: 'tool_execution_end', toolCallId: 'bash-cwd-tool', toolName: 'bash', result: { content: [{ type: 'text', text: 'synthetic Bash complete' }] }, isError: false });
    } });
  await until(() => bashExecuted === 1, 'Synthetic Bash approval did not execute');
  const second = await start(f, b, 'scope-write-under-bash-cwd');
  let blockedWrites = 0;
  request(second.client, { id: 'bash-cwd-conflict', toolCallId: 'bash-cwd-conflict-tool', toolName: 'write',
    input: { path: 'different.txt', content: 'MUST-NOT-WRITE' }, execute: () => {
      blockedWrites++; fs.writeFileSync(path.join(f.cwd, 'different.txt'), 'MUST-NOT-WRITE');
    } });
  await until(() => threadOf(f, b.id).turns[0].status === 'failed', 'Bash parent scope did not reject the child file target');
  assert.equal(threadOf(f, b.id).turns[0].error.code, 'PI_FILE_SCOPE_BUSY');
  assert.equal(blockedWrites, 0);
  assert.equal(second.client.uiResponses.some(response => response.id === 'bash-cwd-conflict' && response.confirmed === true), false);
  assert.equal(fs.existsSync(path.join(f.cwd, 'different.txt')), false);
  await finish(f, a, first.turn, first.client);
  const resources = await f.harness.fileResources({ threadId: a.id });
  assert.deepEqual(resources.artifacts.map(artifact => artifact.filePath), [path.join(f.cwd, 'bash-owned.txt')]);
});

test('Darwin case-insensitive aliases share a mutation scope without rewriting user paths', { skip: process.platform !== 'darwin' }, async t => {
  const f = setup(t), upper = path.join(f.cwd, 'Report.txt'), lower = path.join(f.cwd, 'report.txt');
  fs.writeFileSync(upper, 'BEFORE-CASE-ALIAS\n', { mode: 0o600 });
  if (!fs.existsSync(lower)) { t.skip('The temporary filesystem is case-sensitive'); return; }
  assert.equal(fs.statSync(upper).ino, fs.statSync(lower).ino);
  const a = await f.harness.createThread({ cwd: f.cwd }), b = await f.harness.createThread({ cwd: f.cwd });
  const first = await start(f, a, 'case-alias-first-thread');
  await approvedWrite(f, a, first.turn, first.client, 'Report.txt', 'CASE-OWNER\n');
  const blocked = await start(f, b, 'case-alias-competing-thread');
  let overwritten = 0;
  request(blocked.client, { id: 'case-alias-conflict', toolCallId: 'case-alias-write', toolName: 'write',
    input: { path: 'report.txt', content: 'MUST-NOT-OVERWRITE\n' }, execute: () => {
      overwritten++; fs.writeFileSync(lower, 'MUST-NOT-OVERWRITE\n');
    } });
  await until(() => threadOf(f, b.id).turns[0].status === 'failed', 'Case-alias mutation was not rejected');
  assert.equal(threadOf(f, b.id).turns[0].error.code, 'PI_FILE_SCOPE_BUSY');
  assert.equal(overwritten, 0);
  assert.equal(blocked.client.uiResponses.some(response => response.id === 'case-alias-conflict' && response.confirmed === true), false);
  assert.equal(fs.readFileSync(upper, 'utf8'), 'CASE-OWNER\n');
  await finish(f, a, first.turn, first.client);
  const resources = await f.harness.fileResources({ threadId: a.id });
  assert.equal(resources.artifacts[0].filePath, upper);
  assert.equal(resources.manifests[0].files[0].filePath, upper);
});

test('complete Bash coverage with no file changes permits a pure history rewind', async t => {
  const f = setup(t), filename = path.join(f.cwd, 'report.txt');
  const thread = await f.harness.createThread({ cwd: f.cwd });
  const first = await start(f, thread, 'history-only-first-write');
  await approvedWrite(f, thread, first.turn, first.client, 'report.txt', 'FILE-MUST-STAY\n');
  await finish(f, thread, first.turn, first.client);
  const prefix = fs.readFileSync(first.client.sessionFile);
  const second = await start(f, thread, 'history-only-noop-bash');
  let executed = 0;
  request(second.client, { id: 'noop-bash-approval', toolCallId: 'noop-bash-tool', toolName: 'bash', input: { command: 'pwd' }, execute: () => {
    executed++;
    second.client.event({ type: 'tool_execution_start', toolCallId: 'noop-bash-tool', toolName: 'bash', args: { command: 'pwd' } });
    const result = { content: [{ type: 'text', text: thread.cwd + '\n' }] };
    second.client.append({ type: 'message', id: randomUUID(), message: { role: 'toolResult', toolCallId: 'noop-bash-tool', ...result } });
    second.client.event({ type: 'tool_execution_end', toolCallId: 'noop-bash-tool', toolName: 'bash', result, isError: false });
  } });
  await until(() => executed === 1, 'The approved synthetic pwd tool did not execute');
  assert.ok(second.client.uiResponses.some(response => response.id === 'noop-bash-approval' && response.confirmed === true));
  await finish(f, thread, second.turn, second.client);
  const full = fs.readFileSync(second.client.sessionFile);
  const preview = await f.harness.checkpointRead({ threadId: thread.id, turnId: second.turn.id });
  assert.equal(preview.available, true);
  assert.equal(preview.coverage.complete, true);
  assert.deepEqual(preview.diff.changes, []);
  const result = await f.harness.rewindThread({ threadId: thread.id, turnId: second.turn.id });
  assert.equal(result.branchChanged, true);
  assert.deepEqual(result.removedRequestIds, [second.turn.id]);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'FILE-MUST-STAY\n');
  assert.deepEqual(fs.readFileSync(second.client.sessionFile), prefix);
  assert.deepEqual(threadOf(f, thread.id).turns.map(turn => turn.id), [first.turn.id]);
  const backupRoot = path.join(f.options.stateDir, 'rewind-backups');
  const backups = fs.readdirSync(backupRoot); assert.equal(backups.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(backupRoot, backups[0], 'session-before-rewind.jsonl')), full);
});
