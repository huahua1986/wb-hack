import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { readConfig } from '../src/config.mjs';
import { createBackup } from '../src/backup.mjs';

process.umask(0o077);
try {
  const { values, positionals } = parseArgs({ options: { output: { type: 'string' } }, allowPositionals: true });
  if (positionals.length) throw new Error('Usage: backup [--output <new-directory>]');
  const config = readConfig();
  const output = values.output || path.join(config.dataDir + '-backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  console.log(JSON.stringify(await createBackup(config, output)));
} catch (error) { console.error(error.message); process.exitCode = 1; }
