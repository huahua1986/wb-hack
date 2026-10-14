import { readConfig } from './config.mjs';
import { createGateway } from './gateway.mjs';
import { acquireServerLock } from './server-lock.mjs';

process.umask(0o077);
const config = readConfig();
const release = acquireServerLock(config.dataDir);
let gateway;
try { gateway = await createGateway(config, { logger: record => process.stdout.write(JSON.stringify(record) + '\n') }); }
catch (error) { release(); console.error(error.message); process.exit(1); }
gateway.server.on('error', error => {
  console.error(`Gateway could not listen (${error.code || 'server error'})`); process.exitCode = 1;
  stop().catch(() => process.exit(1));
});
gateway.server.listen(config.port, config.host, () => {
  console.log(`WorkBuddy local authentication gateway: ${config.publicUrl}`);
});
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10000); deadline.unref();
  await gateway.close(); release(); clearTimeout(deadline);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
