import { parseArgs } from 'node:util';
import { AuthStore } from '../src/store.mjs';
import { readConfig } from '../src/config.mjs';
import { adminContext } from '../src/admin-context.mjs';

process.umask(0o077);
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { 'data-dir': { type: 'string' }, all: { type: 'boolean' }, id: { type: 'string' } } });
  const [command, username] = positionals;
  if (!['list', 'revoke'].includes(command) || positionals.length !== 2 || (command === 'list' && values.id !== undefined)
    || (command === 'revoke' && Boolean(values.all) === (values.id !== undefined))) throw new Error('Usage: session list <username> [--all], or session revoke <username> --id <session-id>|--all [--data-dir <path>]');
  const config = readConfig({ ...process.env, ...(values['data-dir'] ? { GATEWAY_DATA_DIR: values['data-dir'] } : {}) });
  const store = new AuthStore(config);
  try {
    if (command === 'list') for (const row of store.listSessions(username, { includeInactive: !!values.all })) console.log(JSON.stringify(row));
    else console.log(JSON.stringify({ revoked: store.revokeUserSessions(username, { sessionId: values.id, ...adminContext() }) }));
  } finally { store.close(); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
