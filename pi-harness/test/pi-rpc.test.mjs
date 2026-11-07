import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PiRpcClient } from '../src/pi-rpc.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
function client(t, options = {}, args = []) {
  const value = new PiRpcClient({ command: process.execPath, args: [fixture, ...args], timeoutMs: 1000, ...options });
  t.after(() => value.close());
  return value;
}

const confirmFixture = String.raw`
  let pending = Buffer.alloc(0);
  let lastResponse;
  const send = record => process.stdout.write(JSON.stringify(record) + '\n');
  send({type: 'extension_ui_request', id: 'pi-provided-confirm-id', method: 'confirm', title: 'Fixture approval'});
  process.stdin.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    let newline;
    while ((newline = pending.indexOf(10)) !== -1) {
      const record = JSON.parse(pending.subarray(0, newline).toString('utf8'));
      pending = pending.subarray(newline + 1);
      if (record.type === 'extension_ui_response') {
        lastResponse = record;
        // Deliberately no ordinary command response, matching Pi's UI subprotocol.
        send({type: 'fixture_confirmed', record});
      } else {
        send({type: 'response', id: record.id, command: record.type, success: true, data: {lastResponse}});
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
`;

function confirmClient(t, options = {}) {
  return client(t, { args: ['--input-type=module', '-e', confirmFixture], ...options });
}

test('official model helper commands use exact Pi 1.1/1.4 RPC fields', async t => {
  const script = String.raw`
    let pending='';
    process.stdin.on('data', chunk => {
      pending+=chunk;
      let end;
      while((end=pending.indexOf('\n'))!==-1){
        const request=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);
        const data=request.type==='get_available_models'?{models:[{id:'hy4',provider:'workbuddy-official'}]}
          :request.type==='get_session_stats'?{tokens:{total:1315},contextUsage:{tokens:85,contextWindow:32768,percent:85/32768*100}}
          :{id:request.modelId,provider:request.provider};
        process.stdout.write(JSON.stringify({type:'response',id:request.id,command:request.type,success:true,data})+'\n');
      }
    });
    process.stdin.on('end',()=>process.exit(0));
  `;
  const rpc = client(t, { args: ['--input-type=module', '-e', script] });
  assert.deepEqual(await rpc.getAvailableModels(), { models: [{ id: 'hy4', provider: 'workbuddy-official' }] });
  assert.deepEqual(await rpc.setModel('workbuddy-official', 'hy4'), { id: 'hy4', provider: 'workbuddy-official' });
  assert.deepEqual(await rpc.getSessionStats(), { tokens: { total: 1315 },
    contextUsage: { tokens: 85, contextWindow: 32768, percent: 85 / 32768 * 100 } });
  assert.throws(() => rpc.setModel('', 'hy4'), TypeError);
});

test('Pi confirm replies preserve its id, are one-way and create no pending command', async t => {
  const rpc = confirmClient(t);
  const requested = once(rpc, 'event');
  await rpc.start();
  const [dialog] = await requested;
  assert.equal(dialog.type, 'extension_ui_request');
  assert.equal(dialog.method, 'confirm');
  const confirmed = once(rpc, 'event');
  assert.equal(await rpc.sendExtensionUiResponse({ id: dialog.id, confirmed: true }), undefined);
  assert.deepEqual((await confirmed)[0], { type: 'fixture_confirmed', record: {
    type: 'extension_ui_response', id: 'pi-provided-confirm-id', confirmed: true,
  } });
  assert.equal(rpc.diagnostics.pendingRequests, 0);
  assert.equal(rpc.diagnostics.queuedNotifications, 0);
  const denied = once(rpc, 'event');
  await rpc.sendExtensionUiResponse({ id: dialog.id, confirmed: false });
  assert.equal((await denied)[0].record.confirmed, false);
  // A subsequent ordinary command uses the same ordered write queue normally.
  assert.deepEqual(await rpc.getState(), { lastResponse: {
    type: 'extension_ui_response', id: dialog.id, confirmed: false,
  } });
  assert.equal(rpc.diagnostics.pendingRequests, 0);
});

test('confirm reply rejects malformed ids, non-booleans and unknown response fields before spawn', async t => {
  const rpc = confirmClient(t);
  for (const response of [
    undefined, null, [], {}, { id: '', confirmed: true }, { id: 'bad\nid', confirmed: true },
    { id: ' id', confirmed: true }, { id: 'x'.repeat(257), confirmed: true },
    { id: 'valid', confirmed: 'true' }, { id: 'valid', confirmed: true, value: 'private-value' },
    { id: 'valid', confirmed: true, type: 'prompt' },
  ]) {
    await assert.rejects(rpc.sendExtensionUiResponse(response), error => {
      assert.ok(error instanceof TypeError);
      assert.doesNotMatch(error.stack, /private-value/);
      return true;
    });
  }
  assert.equal(rpc.pid, undefined);
});

