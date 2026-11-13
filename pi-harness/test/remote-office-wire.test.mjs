import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { OFFICE_SERVER_ID, nativeToolName } from '../src/native-tools.mjs';
import { sshPiCommand } from '../src/ssh-pi.mjs';

const { runLauncher } = createRequire(import.meta.url)('../scripts/remote-pi-rpc.cjs');
const THREAD = 'pi-thread-2e8c9411-f5b6-40ec-9018-2242056ac2ec';
const TURN = 'pi-turn-2e8c9411-f5b6-40ec-9018-2242056ac2ec';
const NEXT_TURN = 'pi-turn-3e8c9411-f5b6-40ec-9018-2242056ac2ec';
const TOOL = nativeToolName(OFFICE_SERVER_ID, 'open_file');
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

function fixture(t, office, extensionsDir) {
  const home = mkdtempSync(join(tmpdir(), 'pi-office-wire-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough();
  const events = new EventEmitter();
  const requests = [], replies = [], processes = [];
  function collect(stream, records, type) {
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        const value = JSON.parse(line);
        records.push(value);
        events.emit(type, value);
      }
    });
  }
  collect(output, replies, 'reply');
  error.resume();
  runLauncher({ thread: THREAD, office, home, input, output, error,
    // Both pinned extensions must reside in one directory on the remote host.
    extensionsDir,
    launchPi(command, args, options) {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
      collect(child.stdin, requests, 'request');
      child.stdin.once('end', () => child.emit('close', 0));
      processes.push({ command, args, options, child });
      return child;
    },
    onExit(code) { events.emit('exit', code); },
  });
  const send = (value, stream = input) => stream.write(JSON.stringify(value) + '\n');
  return { input, events, requests, replies, processes, send, childSend: value => send(value, processes[0].child.stdout) };
}

function setup(t, office = true) {
  const extensionsDir = mkdtempSync(join(tmpdir(), 'pi-office-extensions-'));
  t.after(() => rmSync(extensionsDir, { recursive: true, force: true }));
  if (office) {
    copyFileSync(join(REPO, 'src/native-feature-extension.mjs'), join(extensionsDir, 'native-feature-extension.mjs'));
    copyFileSync(join(REPO, 'package-dmg/approval-extension.mjs'), join(extensionsDir, 'approval-extension.mjs'));
  }
  return fixture(t, office, extensionsDir);
}

function context(turnId = TURN) {
  return {
    version: 1, threadId: THREAD, turnId, instructions: 'Synthetic office context',
    tools: [{ name: TOOL, rawName: 'open_file', label: 'Open local Office file', description: 'Open a synthetic local DOCX',
      parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
  };
}

test('Office SSH launcher path is fixed and opt-in', () => {
  const ssh = { host: 'example.test', port: 22, user: 'runner', identityFile: '/private/key', knownHostsFile: '/private/pins' };
  assert.deepEqual(sshPiCommand(ssh, THREAD).args.slice(-2), ['/usr/local/libexec/workbuddy-pi-rpc', THREAD]);
  assert.deepEqual(sshPiCommand(ssh, THREAD, { office: true }).args.slice(-2), ['/usr/local/libexec/workbuddy-pi-office-rpc', THREAD]);
});

test('remote Office wire registers only vetted tools and correlates approval and result with the current turn', async t => {
  const f = setup(t);
  assert.equal(f.processes.length, 0);
  const configured = once(f.events, 'reply');
  f.send({ type: 'office_configure', id: 'cfg', context: context() });
  assert.deepEqual((await configured)[0], { type: 'response', id: 'cfg', command: 'office_configure', success: true, data: { turnId: TURN } });
  const process = f.processes[0];
  assert.equal(process.args[process.args.indexOf('--tools') + 1], TOOL);
  assert.ok(process.args.includes('--no-builtin-tools'));
  assert.ok(process.args.includes('--no-mcp'));
  assert.equal(JSON.parse(readFileSync(process.options.env.WORKBUDDY_PI_NATIVE_CONTEXT_FILE, 'utf8')).turnId, TURN);

  f.send({ type: 'prompt', id: 'turn', message: 'Open sample.docx', images: [] });
  const args = { file_path: 'sample.docx' };
  const request = once(f.events, 'reply');
  f.childSend({ type: 'extension_ui_request', id: 'approval', method: 'confirm', title: 'WorkBuddy Pi 操作确认',
    message: JSON.stringify({ protocol: 'workbuddy-host-approval-v1', toolCallId: 'call-1', toolName: TOOL, input: args }) });
  assert.equal((await request)[0].id, 'approval');
  f.send({ type: 'extension_ui_response', id: 'approval', confirmed: true });

  const result = once(f.events, 'reply');
  f.childSend({ type: 'extension_ui_request', id: 'result', method: 'input', title: 'WorkBuddy Native MCP',
    placeholder: JSON.stringify({ protocol: 'workbuddy-native-mcp-call-v1', toolCallId: 'call-1', name: TOOL,
      threadId: THREAD, turnId: TURN, arguments: args }) });
  assert.equal((await result)[0].id, 'result');
  const value = JSON.stringify({ ok: true, result: { content: [{ type: 'text', text: 'fixture result' }] } });
  f.send({ type: 'extension_ui_response', id: 'result', value });
  await setImmediate();
  assert.deepEqual(f.requests, [
    { type: 'prompt', id: 'turn', message: 'Open sample.docx' },
    { type: 'extension_ui_response', id: 'approval', confirmed: true },
    { type: 'extension_ui_response', id: 'result', value },
  ]);
  f.childSend({ type: 'agent_settled', aborted: false });
  const next = once(f.events, 'reply');
  f.send({ type: 'office_configure', id: 'next', context: context(NEXT_TURN) });
  assert.equal((await next)[0].data.turnId, NEXT_TURN);
  assert.equal(f.processes.length, 1);
  assert.equal(JSON.parse(readFileSync(process.options.env.WORKBUDDY_PI_NATIVE_CONTEXT_FILE, 'utf8')).turnId, NEXT_TURN);
  const exited = once(f.events, 'exit');
  f.input.end();
  assert.equal((await exited)[0], 0);
});

test('remote Office rejects unselected commands and a response without an active matching UI request', async t => {
  const f = setup(t);
  f.send({ type: 'office_configure', id: 'cfg', context: context() });
  f.send({ type: 'prompt', id: 'turn', message: 'Open sample.docx' });
  const exited = once(f.events, 'exit');
  f.send({ type: 'extension_ui_response', id: 'unsolicited', confirmed: true });
  assert.equal((await exited)[0], 65);
  assert.ok(!f.requests.some(request => request.id === 'unsolicited'));
});

test('plain SSH mode continues to reject Office commands and disables all tools', async t => {
  const f = setup(t, false);
  assert.ok(f.processes[0].args.includes('--no-tools'));
  const exited = once(f.events, 'exit');
  f.send({ type: 'office_configure', id: 'cfg', context: context() });
  assert.equal((await exited)[0], 65);
  assert.ok(!f.requests.some(request => request.id === 'cfg'));
});
