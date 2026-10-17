import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { KIND, verifyPayload, verifyWorkBuddy, initializeState, atomicJson, json, regular } from './lib.mjs';
import { processFingerprint, workbuddyProcessIds, readLauncherSettings } from '../auth-gateway/src/double-click-launcher.mjs';

const execute = promisify(execFile);
const FRESH_MS = 8000;

export function ownedProcess(pid, settings, owner, fingerprint = processFingerprint) {
  return owner?.pid === pid && owner.processFingerprint && owner.processFingerprint === fingerprint(pid)
    && owner.executable === path.join(settings.appPath, 'Contents/MacOS/Electron')
    && owner.gateway === settings.gateway && owner.mode === settings.mode
    && owner.runtimeBranding?.inspectorClosed === true
    && owner.runtimeBranding.productName === settings.productName
    && owner.runtimeBranding.welcomeTitle === settings.welcomeTitle;
}

// Serialize events with controlled startup: its launch event arrives before last-launch.json is written.
export function createLaunchController({ settings, readOwner, fingerprint, handoff, launch, verify,
  findProcesses, report = () => {}, now = Date.now, wait = delay, refresh = () => {} }) {
  let pending = Promise.resolve(), closed = false;
  const seen = new Set();
  const managed = pid => ownedProcess(pid, settings, readOwner(), fingerprint);
  const fresh = app => Number.isInteger(app?.pid) && app.pid > 0 && Number.isFinite(app.launchedAt)
    && now() >= app.launchedAt && now() - app.launchedAt < FRESH_MS;
  const enqueue = action => {
    pending = pending.then(async () => { if (!closed) return action(); })
      .catch(error => report('error', { message: error.message }));
    return pending;
  };
  return {
    start(existing) {
      for (const app of existing) seen.add(`${app.pid}:${app.launchedAt}`);
      return enqueue(async () => {
        await refresh();
        if (existing.length) {
          report(existing.every(app => managed(app.pid)) ? 'ready' : 'existing-unmanaged', { count: existing.length });
          return;
        }
        // A simultaneous icon launch must be handled by its fresh launch event, not bootstrap's existing-instance check.
        if (!findProcesses().length) { await verify(); await launch(true); report('ready'); }
        else report('waiting-for-launch-event');
      });
    },
    handle(app) {
      const key = `${app?.pid}:${app?.launchedAt}`;
      if (seen.has(key)) return pending;
      seen.add(key);
      if (seen.size > 100) seen.delete(seen.values().next().value);
      return enqueue(async () => {
        await refresh();
        if (managed(app?.pid)) return;
        if (!fresh(app)) { report('ignored-stale'); return; }
        const originalFingerprint = fingerprint(app.pid);
        if (!originalFingerprint || findProcesses().some(pid => pid !== app.pid)) { report('ignored-conflict'); return; }
        await verify();
        if (closed || !fresh(app) || fingerprint(app.pid) !== originalFingerprint) { report('ignored-changed'); return; }
        report('handoff-requested', { pid: app.pid });
        // Native handoff rechecks birth identity and age; SIGTERM is restricted to a fresh process without a main window.
        const result = await handoff(app);
        const deadline = now() + 8000;
        while (findProcesses().length && now() < deadline && !closed) await wait(100);
        if (closed) return;
        if (findProcesses().length) throw new Error('WorkBuddy 后台尚未退出，停止自动接管，不结束其他进程。');
        await launch(false);
        report('handoff-complete', { previousPid: app.pid, method: result?.method || 'application-quit' });
      });
    },
    close() { closed = true; },
    idle() { return pending; },
  };
}

