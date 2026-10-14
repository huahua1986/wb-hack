import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

// Temporary localhost-only pass-through. Retain request bodies, never headers.
const directory = path.resolve('evidence/ollama-local/private');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.chmodSync(directory, 0o700);
const server = http.createServer((req, res) => {
  const target = new URL(req.url, 'http://127.0.0.1:11435');
  if (target.origin !== 'http://127.0.0.1:11435') { res.writeHead(400); res.end(); return; }
  const capture = req.method === 'POST' && target.pathname === '/v1/chat/completions';
  const chunks = [];
  let size = 0;
  if (capture) req.on('data', chunk => {
    size += chunk.length;
    if (size <= 8 * 1024 * 1024) chunks.push(chunk);
  });
  req.on('end', () => {
    if (!capture || size > 8 * 1024 * 1024) return;
    const bytes = Buffer.concat(chunks);
    try {
      const body = JSON.parse(bytes);
      const id = randomUUID();
      fs.writeFileSync(path.join(directory, `${id}.request.json`), bytes, { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ event: 'captured', id, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), model: body.model,
        messages: body.messages?.length, tools: body.tools?.length,
        messageChars: body.messages?.reduce((n, m) => n + JSON.stringify(m.content).length, 0) }));
    } catch { console.log(JSON.stringify({ event: 'capture-invalid-json' })); }
  });
  const headers = { ...req.headers, host: '127.0.0.1:11435' };
  const upstream = http.request(target, { method: req.method, headers }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
  req.pipe(upstream);
});
server.listen(11434, '127.0.0.1', () => console.log(JSON.stringify({ event: 'ready', port: 11434, upstreamPort: 11435 })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit()));
