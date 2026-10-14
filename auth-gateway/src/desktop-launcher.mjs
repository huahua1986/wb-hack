import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readLauncherSettings, workbuddyProcessIds, processFingerprint, prepareDoubleClickLaunch, spawnPreparedWorkBuddy } from './double-click-launcher.mjs';

async function gatewayHealth(origin, request) {
  try {
    const response = await request(`${origin}/healthz`, { signal: AbortSignal.timeout(1500) });
    const value = await response.json();
    if (!response.ok || value?.code !== 0 || value?.data?.service !== 'workbuddy-auth' || value?.data?.status !== 'ok') throw new Error('本机网关端口被其他服务占用，未启动额外进程。');
    return true;
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return false;
    throw error;
  }
}

export async function ensureLocalGateway(settings, workspaceRoot, { request = fetch, spawnProcess = spawn, timeoutMs = 12000 } = {}) {
  const url = new URL(settings.gateway);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return { started: false, managed: false };
  if (await gatewayHealth(url.origin, request)) return { started: false, managed: true };
  const backendRoot = fileURLToPath(new URL('../', import.meta.url));
  const dataDir = path.join(workspaceRoot, 'auth-gateway', 'data');
  if (!fs.existsSync(path.join(dataDir, 'gateway.sqlite')) || !fs.existsSync(path.join(dataDir, 'delivery.key'))) {
    throw new Error('未找到现有本地网关账号库和密钥，拒绝自动创建空账号库。');
  }
  const logDir = path.join(workspaceRoot, 'auth-gateway', 'logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(path.join(logDir, 'desktop-backend.log'), 'a', 0o600);
  let child;
  try {
    child = spawnProcess(process.execPath, [path.join(backendRoot, 'src', 'main.mjs')], {
      cwd: backendRoot, detached: true, shell: false, stdio: ['ignore', descriptor, descriptor],
      env: { ...process.env, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: url.port || '80', GATEWAY_PUBLIC_URL: url.origin, GATEWAY_DATA_DIR: dataDir },
    });
  } finally { fs.closeSync(descriptor); }
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await gatewayHealth(url.origin, request)) return { started: true, managed: true, pid: child.pid };
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('本地网关启动失败，请查看 auth-gateway/logs/desktop-backend.log。');
    await delay(100);
  }
  throw new Error('本地网关启动超时，请检查现有账号库和端口。');
}

export async function launchDesktopWorkbench(configFilename, {
  findProcesses = workbuddyProcessIds, fingerprint = processFingerprint,
  ensureGateway = ensureLocalGateway, prepare = prepareDoubleClickLaunch, start = spawnPreparedWorkBuddy,
} = {}) {
  const settings = readLauncherSettings(configFilename);
  const executable = path.join(settings.appPath, 'Contents', 'MacOS', 'Electron');
  const pids = findProcesses(executable);
  if (pids.length) {
    let owner;
    try { owner = JSON.parse(fs.readFileSync(path.join(path.dirname(configFilename), 'auth-gateway', 'client-profiles', 'double-click', 'last-launch.json'), 'utf8')); } catch {}
    const branded = owner && pids.includes(owner.pid) && owner.processFingerprint && owner.processFingerprint === fingerprint(owner.pid)
      && owner.executable === executable && owner.gateway === settings.gateway && owner.mode === settings.mode
      && (!settings.productName || owner.runtimeBranding?.inspectorClosed === true && owner.runtimeBranding.productName === settings.productName && owner.runtimeBranding.welcomeTitle === settings.welcomeTitle);
    if (!branded) throw new Error('检测到其他入口启动的 WorkBuddy。请完整退出 WorkBuddy，再打开企业AI工作台；不会强制停止已有任务。');
    return { status: 'running', pid: owner.pid, appPath: settings.appPath, productName: settings.productName || 'WorkBuddy' };
  }
  const gateway = await ensureGateway(settings, path.dirname(configFilename));
  const prepared = prepare(configFilename);
  const result = await start(prepared);
  return { status: 'started', pid: result.pid, appPath: settings.appPath, productName: settings.productName || 'WorkBuddy', gatewayStarted: gateway.started };
}