export async function supervise(root) {
  if (process.getuid?.() === 0) throw new Error('请在实际登录的用户会话中运行启动监听器。');
  const manifest = verifyPayload(root), state = initializeState(root);
  if (state.needsGateway) throw new Error('请先通过安装入口完成网关地址配置。');
  const settings = state.settings, actions = path.join(root, 'native/ClientActions');
  verifyWorkBuddy(settings.appPath, manifest.compatibility);
  const statusFile = path.join(state.state, 'supervisor.json');
  const eventsFile = path.join(state.state, 'supervisor-events.jsonl');
  let stopped = false, child, observer, controller;
  const readOwner = () => { try { return json(path.join(state.state, 'auth-gateway/client-profiles/double-click/last-launch.json')); } catch { return null; } };
  const report = (event, details = {}) => {
    if (stopped) return;
    const record = { kind: KIND, event, at: new Date().toISOString(), supervisorPid: process.pid, ...details };
    atomicJson(statusFile, record);
    // This log contains only lifecycle metadata; never application arguments, tokens, URLs or model requests.
    if (fs.lstatSync(eventsFile, { throwIfNoEntry: false }) && regular(eventsFile).size > 65536) fs.renameSync(eventsFile, eventsFile + '.previous');
    fs.appendFileSync(eventsFile, JSON.stringify(record) + '\n', { mode: 0o600 });
  };
  const run = async args => execute(actions, args, { timeout: 16000, maxBuffer: 16384 });
  const launch = async autostart => {
    child = spawn(path.join(root, 'runtime/node'), [path.join(root, 'client-distribution/bootstrap.mjs'), '--payload', root, '--quiet', ...(autostart ? ['--autostart'] : [])],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true });
    let stdout = '';
    child.stdout.on('data', bytes => { if (stdout.length < 65536) stdout += bytes; });
    // Bootstrap errors can include external inputs; keep only a generic error in the persistent lifecycle log.
    child.stderr.resume();
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    child = undefined;
    if (stopped) return;
    if (exit !== 0) throw new Error('受控启动失败，请检查认证服务可用性、版本及客户端配置。');
    let value;
    try { value = JSON.parse(stdout.trim().split('\n').at(-1)); } catch {}
    if (!['started', 'running'].includes(value?.status)) throw new Error('受控启动未完成，请联系管理员。');
  };
  controller = createLaunchController({ settings, readOwner, fingerprint: processFingerprint,
    findProcesses: () => workbuddyProcessIds(path.join(settings.appPath, 'Contents/MacOS/Electron')),
    verify: () => verifyWorkBuddy(settings.appPath, manifest.compatibility), launch, report,
    refresh: () => {
      const updated = readLauncherSettings(state.filename);
      if (updated.appPath !== state.settings.appPath) throw new Error('监听目标路径已变更，请重新安装配置。');
      Object.assign(settings, updated);
    },
    handoff: async app => {
      const { stdout } = await run(['handoff', String(app.pid), settings.appPath, String(app.launchedAt)]);
      return JSON.parse(stdout);
    },
  });
  const stop = () => {
    stopped = true; controller.close();
    observer?.stdin.end(); observer?.kill('SIGTERM');
    // Do not kill a bootstrap halfway through its short Inspector transaction or terminate WorkBuddy on disable.
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    observer = spawn(actions, ['observe', settings.appPath], { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    const completion = new Promise((resolve, reject) => {
      observer.once('error', reject);
      observer.once('exit', code => stopped && code !== 1 ? resolve() : reject(new Error('原版启动事件监听器已退出。')));
    });
    const lines = createInterface({ input: observer.stdout });
    let ready = false;
    lines.on('line', line => {
      if (line.length > 16384) return;
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'ready' && !ready && Array.isArray(event.existing)) {
        ready = true; report('listening'); controller.start(event.existing);
      } else if (event.type === 'launch' && ready) controller.handle(event.app);
      else if (event.type === 'session-ending') stop();
    });
    await completion;
    await controller.idle();
    lines.close();
  } finally { stop(); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const { values } = parseArgs({ options: { payload: { type: 'string' } } });
  try { await supervise(path.resolve(values.payload || fileURLToPath(new URL('../', import.meta.url)))); }
  catch { console.error('企业配置监听器未能启动，请联系管理员。'); process.exitCode = 1; }
}
