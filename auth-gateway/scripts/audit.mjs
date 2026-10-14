import { parseArgs } from 'node:util';
import { AuthStore } from '../src/store.mjs';
import { readConfig } from '../src/config.mjs';

process.umask(0o077);
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'data-dir': { type: 'string' }, limit: { type: 'string', default: '100' }, username: { type: 'string' } } });
  if (positionals.length) throw new Error('Usage: audit [--limit 1-1000] [--username <name>] [--data-dir <path>]');
  const config = readConfig({ ...process.env, ...(values['data-dir'] ? { GATEWAY_DATA_DIR: values['data-dir'] } : {}) });
  const store = new AuthStore(config);
  try { for (const row of store.listAudit({ limit: Number(values.limit), username: values.username })) console.log(JSON.stringify(row)); }
  finally { store.close(); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
