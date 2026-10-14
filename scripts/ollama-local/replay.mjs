import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import http from 'node:http';

const [label, model, ...files] = process.argv.slice(2);
if (!label || !model || !files.length || !/^[a-z0-9_-]+$/i.test(label)) {
  throw new Error('Usage: replay.mjs LABEL MODEL REQUEST_FILE [REQUEST_FILE]');
}
const origin = new URL(process.env.OLLAMA_TEST_ORIGIN || 'http://127.0.0.1:11434');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.protocol !== 'http:') {
  throw new Error('Replay is restricted to a local Ollama server');
}
const offsetMs = Number(process.env.OLLAMA_TEST_OFFSET_MS || 50000);
if (!Number.isFinite(offsetMs) || offsetMs < 0 || offsetMs > 60000) throw new Error('Invalid offset');
const directory = path.resolve('evidence/ollama-local');
const privateDir = path.join(directory, 'private');
const results = [];

async function run(file, index) {
  const raw = fs.readFileSync(file);
  const original = JSON.parse(raw);
  const body = { ...original, model };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = { index, file: path.basename(file), model, startedAt,
    sourceSha256: createHash('sha256').update(raw).digest('hex'),
    tools: body.tools?.length || 0, sourceMessages: body.messages?.length || 0 };
  let content = '', reasoning = '', pending = '';
  const progress = setInterval(() => console.log(JSON.stringify({ event: 'progress', label, index,
    elapsedMs: Math.round(performance.now() - started), firstChunkMs: result.firstChunkMs })), 30000);
  try {
    // Node fetch's separate five-minute headers timeout can expire during prefill.
    const response = await new Promise((resolve, reject) => {
      const request = http.request(new URL('/v1/chat/completions', origin), { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(1200000) },
      incoming => resolve({ status: incoming.statusCode,
        ok: incoming.statusCode >= 200 && incoming.statusCode < 300, body: incoming }));
      request.setTimeout(1200000, () => request.destroy(new Error('Local model request timed out')));
      request.on('error', reject);
      request.end(JSON.stringify(body));
    });
    result.status = response.status;
    if (!response.ok) throw new Error('Local model HTTP ' + response.status);
    const consume = line => {
      if (!line.startsWith('data:')) return;
      const text = line.slice(5).trim();
      if (!text || text === '[DONE]') return;
      const data = JSON.parse(text);
      result.firstChunkMs ??= Math.round(performance.now() - started);
      const delta = data.choices?.[0]?.delta;
      const thought = delta?.reasoning_content || delta?.reasoning || '';
      if (thought) { result.firstReasoningMs ??= Math.round(performance.now() - started); reasoning += thought; }
      if (delta?.content) { result.firstTextMs ??= Math.round(performance.now() - started); content += delta.content; }
      if (data.usage) result.usage = data.usage;
      if (data.timings) result.timings = data.timings;
      if (data.choices?.[0]?.finish_reason) result.finishReason = data.choices[0].finish_reason;
    };
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) consume(line);
    }
    if (pending) consume(pending);
    result.totalMs = Math.round(performance.now() - started);
    result.contentChars = content.length;
    result.reasoningChars = reasoning.length;
    fs.writeFileSync(path.join(privateDir, `${label}-${index}.response.json`),
      JSON.stringify({ content, reasoning }, null, 2), { mode: 0o600, flag: 'wx' });
  } catch (error) { result.error = error.message; result.totalMs = Math.round(performance.now() - started); }
  finally {
    clearInterval(progress);
    results.push(result);
    console.log(JSON.stringify({ event: 'done', label, ...result }));
  }
}

const requests = files.map((file, index) => new Promise(resolve => setTimeout(resolve, index * offsetMs)).then(() => run(file, index + 1)));
await Promise.all(requests);
results.sort((a, b) => a.index - b.index);
fs.writeFileSync(path.join(directory, `${label}.json`), JSON.stringify({ offsetMs, results }, null, 2), { mode: 0o600, flag: 'wx' });
if (results.some(result => result.error)) process.exitCode = 1;
