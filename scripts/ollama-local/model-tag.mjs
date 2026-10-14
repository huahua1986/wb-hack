import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const action = process.argv[2];
if (!['apply', 'rollback', 'status'].includes(action)) throw new Error('Use apply, rollback or status');
const own = JSON.parse(fs.readFileSync('evidence/ollama-local/model-tags.json', 'utf8'));
const origin = 'http://127.0.0.1:11434';
const response = await fetch(origin + '/api/tags');
if (!response.ok) throw new Error('Local Ollama is unavailable');
const data = await response.json();
const digest = name => data.models.find(model => model.name === name)?.digest;
for (const name of [own.backup, own.tuned]) {
  if (digest(name) !== own.digests[name]) throw new Error(`Model changed externally: ${name}`);
}
if (![own.digests[own.backup], own.digests[own.tuned]].includes(digest(own.target))) {
  throw new Error('Active model changed externally; preserving it');
}
if (action === 'status') console.log(JSON.stringify({ model: own.target,
  state: digest(own.target) === own.digests[own.tuned] ? 'tuned-original-q8' : 'original-q8' }));
else {
  const executable = JSON.parse(fs.readFileSync('evidence/ollama-local/before.json', 'utf8')).ollamaExecutable;
  const source = action === 'apply' ? own.tuned : own.backup;
  execFileSync(executable, ['cp', source, own.target], { env: { ...process.env,
    OLLAMA_HOST: '127.0.0.1:11434' }, stdio: ['ignore', 'ignore', 'pipe'] });
  console.log(JSON.stringify({ action, source, target: own.target, weights: 'original Q8' }));
}
