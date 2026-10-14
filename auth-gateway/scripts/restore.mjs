import { parseArgs } from 'node:util';
import { readConfig } from '../src/config.mjs';
import { restoreBackup } from '../src/backup.mjs';
import { adminContext } from '../src/admin-context.mjs';

process.umask(0o077);
try {
  const { values, positionals } = parseArgs({ options: { 'confirm-restore': { type: 'boolean' } }, allowPositionals: true });
  if (positionals.length !== 1 || !values['confirm-restore']) throw new Error('Usage: restore <backup-directory> --confirm-restore (server must be stopped; all sessions will be invalidated)');
  console.log(JSON.stringify(restoreBackup(readConfig(), positionals[0], adminContext())));
} catch (error) { console.error(error.message); process.exitCode = 1; }
