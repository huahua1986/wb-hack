#!/usr/bin/env node
// Read-only, local acceptance fixture. No production data, credentials or network upstream.
import http from 'node:http';
import readline from 'node:readline';
import fs from 'node:fs';

const traceFile = process.argv.find(arg => arg.startsWith('--trace='))?.slice(8);
function trace(value) {
  if (!traceFile) return;
  try {
    const fd = fs.openSync(traceFile, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...value }) + '\n'); }
    finally { fs.closeSync(fd); }
  } catch { /* Diagnostic output must not alter the MCP wire protocol. */ }
}
trace({ event: 'start', executable: process.execPath, argumentCount: process.argv.length - 2, stdio: process.argv.includes('--stdio') });

const tool = { name: 'qa_lookup', description: '本机只读验收工具，返回固定的金融buddy 0.3.0 测试标记；不访问真实业务系统。',
  inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 256 } }, required: ['query'], additionalProperties: false } };
function respond(value) {
  if (!value || value.jsonrpc !== '2.0') return { jsonrpc: '2.0', id: value?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
  if (value.id === undefined) return null;
  const base = { jsonrpc: '2.0', id: value.id };
  if (value.method === 'initialize') return { ...base, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'native-content-mock', version: '0.3.0' } } };
  if (value.method === 'ping') return { ...base, result: {} };
  if (value.method === 'tools/list') return { ...base, result: { tools: [tool] } };
  if (value.method === 'tools/call' && value.params?.name === tool.name && typeof value.params?.arguments?.query === 'string'
    && value.params.arguments.query.length <= 256) return { ...base, result: { content: [{ type: 'text', text: 'NATIVE-MCP-030-OK：本机只读 Mock 已调用。' }], isError: false } };
  return { ...base, error: { code: -32601, message: 'Method not supported by read-only mock' } };
}
if (process.argv.includes('--stdio')) {
  process.stdin.on('data', bytes => trace({ event: 'input-bytes', bytes: bytes.length, hasLF: bytes.includes(10) }));
  process.stdin.on('end', () => trace({ event: 'input-end' }));
  process.stdin.on('error', () => trace({ event: 'input-error' }));
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', line => { try { const value = JSON.parse(line); trace({ event: 'method', method: value.method, hasId: value.id !== undefined });
    const result = respond(value); if (result) { const output = JSON.stringify(result) + '\n'; trace({ event: 'reply', bytes: Buffer.byteLength(output) }); process.stdout.write(output); }
  } catch { trace({ event: 'invalid-message' }); process.exitCode = 1; lines.close(); } });
} else {
  const index = process.argv.indexOf('--port'), port = index < 0 ? 18791 : Number(process.argv[index + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid port');
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST, DELETE' }).end(); return; }
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 64 * 1024) throw Error('Too large'); chunks.push(chunk); }
      const result = respond(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (!result) { res.writeHead(202).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'native-content-mock-030', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result));
    } catch { res.writeHead(400).end(); }
  });
  server.listen(port, '127.0.0.1', () => process.stdout.write(JSON.stringify({ status: 'ready', localMock: true, port }) + '\n'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
}
