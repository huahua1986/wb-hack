'use strict';
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

function failure(code) { return Object.assign(Error(code), { code, status: 502, mayHaveExecuted: true }); }

/** One explicitly approved call, using a native resolved stdio launch specification.
 * No shell, packages, MCP discovery, account copies, stderr retention or call retries.
 */
async function callNativeStdio({ command, args = [], env, cwd, toolName, arguments: input, signal,
  timeoutMs = 110_000 }) {
  if (typeof command !== 'string' || !command || command.includes('\0') || !Array.isArray(args)
    || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || typeof cwd !== 'string'
    || !cwd.startsWith('/') || cwd.includes('\0') || typeof toolName !== 'string'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    || !env || typeof env !== 'object' || Object.entries(env).some(([key, value]) => !key || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0'))) {
    throw failure('NATIVE_MCP_STDIO_CONFIG_INVALID');
  }
  if (signal?.aborted) throw failure('NATIVE_MCP_CANCELLED');
  let child, timer, killTimer, nextId = 1, buffer = '', total = 0, closed = false, fatal;
  const pending = new Map(), decoder = new StringDecoder('utf8');
  function rejectAll(cause) { fatal = cause; for (const value of pending.values()) value.reject(cause); pending.clear(); }
  function send(value) {
    const line = JSON.stringify(value) + '\n';
    if (fatal) throw fatal;
    if (Buffer.byteLength(line) > 128 * 1024 || child.stdin.destroyed || closed) throw failure('NATIVE_MCP_STDIO_CLOSED');
    child.stdin.write(line, cause => { if (cause) rejectAll(failure('NATIVE_MCP_STDIO_CLOSED')); });
  }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++; pending.set(id, { resolve, reject });
      try { send({ jsonrpc: '2.0', id, method, params }); } catch (cause) { pending.delete(id); reject(cause); }
    });
  }
  const abort = () => { rejectAll(failure('NATIVE_MCP_CANCELLED')); child?.kill('SIGTERM'); };
  try {
    child = spawn(command, args, { cwd, env: { ...env }, shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    child.on('error', () => rejectAll(failure('NATIVE_MCP_STDIO_START_FAILED')));
    child.stdin.on('error', () => rejectAll(failure('NATIVE_MCP_STDIO_CLOSED')));
    child.stdout.on('error', () => rejectAll(failure('NATIVE_MCP_STDIO_CLOSED')));
    child.on('exit', () => { closed = true; rejectAll(failure('NATIVE_MCP_STDIO_CLOSED')); });
    child.stdout.on('data', chunk => {
      try {
        total += chunk.length; buffer += decoder.write(chunk);
        if (total > 4 * 1024 * 1024 || Buffer.byteLength(buffer) > 512 * 1024) throw failure('NATIVE_MCP_RESULT_LIMIT');
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const value = JSON.parse(line);
          if (value.jsonrpc !== '2.0') throw failure('NATIVE_MCP_STDIO_PROTOCOL');
          if (typeof value.method === 'string') {
            if (value.id !== undefined) send(value.method === 'ping' ? { jsonrpc: '2.0', id: value.id, result: {} }
              : { jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Client capability not supported' } });
            continue;
          }
          const wait = pending.get(value.id); if (!wait) continue;
          pending.delete(value.id);
          if (value.error || !Object.hasOwn(value, 'result')) wait.reject(failure('NATIVE_MCP_STDIO_TOOL_FAILED'));
          else wait.resolve(value.result);
        }
      } catch { rejectAll(failure('NATIVE_MCP_STDIO_PROTOCOL')); child.kill('SIGTERM'); }
    });
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { rejectAll(failure('NATIVE_MCP_TIMEOUT')); child.kill('SIGTERM'); }, timeoutMs);
    const initialized = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'workbuddy-pi-native-host', version: '0.3.0' } });
    if (!['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(initialized?.protocolVersion)
      || !initialized.capabilities?.tools) throw failure('NATIVE_MCP_STDIO_PROTOCOL');
    if (signal?.aborted) throw failure('NATIVE_MCP_CANCELLED');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const result = await request('tools/call', { name: toolName, arguments: input });
    if (signal?.aborted) throw failure('NATIVE_MCP_CANCELLED');
    if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw failure('NATIVE_MCP_RESULT_LIMIT');
    return result;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    rejectAll(failure('NATIVE_MCP_STDIO_CLOSED'));
    if (child && !closed && child.pid) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end(); child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      await exited; clearTimeout(killTimer);
    }
  }
}
module.exports = { callNativeStdio };
