'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { app, webContents, BrowserWindow, Menu } = require('electron');

const resources = path.dirname(app.getAppPath());
require(path.join(resources, 'pi-harness', 'src', 'branding.cjs')).installBranding({ app, webContents, BrowserWindow, Menu, appAsarPath: app.getAppPath() });
const home = path.join(app.getPath('appData'), 'WorkBuddy-Pi-5.9.1');
const configDir = path.join(home, 'config');
const userDataDir = path.join(home, 'user-data');
const piHome = path.join(home, 'pi');
const agentDir = path.join(piHome, 'agent');
const bridgeDir = path.join(piHome, 'bridge');
// Runtime tools are private to this application; no system PATH or global Pi install changes.
process.env.PATH = [path.join(resources, 'PiEngine', 'tools'), path.join(resources, 'PiEngine', 'runtime'), process.env.PATH].filter(Boolean).join(path.delimiter);
for (const dir of [home, configDir, userDataDir, piHome, agentDir, path.join(piHome, 'state'), path.join(piHome, 'workspace'), bridgeDir]) {
  const s = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (s && (!s.isDirectory() || s.isSymbolicLink())) throw Error('Pi build data directory is not an ordinary directory');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}
app.setPath('userData', userDataDir);
for (const key of ['WORKBUDDY_DEV_ENDPOINT_OVERRIDE', 'CODEBUDDY_REMOTE_CONFIG_DISABLED', 'WORKBUDDY_CONNECTOR_MARKET_API', 'CODEBUDDY_CODE_PATH', 'CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_API_KEY', 'CODEBUDDY_BASE_URL', 'ACC_PRODUCT_CONFIG', 'ACC_PRODUCT_CONFIG_V2', 'ACC_PRODUCT_CONFIG_V3', 'ACC_PRODUCT_CONFIG_V3_FILE', 'ACC_PRODUCT_CONFIG_PATH', 'ELECTRON_RENDERER_URL', 'VITE_DEV_SERVER_URL', 'NODE_OPTIONS']) delete process.env[key];
Object.assign(process.env, { NODE_ENV: 'production', WORKBUDDY_CONFIG_DIR: configDir, CODEBUDDY_CONFIG_DIR: configDir, WORKBUDDY_USER_DATA_DIR: userDataDir, WORKBUDDY_RESOURCES_PATH: resources, WORKBUDDY_APP_VERSION: app.getVersion(), WORKBUDDY_CLI_PREWARM_POOL_SIZE: '0', WORKBUDDY_PI_OFFICIAL_BUILD: '1', WORKBUDDY_PI_MODEL_BRIDGE_DIR: bridgeDir });
process.env.WORKBUDDY_PI_OFFICE_SECRET = randomBytes(32).toString('hex');

function read(filename) {
  const s = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!s) return undefined;
  if (!s.isFile() || s.isSymbolicLink() || s.size > 1048576) throw Error('Pi build configuration must be an ordinary bounded file');
  const bytes = fs.readFileSync(filename);
  const data = JSON.parse(bytes.toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Pi build configuration must be a JSON object');
  return { bytes, data };
}
function atomic(filename, value) {
  const temp = filename + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, filename); }
  finally { try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
const settingsFile = path.join(piHome, 'pi-config.json');
const modelFile = path.join(agentDir, 'models.json');
const piSettings = path.join(agentDir, 'settings.json');
const entries = new Map([settingsFile, modelFile, piSettings].map(filename => [filename, read(filename)]));
const previous = entries.get(settingsFile)?.data || {};
if (previous.approvalMode !== undefined && !['manual', 'auto'].includes(previous.approvalMode)) throw Error('Invalid Pi approvalMode');
const selectedModel = previous.officialOnly === true && previous.provider === 'workbuddy-official' && typeof previous.model === 'string' && previous.model.trim() && previous.model.length <= 256 && !/[\x00-\x1f]/.test(previous.model)
  ? previous.model.trim() : 'hy4';
const allowedTools = new Set(['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls']);
const tools = Array.isArray(previous.tools) && previous.tools.length && previous.tools.every(tool => allowedTools.has(tool))
  ? [...new Set(previous.tools)] : [...allowedTools];
const config = {
  cwd: typeof previous.cwd === 'string' && path.isAbsolute(previous.cwd) && !/[\x00-\x1f]/.test(previous.cwd) ? previous.cwd : path.join(piHome, 'workspace'),
  workspaceRoot: typeof previous.workspaceRoot === 'string' && path.isAbsolute(previous.workspaceRoot) && !/[\x00-\x1f]/.test(previous.workspaceRoot) ? previous.workspaceRoot : path.join(app.getPath('home'), 'WorkBuddy'),
  approvalMode: previous.approvalMode ?? 'auto',
  stateDir: path.join(piHome, 'state'), agentDir, provider: 'workbuddy-official', model: selectedModel,
  modelName: `Pi · ${selectedModel} (WorkBuddy 官方)`, tools, officialOnly: true, officialBridgeDir: bridgeDir,
  command: path.join(resources, 'PiEngine', 'runtime', 'node'), args: [path.join(resources, 'PiEngine', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js')],
};
const target = new Map([
  [settingsFile, config],
  [modelFile, { providers: {} }],
  [piSettings, { defaultProvider: 'workbuddy-official', defaultModel: selectedModel, defaultThinkingLevel: 'off', quietStartup: true }],
]);
const changed = [...target].filter(([filename, value]) => entries.get(filename)?.bytes.toString('utf8') !== JSON.stringify(value, null, 2) + '\n');
if (changed.some(([filename]) => entries.get(filename))) {
  const backups = path.join(piHome, 'migration-backups');
  const existing = fs.lstatSync(backups, { throwIfNoEntry: false });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw Error('Pi migration backup directory is not ordinary');
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 }); fs.chmodSync(backups, 0o700);
  const backup = path.join(backups, 'configuration-0.4.2-' + Date.now() + '-' + require('node:crypto').randomUUID());
  fs.mkdirSync(backup, { mode: 0o700 });
  // Preserve exact private bytes before changing any file. Backups remain outside the application bundle.
  for (const [filename, entry] of entries) if (entry) fs.writeFileSync(path.join(backup, path.basename(filename)), entry.bytes, { mode: 0o600, flag: 'wx' });
}
for (const [filename, value] of changed) atomic(filename, value);
require(path.join(resources, 'pi-harness', 'src', 'electron-runtime.cjs')).install({ appAsarPath: app.getAppPath(), configFile: settingsFile, exclusive: true, nativeUi: true });
require('./index.js');
