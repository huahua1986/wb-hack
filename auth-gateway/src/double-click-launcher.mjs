import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { buildClientProduct, clientEnvironment, prepareManagedConnectorSource, prepareClientCaBundle } from './client-profile.mjs';
import { validatePublicUrl } from './config.mjs';
import { installRuntimeBranding, parseInspectorEndpoint } from './runtime-branding.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const MANAGED = 'workbuddy-double-click-profile';

function readJson(filename, description) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new Error(`${description}无法读取或不是有效 JSON。`); }
}

function atomicJson(filename, value) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, filename);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function readLauncherSettings(filename, home = os.homedir()) {
  const data = readJson(filename, '启动配置');
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('启动配置必须是 JSON 对象。');
  if (typeof data.gateway !== 'string' || !data.gateway.trim()) throw new Error('请在 workbuddy-launcher.json 的 gateway 中填写网关地址。');
  let gateway;
  try { gateway = validatePublicUrl(data.gateway.trim()); }
  catch { throw new Error('gateway 应为不含路径、查询或密码的 HTTPS 地址；本机测试可用 http://127.0.0.1:8787。'); }
  if (typeof data.appPath !== 'string' || !data.appPath.trim()) throw new Error('请填写 appPath，例如 /Applications/WorkBuddy.app。');
  let appPath = data.appPath.trim();
  if (appPath.startsWith('~/')) appPath = path.join(home, appPath.slice(2));
  appPath = path.resolve(path.dirname(filename), appPath);
  const mode = data.mode ?? 'development';
  if (!['development', 'production'].includes(mode)) throw new Error('mode 只能是 development 或 production。');
  for (const key of ['reuseDevelopmentAuth', 'replaceProductionLogin']) {
    if (data[key] !== undefined && typeof data[key] !== 'boolean') throw new Error(`${key} 必须是 true 或 false。`);
  }
  if (data.nodeExecutable !== undefined && typeof data.nodeExecutable !== 'string') throw new Error('nodeExecutable 必须是路径字符串或空字符串。');
  if (data.productName !== undefined && (typeof data.productName !== 'string' || !data.productName.trim() || data.productName.length > 128 || /[\u0000-\u001f\u007f]/.test(data.productName))) throw new Error('productName 必须是非空且不超过 128 字符的单行产品名称。');
  const productName = data.productName?.trim();
  if (data.welcomeTitle !== undefined && (!productName || typeof data.welcomeTitle !== 'string' || !data.welcomeTitle.trim() || data.welcomeTitle.length > 256 || /[\u0000-\u001f\u007f]/.test(data.welcomeTitle))) throw new Error('welcomeTitle 需要 productName，并且必须是非空的单行文本。');
  const welcomeTitle = productName ? data.welcomeTitle?.trim() || `${productName}，我帮你` : undefined;
  let caCertificate;
  if (data.caCertificate !== undefined && typeof data.caCertificate !== 'string') throw new Error('caCertificate 必须是证书路径字符串或空字符串。');
  if (data.caCertificate?.trim()) {
    caCertificate = path.resolve(path.dirname(filename), data.caCertificate.trim());
    try {
      const stat = fs.lstatSync(caCertificate);
      if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid certificate file');
      const certificate = new X509Certificate(fs.readFileSync(caCertificate));
      if (!certificate.ca || Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) throw new Error('Invalid CA or validity');
    } catch { throw new Error('caCertificate 应指向有效且未过期的 PEM CA 证书文件。'); }
  }
  return { gateway, appPath, mode, caCertificate, productName, welcomeTitle, reuseDevelopmentAuth: data.reuseDevelopmentAuth === true, replaceProductionLogin: data.replaceProductionLogin === true };
}

export function sharedAuthFilename(mode, home = os.homedir(), platform = process.platform) {
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    : platform === 'win32' ? path.join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
      : path.join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  return path.join(base, `workbuddy-desktop${mode === 'development' ? '-dev' : ''}.info`);
}

