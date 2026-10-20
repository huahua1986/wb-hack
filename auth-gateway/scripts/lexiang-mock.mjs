import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createGateway } from '../src/gateway.mjs';
import { readConfig } from '../src/config.mjs';
import { hashPassword, randomSecret } from '../src/credentials.mjs';
import { acquireServerLock } from '../src/server-lock.mjs';

process.umask(0o077);
const { values } = parseArgs({ options: { port: { type: 'string', default: '8791' }, 'data-dir': { type: 'string' } } });
const config = readConfig({ GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: values.port,
  GATEWAY_DATA_DIR: path.resolve(values['data-dir'] || './data/lexiang-mock'), GATEWAY_PRODUCT_NAME: '企业AI工作台' });
config.lexiang = { mode: 'mock' };
const release = acquireServerLock(config.dataDir);
let app;
try {
  app = await createGateway(config, { logger: item => fs.appendFileSync(path.join(config.dataDir, 'requests.log'), JSON.stringify(item) + '\n', { mode: 0o600 }) });
  if (!app.store.getUser('lexiang-demo')) {
    const password = randomSecret();
    app.store.addUser('lexiang-demo', '私有乐享测试账号', await hashPassword(password));
    fs.writeFileSync(path.join(config.dataDir, 'initial-credentials.json'), JSON.stringify({ username: 'lexiang-demo', password }) + '\n', { mode: 0o600, flag: 'wx' });
  }
} catch (error) { await app?.close(); release(); console.error(error.message); process.exit(1); }
app.server.once('error', async () => { console.error('乐享 Mock 无法监听指定端口。'); await app.close(); release(); process.exitCode = 1; });
app.server.listen(config.port, config.host, () => console.log(JSON.stringify({ service: 'lexiang-local-mock', origin: config.publicUrl, username: 'lexiang-demo', credentialsFile: path.join(config.dataDir, 'initial-credentials.json') })));
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await app.close(); release(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
