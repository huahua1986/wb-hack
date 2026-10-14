import fs from 'node:fs';
import { createHash } from 'node:crypto';

const model = process.argv[2];
const files = process.argv.slice(3);
if (!model || files.length !== 2) throw new Error('Use MODEL REQUEST_ONE REQUEST_TWO');
const origin = process.env.OLLAMA_TEST_ORIGIN || 'http://127.0.0.1:11434';
const url = new URL(origin);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Local server required');
const prompts = [];
for (const filename of files) {
  const body = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const messages = body.messages.map(message => ({ ...message,
    content: typeof message.content === 'string' ? message.content : message.content.map(part => {
      if (part.type !== 'text') throw new Error('This priming experiment requires text-only inputs');
      return part.text;
    }).join('') }));
  const response = await fetch(new URL('/api/chat', url), { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model,
      messages, tools: body.tools, stream: false, _debug_render_only: true }) });
  const result = await response.json();
  if (!response.ok || !result._debug_info?.rendered_template) throw new Error('Native prompt rendering failed');
  prompts.push(result._debug_info.rendered_template);
}
let common = 0;
while (common < Math.min(...prompts.map(x => x.length)) && prompts[0][common] === prompts[1][common]) common++;
// Stop at the preceding line, never cut a special-token marker or surrogate pair.
const boundary = prompts[0].lastIndexOf('\n', common);
if (boundary < 1000) throw new Error('Insufficient stable prefix');
const prefix = prompts[0].slice(0, boundary + 1);
fs.writeFileSync('evidence/ollama-local/private/stable-prefix.txt', prefix, { mode: 0o600, flag: 'wx' });
for (let i = 0; i < prompts.length; i++) fs.writeFileSync(`evidence/ollama-local/private/rendered-${i + 1}.txt`, prompts[i], { mode: 0o600, flag: 'wx' });
fs.writeFileSync('evidence/ollama-local/prefix.json', JSON.stringify({ model, commonChars: common,
  prefixChars: prefix.length, sha256: createHash('sha256').update(prefix).digest('hex'),
  renderedChars: prompts.map(x => x.length), coldPrimingCostMustBeReported: true }, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ commonChars: common, prefixChars: prefix.length, renderedChars: prompts.map(x => x.length) }));