test('confirm reply respects output limits and closed state', async t => {
  const rpc = confirmClient(t, { maxRecordBytes: 256 });
  await assert.rejects(rpc.sendExtensionUiResponse({ id: 'x'.repeat(256), confirmed: true }), { code: 'PI_RPC_REQUEST_TOO_LARGE' });
  assert.equal(rpc.diagnostics.pendingRequests, 0);
  assert.equal(rpc.diagnostics.queuedNotifications, 0);
  await rpc.close();
  await assert.rejects(rpc.sendExtensionUiResponse({ id: 'valid', confirmed: false }), { code: 'PI_RPC_CLOSED' });
});

test('queued confirm replies have a separate bounded count and do not occupy command ids', async t => {
  const rpc = confirmClient(t, { maxPendingRequests: 1 });
  await rpc.start();
  const replies = await Promise.allSettled([
    rpc.sendExtensionUiResponse({ id: 'first', confirmed: true }),
    rpc.sendExtensionUiResponse({ id: 'second', confirmed: false }),
  ]);
  assert.equal(replies[0].status, 'fulfilled');
  assert.equal(replies[1].status, 'rejected');
  assert.equal(replies[1].reason.code, 'PI_RPC_PENDING_LIMIT');
  assert.equal(rpc.diagnostics.pendingRequests, 0);
  assert.equal(rpc.diagnostics.queuedNotifications, 0);
});

test('start is idempotent and caller session arguments survive without global configuration changes', async t => {
  const rpc = client(t, {}, ['--session', '/tmp/fixture-session.jsonl']);
  assert.equal(await rpc.start(), rpc);
  const pid = rpc.pid;
  assert.equal(await rpc.start(), rpc);
  assert.equal(rpc.pid, pid);
  assert.equal(rpc.isRunning, true);
  assert.deepEqual(await rpc.getState(), {
    sessionId: 'fixture-session', sessionFile: '/tmp/fixture-session.jsonl', isStreaming: false, messageCount: 0,
  });
  assert.deepEqual(await rpc.request('get_messages'), { messages: [] });
});

test('concurrent responses are correlated by id rather than arrival order', async t => {
  const rpc = client(t);
  const received = [];
  const requests = [40, 5, 20].map(delay => rpc.request('echo', { value: delay, delay }).then(result => {
    received.push(result.value);
    return result.value;
  }));
  assert.deepEqual(await Promise.all(requests), [40, 5, 20]);
  assert.deepEqual(received, [5, 20, 40]);
});

test('LF framing preserves Unicode separators, split UTF-8 and CRLF records', async t => {
  const rpc = client(t);
  const events = [];
  rpc.on('event', value => events.push(value));
  assert.deepEqual(await rpc.request('unicode'), { framed: true });
  assert.deepEqual(events, [{ type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', contentIndex: 0, delta: '汉字\u2028line\u2029end🙂',
  } }]);
  assert.equal(rpc.diagnostics.stdoutBufferedBytes, 0);
});

test('prompt is acceptance only; raw agent_end and agent_settled events stay distinct', async t => {
  const rpc = client(t);
  const events = [];
  const settled = new Promise(resolve => rpc.on('event', event => {
    events.push(event);
    if (event.type === 'agent_settled') resolve(event);
  }));
  assert.deepEqual(await rpc.prompt('/normal'), { disposition: 'started' });
  assert.equal(events.some(event => event.type === 'agent_settled'), false);
  assert.deepEqual(await settled, { type: 'agent_settled', aborted: false });
  assert.deepEqual(events.map(event => event.type), ['agent_start', 'agent_end', 'agent_settled']);
});

test('handled prompt resolves without waiting for a nonexistent settled event', async t => {
  const rpc = client(t);
  const events = [];
  rpc.on('event', event => events.push(event));
  assert.deepEqual(await rpc.prompt('/handled'), { disposition: 'handled' });
  assert.deepEqual(events, []);
});

test('abort is an RPC command and emits the resulting aborted run events', async t => {
  const rpc = client(t);
  const started = new Promise(resolve => rpc.on('event', event => { if (event.type === 'agent_start') resolve(); }));
  const settled = new Promise(resolve => rpc.on('event', event => { if (event.type === 'agent_settled') resolve(event); }));
  await rpc.prompt('/slow');
  await started;
  assert.equal(await rpc.abort(), undefined);
  assert.deepEqual(await settled, { type: 'agent_settled', aborted: true });
});

test('request cancellation and deadlines remove pending waits without poisoning the transport', async t => {
  const rpc = client(t);
  const controller = new AbortController();
  const request = rpc.request('never', {}, { signal: controller.signal });
  const cancelled = assert.rejects(request, { code: 'PI_RPC_ABORTED' });
  controller.abort();
  await cancelled;
  await assert.rejects(rpc.request('never', {}, { timeoutMs: 15 }), { code: 'PI_RPC_TIMEOUT' });
  assert.equal(rpc.diagnostics.pendingRequests, 0);
  assert.equal((await rpc.getState()).sessionId, 'fixture-session');
});

test('command errors do not expose remote error strings', async t => {
  const rpc = client(t);
  await assert.rejects(rpc.request('fail'), error => {
    assert.equal(error.code, 'PI_RPC_COMMAND_FAILED');
    assert.equal(error.command, 'fail');
    assert.doesNotMatch(JSON.stringify(error) + error.stack, /secret-provider-response/);
    return true;
  });
  assert.equal((await rpc.getState()).isStreaming, false);
});

