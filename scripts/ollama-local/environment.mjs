import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const [action] = process.argv.slice(2);
if (!['apply', 'rollback', 'status'].includes(action)) throw new Error('Use apply, rollback or status');
const filename = 'evidence/ollama-local/before.json';
const backup = JSON.parse(fs.readFileSync(filename, 'utf8'));
const target = { OLLAMA_CONTEXT_LENGTH: '65536', OLLAMA_NUM_PARALLEL: '1',
  OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'f16', OLLAMA_KEEP_ALIVE: '30m' };
const current = key => {
  try { return execFileSync('/bin/launchctl', ['getenv', key], { encoding: 'utf8' }).trim() || null; }
  catch { return null; }
};
if (action === 'status') {
  console.log(JSON.stringify(Object.fromEntries(Object.keys(target).map(key => [key, current(key)])), null, 2));
} else {
  // Refuse to overwrite a later user change. Check every variable before changing any.
  for (const [key, value] of Object.entries(target)) {
    const now = current(key);
    if (now !== (backup.environment[key] ?? null) && now !== value) throw new Error(`Changed externally: ${key}`);
  }
  for (const [key, value] of Object.entries(target)) {
    const next = action === 'apply' ? value : backup.environment[key];
    execFileSync('/bin/launchctl', next === null || next === undefined ? ['unsetenv', key] : ['setenv', key, next]);
  }
  console.log(JSON.stringify({ action, applied: Object.keys(target), restartOllamaRequired: true }));
}
