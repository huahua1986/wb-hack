import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validatePublicUrl } from '../auth-gateway/src/config.mjs';

export const KIND = 'workbuddy-enterprise-client';
export const LABEL = 'local.workbuddy.enterprise-client.login';
export const VERSION = '0.1.1';
export const CLIENT_MODULES = ['desktop-launcher', 'double-click-launcher', 'runtime-branding', 'client-profile', 'compatibility', 'config', 'client-ip', 'connector-catalog', 'package-archive'];

export function regular(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('客户端文件不是普通文件。');
  return stat;
}
export function digest(filename) {
  regular(filename);
  const hash = createHash('sha256'), fd = fs.openSync(filename, 'r'), buffer = Buffer.alloc(4 * 1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
export function json(filename) {
  regular(filename);
  const bytes = fs.readFileSync(filename, 'utf8');
  try { return JSON.parse(bytes); } catch { throw new Error('客户端配置文件格式无效，请联系管理员。'); }
}
export function atomicJson(filename, value) {
  try { regular(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, filename); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function privateDirectory(directory) {
  const absolute = path.resolve(directory);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && (!fs.lstatSync(cursor).isDirectory() || fs.lstatSync(cursor).isSymbolicLink())) throw new Error('客户端目录含链接或冲突文件，请联系管理员。');
  }
  fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  fs.chmodSync(absolute, 0o700);
}
export function clientPaths(home = os.homedir()) {
  const base = path.join(home, 'Library', 'Application Support', 'EnterpriseWorkbenchClient');
  return { base, program: path.join(base, 'program'), state: path.join(base, 'state'),
    agent: path.join(home, 'Library', 'LaunchAgents', LABEL + '.plist') };
}
export function verifyPayload(root) {
  const manifest = json(path.join(root, 'release.json'));
  if (manifest.kind !== KIND || manifest.version !== VERSION || !manifest.files || Array.isArray(manifest.files) || !Array.isArray(manifest.compatibility)) throw new Error('客户端安装包标记无效。');
  const allowed = new Set(['runtime/node', 'runtime/LICENSE', 'native/ClientActions', 'client-config.json',
    ...['lib', 'bootstrap', 'install', 'uninstall', 'setup', 'supervisor'].map(n => 'client-distribution/' + n + '.mjs'),
    ...CLIENT_MODULES.map(n => 'auth-gateway/src/' + n + '.mjs')]);
  if (manifest.caFile) {
    if (manifest.caFile !== 'certs/enterprise-ca.pem') throw new Error('交付 CA 路径无效。');
    allowed.add(manifest.caFile);
  }
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (!allowed.has(name)) throw new Error('交付包包含非客户端文件。');
    if (!/^[A-Za-z0-9_.\/-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..') || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('客户端清单路径或校验值无效。');
    let cursor = root;
    for (const part of name.split('/')) { cursor = path.join(cursor, part); if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('客户端安装包包含链接。'); }
    if (digest(path.join(root, name)) !== hash) throw new Error('客户端安装包校验失败，请重新获取安装包。');
  }
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name), name = path.relative(root, filename);
      if (entry.isSymbolicLink()) throw new Error('客户端安装包包含链接。');
      if (entry.isDirectory()) walk(filename);
      else if (name !== 'release.json' && !manifest.files[name]) throw new Error('客户端安装包包含未列入清单的文件。');
    }
  };
  walk(root);
  for (const required of allowed) {
    if (!manifest.files[required]) throw new Error('客户端安装包缺少必要文件。');
  }
  return manifest;
}
export function verifyWorkBuddy(app, compatibility, readVersion = filename => execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', filename], { encoding: 'utf8' }).trim()) {
  const info = path.join(app, 'Contents', 'Info.plist');
  if (!fs.existsSync(info)) throw new Error('未找到原版 WorkBuddy，请先安装管理员指定的官方版本。');
  let version;
  try { version = readVersion(info); } catch { throw new Error('无法确认 WorkBuddy 版本，请联系管理员。'); }
  const supported = compatibility.find(item => item.version === version);
  if (!supported) throw new Error('当前 WorkBuddy 版本尚未通过企业配置验证，请联系管理员。');
  const required = ['Contents/Resources/app.asar', 'Contents/MacOS/Electron', 'Contents/Resources/app.asar.unpacked/cli/product.json'];
  for (const name of required) if (!supported.files?.[name] || digest(path.join(app, name)) !== supported.files[name]) throw new Error('WorkBuddy 安装版本与已验证版本不一致，请联系管理员。');
  return version;
}
export function validateModelPreset(value) {
  if (!value || !Array.isArray(value.models) || !Array.isArray(value.availableModels)) throw new Error('模型预置格式无效。');
  for (const model of value.models) {
    if (typeof model.id !== 'string' || !model.id.trim()) throw new Error('模型 ID 无效。');
    validatePublicUrl(new URL(model.url).origin);
    const key = model.apiKey;
    if (key && !(typeof key === 'string' && key.startsWith('$' + '{') && /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(key))) throw new Error('安装包不允许包含模型 API Key，请使用环境占位符或在客户端配置。');
    const url = new URL(model.url);
    if (url.username || url.password || url.search || url.hash) throw new Error('模型地址不允许包含凭据或查询参数。');
  }
  return value;
}
const escapeXml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
export function launchAgent(root, ca = '') {
  const argumentsXml = [path.join(root, 'runtime/node'), path.join(root, 'client-distribution/supervisor.mjs'), '--payload', root].map(a => '<string>' + escapeXml(a) + '</string>').join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>' + LABEL + '</string><key>ProgramArguments</key><array>' + argumentsXml + '</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>30</integer><key>ProcessType</key><string>Interactive</string>' +
    (ca ? '<key>EnvironmentVariables</key><dict><key>NODE_EXTRA_CA_CERTS</key><string>' + escapeXml(path.join(root, ca)) + '</string></dict>' : '') + '</dict></plist>\n';
}
export function initializeState(root, { home = os.homedir(), gateway, migrateFrom } = {}) {
  const manifest = verifyPayload(root), template = json(path.join(root, 'client-config.json')), paths = clientPaths(home);
  privateDirectory(paths.state);
  const marker = path.join(paths.state, 'managed.json');
  if (fs.existsSync(marker)) { if (json(marker).kind !== KIND) throw new Error('客户端数据目录不属于此安装程序。'); }
  else {
    if (fs.readdirSync(paths.state).length) throw new Error('客户端数据目录已有其他文件，已保留。');
    atomicJson(marker, { kind: KIND, version: 1 });
  }
  const filename = path.join(paths.state, 'workbuddy-launcher.json');
  const previous = fs.existsSync(filename) ? json(filename) : null;
  const chosen = gateway || previous?.gateway || template.gateway;
  if (!chosen) return { ...paths, needsGateway: true };
  const settings = { gateway: validatePublicUrl(chosen), appPath: template.appPath || '/Applications/WorkBuddy.app',
    productName: template.productName || '企业AI工作台', welcomeTitle: template.welcomeTitle || '企业AI工作台，我帮你', mode: 'development',
    reuseDevelopmentAuth: false, replaceProductionLogin: false, caCertificate: template.caFile ? path.join(root, template.caFile) : '' };
  if (settings.caCertificate && !manifest.files[template.caFile]) throw new Error('CA 文件未包含在交付清单中。');
  if (migrateFrom) {
    const source = path.join(path.resolve(migrateFrom), 'auth-gateway/client-profiles/double-click');
    const target = path.join(paths.state, 'auth-gateway/client-profiles/double-click');
    const owner = json(path.join(source, 'managed.json')), last = json(path.join(source, 'last-launch.json'));
    if (owner.kind !== 'workbuddy-double-click-profile' || last.gateway !== settings.gateway || last.mode !== settings.mode || last.executable !== path.join(settings.appPath, 'Contents/MacOS/Electron')) throw new Error('旧配置所有权或认证入口不匹配，未迁移。');
    if (fs.existsSync(target)) throw new Error('新的客户端已有配置，拒绝覆盖迁移。');
    privateDirectory(path.dirname(target));
    const staged = target + '.migrating.' + randomUUID();
    try {
      fs.cpSync(source, staged, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true });
      fs.renameSync(staged, target);
    } finally { if (fs.existsSync(staged)) fs.rmSync(staged, { recursive: true, force: true }); }
    atomicJson(path.join(paths.state, 'migration.json'), { source, completedAt: new Date().toISOString() });
  }
  atomicJson(filename, settings);
  return { ...paths, filename, settings, needsGateway: false };
}
export function seedModels(profile, preset) {
  if (!preset) return;
  const filename = path.join(profile.configDir, 'models.json');
  if (!fs.existsSync(filename)) atomicJson(filename, validateModelPreset(preset));
}
