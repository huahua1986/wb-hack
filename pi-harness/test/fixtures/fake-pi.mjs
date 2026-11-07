// Test process only. Its prompts and custom commands never invoke a model.
let pending = Buffer.alloc(0);
let activeRun;
const ignoreEof = process.argv.includes('--ignore-eof');
const slowExit = process.argv.includes('--slow-exit');
const sessionIndex = process.argv.indexOf('--session');
const sessionFile = sessionIndex === -1 ? undefined : process.argv[sessionIndex + 1];
const keepAlive = ignoreEof || slowExit ? setInterval(() => {}, 1000) : undefined;

const output = record => process.stdout.write(`${JSON.stringify(record)}\n`);
const respond = (command, data) => output({ type: 'response', id: command.id, command: command.type, success: true, data });

function handle(command) {
  switch (command.type) {
    case 'get_state':
      respond(command, { sessionId: 'fixture-session', sessionFile, isStreaming: Boolean(activeRun), messageCount: 0 });
      break;
    case 'get_messages':
      respond(command, { messages: [] });
      break;
    case 'echo':
      setTimeout(() => respond(command, { value: command.value }), command.delay ?? 0);
      break;
    case 'unicode': {
      const bytes = Buffer.from(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: {
        type: 'text_delta', contentIndex: 0, delta: '汉字\u2028line\u2029end🙂',
      } })}\r\n`, 'utf8');
      // Split a multibyte code point as well as the LF delimiter across chunks.
      const split = bytes.indexOf(Buffer.from('汉')) + 1;
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => {
        process.stdout.write(bytes.subarray(split, -1));
        setTimeout(() => {
          process.stdout.write(bytes.subarray(-1));
          respond(command, { framed: true });
        }, 2);
      }, 2);
      break;
    }
    case 'prompt':
      if (command.message === '/handled') {
        respond(command, { disposition: 'handled' });
      } else {
        respond(command, { disposition: 'started' });
        output({ type: 'agent_start' });
        activeRun = setTimeout(() => {
          activeRun = undefined;
          output({ type: 'agent_end', messages: [], willRetry: false });
          setTimeout(() => output({ type: 'agent_settled', aborted: false }), 5);
        }, command.message === '/slow' ? 1000 : 20);
      }
      break;
    case 'abort':
      clearTimeout(activeRun);
      activeRun = undefined;
      respond(command);
      output({ type: 'agent_end', messages: [], willRetry: false });
      output({ type: 'agent_settled', aborted: true });
      break;
    case 'fail':
      output({ type: 'response', id: command.id, command: command.type, success: false, error: 'secret-provider-response' });
      break;
    case 'wrong_command':
      output({ type: 'response', id: command.id, command: 'not_the_command', success: true });
      break;
    case 'oversize':
      process.stdout.write('x'.repeat(8192));
      break;
    case 'invalid':
      process.stdout.write('secret-invalid-output\n');
      break;
    case 'invalid_utf8':
      process.stdout.write(Buffer.from([123, 34, 116, 121, 112, 101, 34, 58, 34, 0xff, 34, 125, 10]));
      break;
    case 'unterminated':
      process.stdout.write(JSON.stringify({ type: 'agent_start' }), () => process.exit(0));
      break;
    case 'stderr':
      process.stderr.write('secret-api-key-and-private-prompt'.repeat(1024), () => respond(command, { redacted: true }));
      break;
    case 'never':
      break;
    case 'exit':
      process.exit(17);
      break;
    default:
      output({ type: 'response', id: command.id, command: command.type, success: false, error: 'Unsupported fixture command' });
  }
}

process.stdin.on('data', chunk => {
  pending = Buffer.concat([pending, chunk]);
  let newline;
  while ((newline = pending.indexOf(10)) !== -1) {
    const line = pending.subarray(0, newline);
    pending = pending.subarray(newline + 1);
    handle(JSON.parse(line.toString('utf8')));
  }
});

process.stdin.on('end', () => {
  if (slowExit) setTimeout(() => process.exit(0), 200);
  else if (!ignoreEof) process.exit(0);
});

process.on('SIGTERM', () => {
  if (!slowExit) {
    clearInterval(keepAlive);
    process.exit(0);
  }
});
