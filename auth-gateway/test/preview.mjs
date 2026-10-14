import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../src/gateway.mjs';

process.umask(0o077);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-login-preview-'));
const config = { dataDir, publicUrl: 'http://127.0.0.1:8791', accessTtlSeconds: 3600, refreshTtlSeconds: 86400, loginTtlSeconds: 300 };
const gateway = await createGateway(config);
await new Promise((resolve, reject) => { gateway.server.once('error', reject); gateway.server.listen(8791, '127.0.0.1', resolve); });
const state = gateway.store.createLoginState();
// Empty temporary user directory: this URL previews a form only and cannot
// authorize an existing user or modify any installed WorkBuddy state.
console.log(`Preview: ${config.publicUrl}/login?state=${state}`);
let closed = false;
async function close() {
  if (closed) return; closed = true;
  await gateway.close(); fs.rmSync(dataDir, { recursive: true, force: true });
}
process.on('SIGTERM', close); process.on('SIGINT', close);
const timer = setTimeout(close, 300000); timer.unref();
