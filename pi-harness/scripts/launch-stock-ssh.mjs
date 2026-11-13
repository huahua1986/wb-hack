import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { installRuntimeBranding, parseInspectorEndpoint } from '../../auth-gateway/src/runtime-branding.mjs';
import { verifyPiRuntime } from '../../auth-gateway/src/runtime-pi.mjs';
import { workbuddyProcessIds } from '../../auth-gateway/src/double-click-launcher.mjs';
import { readPiConfig } from '../src/config.mjs';

const [appPath, configFile] = process.argv.slice(2).map(value => path.resolve(value));
if (!appPath || !configFile || process.argv.length !== 4) {
  throw Error('Usage: node launch-stock-ssh.mjs <WorkBuddy.app> <pi-config.json>');
}

const appAsarPath = path.join(appPath, 'Contents/Resources/app.asar');
const executable = path.join(appPath, 'Contents/MacOS/Electron');
const config = readPiConfig(configFile);
if (!config.ssh && !config.https) throw Error('This launcher requires a remote Pi profile.');
const stock = verifyPiRuntime(appAsarPath, { transport: config.https ? 'https' : 'ssh' });
if (config.sshOffice && stock.version !== '5.11.3') throw Error('Stock SSH Office requires the verified WorkBuddy 5.11.3 build.');
if (workbuddyProcessIds(executable).length) throw Error('This WorkBuddy executable is already running.');

const env = { ...process.env };
for (const name of ['WORKBUDDY_DEV_ENDPOINT_OVERRIDE', 'WORKBUDDY_CONFIG_DIR', 'WORKBUDDY_USER_DATA_DIR',
  'CODEBUDDY_CONFIG_DIR', 'CODEBUDDY_REMOTE_CONFIG_DISABLED', 'WORKBUDDY_CONNECTOR_MARKET_API',
  'ACC_PRODUCT_CONFIG', 'ACC_PRODUCT_CONFIG_V2', 'ACC_PRODUCT_CONFIG_V3', 'ACC_PRODUCT_CONFIG_V3_FILE',
  'ACC_PRODUCT_CONFIG_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'VITE_DEV_SERVER_URL', 'NODE_OPTIONS']) {
  delete env[name];
}
env.NODE_ENV = 'production';
const logDir = fs.mkdtempSync(path.join(config.stateDir, '.launch-'));
const log = path.join(logDir, 'inspector.log');
const descriptor = fs.openSync(log, 'wx+', 0o600);
let child;
try {
  child = spawn(executable, ['--inspect-brk=127.0.0.1:0'], {
    env, stdio: ['ignore', 'ignore', descriptor], detached: true, shell: false,
  });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const deadline = Date.now() + 15000;
  let endpoint;
  const bytes = Buffer.alloc(16384);
  while (!endpoint && Date.now() < deadline) {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) throw Error('WorkBuddy exited before the startup hook.');
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    endpoint = parseInspectorEndpoint(bytes.toString('utf8', 0, count));
    if (!endpoint) await delay(50);
  }
  if (!endpoint) throw Error('WorkBuddy did not open its local startup Inspector.');
  const result = await installRuntimeBranding(endpoint, {
    appAsarPath, piHarness: { enabled: true, configFile }, stockOffice: Boolean(config.sshOffice),
  });
  if (!result.inspectorClosed) throw Error('WorkBuddy Inspector did not close.');
  child.unref();
  console.log(JSON.stringify({ pid: child.pid, inspectorClosed: true, appPath }));
} catch (error) {
  child?.kill('SIGTERM');
  throw error;
} finally {
  fs.closeSync(descriptor);
  fs.rmSync(logDir, { recursive: true, force: true });
}