test('process exit rejects every pending request and cannot be restarted accidentally', async t => {
  const rpc = client(t);
  const results = await Promise.allSettled([rpc.request('never'), rpc.request('never'), rpc.request('exit')]);
  assert.equal(results.length, 3);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'PI_RPC_EXITED');
    assert.equal(result.reason.exitCode, 17);
  }
  assert.equal(rpc.diagnostics.pendingRequests, 0);
  await assert.rejects(rpc.start(), { code: 'PI_RPC_EXITED' });
});

test('record limits reject unbounded stdout and requests before retaining large records', async t => {
  const rpc = client(t, { maxRecordBytes: 1024 });
  await assert.rejects(rpc.request('echo', { value: 'x'.repeat(1024) }), { code: 'PI_RPC_REQUEST_TOO_LARGE' });
  await assert.rejects(rpc.request('oversize'), { code: 'PI_RPC_RECORD_TOO_LARGE' });
  assert.equal(rpc.diagnostics.stdoutBufferedBytes, 0);
});

test('pending count is bounded', async t => {
  const rpc = client(t, { maxPendingRequests: 1 });
  await rpc.start();
  const controller = new AbortController();
  const waiting = rpc.request('never', {}, { signal: controller.signal });
  const cancelled = assert.rejects(waiting, { code: 'PI_RPC_ABORTED' });
  await assert.rejects(rpc.request('get_state'), { code: 'PI_RPC_PENDING_LIMIT' });
  controller.abort();
  await cancelled;
});

for (const [command, code] of [
  ['invalid', 'PI_RPC_INVALID_RECORD'],
  ['invalid_utf8', 'PI_RPC_INVALID_RECORD'],
  ['wrong_command', 'PI_RPC_INVALID_RECORD'],
  ['unterminated', 'PI_RPC_UNTERMINATED_RECORD'],
]) {
  test(`rejects ${command} stdout with a redacted error`, async t => {
    const entries = [];
    const rpc = client(t, { logger: entry => entries.push(entry) });
    await assert.rejects(rpc.request(command), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(JSON.stringify(error) + error.stack, /secret-/);
      return true;
    });
    assert.doesNotMatch(JSON.stringify(entries), /secret-/);
  });
}

test('stderr is counted, bounded and never retained or logged verbatim', async t => {
  const entries = [];
  const rpc = client(t, { maxStderrBytes: 32, logger: entry => entries.push(entry) });
  assert.deepEqual(await rpc.request('stderr'), { redacted: true });
  assert.equal(rpc.diagnostics.stderrRetainedBytes, 0);
  assert.equal(rpc.diagnostics.stderrLimitExceeded, true);
  assert.equal(entries.length, 2);
  assert.doesNotMatch(JSON.stringify(entries) + JSON.stringify(rpc.diagnostics), /secret-|api-key|private-prompt/);
});

test('close shuts stdin first, rejects pending requests and is idempotent', async t => {
  const rpc = client(t);
  await rpc.start();
  const pending = rpc.request('never');
  const rejected = assert.rejects(pending, { code: 'PI_RPC_CLOSED' });
  await rpc.close();
  await rejected;
  await rpc.close();
  assert.equal(rpc.isRunning, false);
  assert.equal(rpc.diagnostics.exitSignal, null);
  await assert.rejects(rpc.getState(), { code: 'PI_RPC_CLOSED' });
});

test('close falls back only to SIGTERM after bounded stdin shutdown', async t => {
  const entries = [];
  const rpc = client(t, { shutdownTimeoutMs: 20, terminateTimeoutMs: 1000, logger: entry => entries.push(entry) }, ['--ignore-eof']);
  await rpc.getState();
  await rpc.close();
  assert.equal(rpc.isRunning, false);
  assert.deepEqual(entries.filter(entry => entry.kind === 'shutdown_signal'), [{ kind: 'shutdown_signal', signal: 'SIGTERM' }]);
});

test('close timeout is bounded and does not escalate to SIGKILL', async () => {
  const entries = [];
  const rpc = new PiRpcClient({ command: process.execPath, args: [fixture, '--slow-exit'],
    shutdownTimeoutMs: 20, terminateTimeoutMs: 20, logger: entry => entries.push(entry) });
  await rpc.getState();
  const exit = once(rpc, 'exit');
  await assert.rejects(rpc.close(), { code: 'PI_RPC_CLOSE_TIMEOUT' });
  assert.equal(rpc.isRunning, true);
  await exit;
  assert.equal(rpc.isRunning, false);
  assert.deepEqual(entries.filter(entry => entry.kind === 'shutdown_signal'), [{ kind: 'shutdown_signal', signal: 'SIGTERM' }]);
});

test('spawn failures are redacted and requests reject promptly', async t => {
  const rpc = client(t, { command: '/nonexistent/pi-command' });
  await assert.rejects(rpc.getState(), { code: 'PI_RPC_START_FAILED' });
});