export function workbuddyProcessIds(executable, query = execFileSync) {
  const escaped = executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return query('/usr/bin/pgrep', ['-f', `^${escaped}([[:space:]]|$)`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split(/\s+/).filter(value => /^\d+$/.test(value)).map(Number);
  } catch (error) {
    if (error.status === 1) return [];
    throw new Error('无法检查 WorkBuddy 是否已运行；请检查系统进程读取权限后重试。');
  }
}

export function processFingerprint(pid, query = execFileSync) {
  if (!Number.isInteger(pid) || pid < 1) return;
  try { return query('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } }).trim() || undefined; }
  catch { return; }
}

export function checkAuthNamespace(settings, previousOwner, authPath, executable) {
  if (settings.mode === 'production') {
    if (!settings.replaceProductionLogin) throw new Error('production 会使用原有共享登录文件。确认要替换时，将 replaceProductionLogin 设为 true；测试建议保留 development。');
    return;
  }
  const fileExists = fs.existsSync(authPath), markerExists = fs.existsSync(`${authPath}.logged-out`);
  if (!fileExists && !markerExists) return;
  if (settings.reuseDevelopmentAuth) return;
  const owned = previousOwner?.gateway === settings.gateway && previousOwner?.mode === settings.mode && previousOwner?.executable === executable;
  if (owned) {
    // Inspect only issuer/domain metadata, never log or copy credentials.
    if (!fileExists) return;
    try {
      const domain = JSON.parse(fs.readFileSync(authPath, 'utf8'))?.auth?.domain;
      const origin = new URL(settings.gateway);
      if (domain === origin.hostname || domain === origin.host) return;
    } catch { /* An unrecognized shared session must not be silently replaced. */ }
  }
  throw new Error('发现已有开发登录态，无法确认属于当前网关。确认可以复用或替换时，将 reuseDevelopmentAuth 设为 true；现有认证文件不会被脚本删除。');
}

export function prepareDoubleClickLaunch(configFilename, {
  home = os.homedir(), platform = process.platform, findProcesses = workbuddyProcessIds,
} = {}) {
  const settings = readLauncherSettings(configFilename, home);
  const executable = path.join(settings.appPath, 'Contents', 'MacOS', 'Electron');
  const productSource = path.join(settings.appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'product.json');
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) throw new Error('未找到 WorkBuddy 可执行文件，请检查 appPath。');
  const configRoot = fs.realpathSync(path.dirname(configFilename));
  const appRoot = fs.realpathSync(settings.appPath);
  if (configRoot === appRoot || configRoot.startsWith(`${appRoot}${path.sep}`)) throw new Error('请把启动器和配置放在 WorkBuddy.app 包之外，不能向安装包写入启动数据。');
  if (findProcesses(executable).length) throw new Error('WorkBuddy 或其后台进程仍在运行。请完整退出 WorkBuddy，等待后台进程退出后再次双击；脚本不会强制结束它们。');
  let productBytes, baseProduct;
  try { productBytes = fs.readFileSync(productSource); baseProduct = JSON.parse(productBytes.toString('utf8')); }
  catch { throw new Error('WorkBuddy 内置产品配置无法读取或不是有效 JSON。'); }
  if (!baseProduct || Array.isArray(baseProduct) || typeof baseProduct !== 'object') throw new Error('WorkBuddy 产品配置格式无效。');
  const directory = path.join(path.dirname(configFilename), 'auth-gateway', 'client-profiles', 'double-click');
  let ancestor = configRoot;
  for (const part of ['auth-gateway', 'client-profiles', 'double-click', 'config', 'user-data']) {
    // config and user-data are siblings, so inspect each at the profile root.
    if (part === 'config' || part === 'user-data') ancestor = directory;
    ancestor = path.join(ancestor, part);
    if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('启动器数据目录含符号链接，拒绝写入以保护现有文件。');
  }
  const managedPath = path.join(directory, 'managed.json');
  let previousOwner;
  if (fs.existsSync(directory) && fs.readdirSync(directory).length) {
    if (!fs.existsSync(managedPath)) throw new Error('启动器配置目录已有其他文件，拒绝覆盖；请先保管该目录。');
    const managed = readJson(managedPath, '启动器管理标记');
    if (managed.kind !== MANAGED || managed.version !== 1) throw new Error('启动器配置目录的管理标记不匹配，拒绝覆盖。');
    const ownerPath = path.join(directory, 'last-launch.json');
    if (fs.existsSync(ownerPath)) previousOwner = readJson(ownerPath, '上次启动记录');
  }
  const authPath = sharedAuthFilename(settings.mode, home, platform);
  checkAuthNamespace(settings, previousOwner, authPath, executable);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(managedPath)) atomicJson(managedPath, { kind: MANAGED, version: 1 });
  const productPath = path.join(directory, 'product.local.json');
  const profile = { version: 1, gateway: settings.gateway, mode: settings.mode, executable,
    ...(settings.caCertificate ? { caCertificate: settings.caCertificate } : {}),
    configDir: path.join(directory, 'config'), userDataDir: path.join(directory, 'user-data'), productPath };
  prepareManagedConnectorSource(profile);
  prepareClientCaBundle(profile);
  const product = buildClientProduct(baseProduct, settings.gateway);
  if (settings.productName) product.productName = settings.productName;
  atomicJson(productPath, product);
  atomicJson(path.join(directory, 'launch.json'), profile);
  fs.mkdirSync(profile.configDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(profile.userDataDir, { recursive: true, mode: 0o700 });
  if (settings.mode === 'development') {
    // Keep the development resolver consistent with the configured env override.
    // This file belongs to this launcher profile; local models.json is untouched.
    const devPath = path.join(profile.configDir, 'dev-env.json');
    const dev = fs.existsSync(devPath) ? readJson(devPath, '开发环境配置') : {};
    atomicJson(devPath, { ...dev, env: 'custom:double-click-gateway', customEnvs: [
      ...(Array.isArray(dev.customEnvs) ? dev.customEnvs.filter(item => item?.name !== 'double-click-gateway') : []),
      { name: 'double-click-gateway', endpoint: settings.gateway },
    ] });
  }
  return { profile, settings, authPath, directory,
    productSourceHash: createHash('sha256').update(productBytes).digest('hex'),
  };
}

export function spawnPreparedWorkBuddy(prepared, {
  parentEnvironment = process.env, spawnProcess = spawn, watchMs = 700,
  brandingInstaller = installRuntimeBranding, brandingTimeoutMs = 15000,
} = {}) {
  const env = clientEnvironment(prepared.profile, parentEnvironment);
  const branded = !!prepared.settings.productName;
  const inspectorLog = branded ? path.join(prepared.directory, `.branding-${randomUUID()}.tmp`) : undefined;
  return new Promise((resolve, reject) => {
    let child, descriptor;
    const clean = () => {
      if (!inspectorLog) return;
      try { fs.unlinkSync(inspectorLog); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
    try {
      if (branded) descriptor = fs.openSync(inspectorLog, 'wx', 0o600);
      child = spawnProcess(prepared.profile.executable, branded ? ['--inspect-brk=127.0.0.1:0'] : [], {
        env, stdio: branded ? ['ignore', 'ignore', descriptor] : 'ignore', detached: true, shell: false,
      });
    } catch { clean(); reject(new Error('无法创建 WorkBuddy 启动进程。')); return; }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    let timer, settled = false;
    const fail = error => {
      if (settled) return; settled = true; clearTimeout(timer);
      // This is only the newly created startup process, never an existing app.
      if (branded) { try { child.kill('SIGTERM'); } catch {} }
      try { clean(); } catch {}
      reject(error);
    };
    child.once('error', error => fail(new Error(`无法启动 WorkBuddy（${error.code || '进程错误'}）。`)));
    child.once('exit', (code, signal) => fail(new Error(`WorkBuddy 提前退出（${signal || code}）。请确认其他实例已退出，并检查程序能否正常打开。`)));
    child.once('spawn', () => {
      timer = setTimeout(async () => {
        if (settled) return;
        try {
          let runtimeBranding;
          if (branded) {
            const deadline = Date.now() + brandingTimeoutMs;
            let endpoint;
            while (!endpoint && !settled && Date.now() < deadline) {
              const fd = fs.openSync(inspectorLog, 'r');
              const buffer = Buffer.alloc(16384);
              let bytes; try { bytes = fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
              endpoint = parseInspectorEndpoint(buffer.toString('utf8', 0, bytes));
              if (!endpoint) await delay(50);
            }
            if (settled) return;
            if (!endpoint) throw new Error('原版进程未提供临时名称启动入口，启动已停止。');
            runtimeBranding = await brandingInstaller(endpoint, {
              appAsarPath: path.join(prepared.settings.appPath, 'Contents', 'Resources', 'app.asar'),
              productName: prepared.settings.productName, welcomeTitle: prepared.settings.welcomeTitle,
            });
            if (runtimeBranding?.installed !== true || runtimeBranding?.inspectorClosed !== true) throw new Error('名称启动钩子未完成或临时调试入口未关闭。');
          }
          if (settled) return;
          clean();
          atomicJson(path.join(prepared.directory, 'last-launch.json'), {
            pid: child.pid,
            processFingerprint: processFingerprint(child.pid),
            gateway: prepared.settings.gateway, mode: prepared.settings.mode,
            executable: prepared.profile.executable, productSourceHash: prepared.productSourceHash,
            startedAt: new Date().toISOString(),
            ...(runtimeBranding ? { runtimeBranding: { productName: prepared.settings.productName, welcomeTitle: prepared.settings.welcomeTitle, inspectorClosed: true, inspectorPort: runtimeBranding.inspectorPort } } : {}),
          });
          settled = true; child.unref(); resolve({ pid: child.pid, env, ...(runtimeBranding ? { runtimeBranding } : {}) });
        } catch (error) { fail(new Error(branded ? error.message : '程序已启动，但无法写入启动记录；请检查启动器目录权限。')); }
      }, watchMs);
    });
  });
}
