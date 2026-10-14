import fs from 'node:fs';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readLauncherSettings } from '../../auth-gateway/src/double-click-launcher.mjs';

const [label, model] = process.argv.slice(2);
if (!label || !model || !/^[a-z0-9_-]+$/i.test(label)) throw new Error('Use LABEL MODEL');
const origin = new URL(process.env.OLLAMA_TEST_ORIGIN || 'http://127.0.0.1:11434');
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)) throw new Error('Local server required');
const prompt = fs.readFileSync('evidence/ollama-local/private/stable-prefix.txt', 'utf8');
const prefix = JSON.parse(fs.readFileSync('evidence/ollama-local/prefix.json', 'utf8'));
if (createHash('sha256').update(prompt).digest('hex') !== prefix.sha256) throw new Error('Stable prefix changed');
const before = JSON.parse(fs.readFileSync('evidence/ollama-local/before.json', 'utf8'));
const launcher = readLauncherSettings(path.resolve('workbuddy-launcher.json'));
const packageBytes = fs.readFileSync(path.join(launcher.appPath, 'Contents', 'Resources', 'app.asar'));
if (createHash('sha256').update(packageBytes).digest('hex') !== before.workbuddyPackageSha256) {
  throw new Error('WorkBuddy version changed; recapture the shared prefix first');
}
const start = performance.now();
const timer = setInterval(() => console.log(JSON.stringify({ event: 'priming', label,
  elapsedMs: Math.round(performance.now() - start) })), 30000);
try {
  const result = await new Promise((resolve, reject) => {
    const request = http.request(new URL('/api/generate', origin), { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(1200000) }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new Error('Primer HTTP ' + response.statusCode)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks))); } catch { reject(new Error('Invalid primer response')); }
      });
    });
    request.setTimeout(1200000, () => request.destroy(new Error('Primer timed out')));
    request.on('error', reject);
    request.end(JSON.stringify({ model, prompt, raw: true, stream: false, keep_alive: '30m',
      // A zero n_predict is omitted by this Ollama version, restoring unlimited
      // generation. One discarded token keeps checkpoint priming bounded.
      options: { num_ctx: 65536, num_predict: 1 } }));
  });
  const summary = { model, wallMs: Math.round(performance.now() - start),
    prefixSha256: createHash('sha256').update(prompt).digest('hex'),
    totalDuration: result.total_duration, loadDuration: result.load_duration,
    promptEvalCount: result.prompt_eval_count, promptEvalDuration: result.prompt_eval_duration,
    evalCount: result.eval_count, evalDuration: result.eval_duration, done: result.done };
  fs.writeFileSync(`evidence/ollama-local/${label}.json`, JSON.stringify(summary, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ event: 'primed', ...summary }));
} finally { clearInterval(timer); }
