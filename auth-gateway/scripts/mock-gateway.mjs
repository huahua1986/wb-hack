import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from '../src/config.mjs';
import { createMockGateway } from '../src/mock-gateway.mjs';

process.umask(0o077);
const config = readConfig({ ...process.env, GATEWAY_HOST: '127.0.0.1', GATEWAY_DATA_DIR: process.env.WORKBUDDY_MOCK_DATA_DIR || './mock-data' });
const logDir = path.resolve('./mock-logs'); fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
const logFile = path.join(logDir, 'requests.jsonl');
const app = await createMockGateway(config, { logger: record => {
  // Route-only diagnostic output. No queries, passwords, token or request bodies.
  const line = JSON.stringify({ time: new Date().toISOString(), ...record });
  fs.appendFileSync(logFile, `${line}\n`, { mode: 0o600 }); console.log(line);
} });
app.server.on('error', error => { console.error(`Mock 网关无法监听（${error.code || '服务错误'}）`); process.exitCode = 1; });
app.server.listen(config.port, '127.0.0.1', () => console.log(`Mock gateway ready: ${config.publicUrl} — local testing only`));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
