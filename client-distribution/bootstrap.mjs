import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { launchDesktopWorkbench } from '../auth-gateway/src/desktop-launcher.mjs';
import { prepareDoubleClickLaunch, processFingerprint, workbuddyProcessIds } from '../auth-gateway/src/double-click-launcher.mjs';
import { KIND, verifyPayload, verifyWorkBuddy, clientPaths, initializeState, atomicJson, json, seedModels } from './lib.mjs';
import { retireLegacyLogin } from './install.mjs';
import { requestGateway } from './setup.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export async function bootstrap({ root, gateway, migrateFrom, setup = false, autostart = false, quiet = false }, { start } = {}) {
  const manifest = verifyPayload(root), template = json(path.join(root, 'client-config.json')), paths = clientPaths();
  const actions = path.join(root, 'native/ClientActions');
  if (process.getuid?.() === 0) throw new Error('请在实际登录的用户会话中启用企业配置。');
  verifyWorkBuddy(template.appPath || '/Applications/WorkBuddy.app', manifest.compatibility);
  if (migrateFrom && workbuddyProcessIds(path.join(template.appPath, 'Contents/MacOS/Electron')).length) throw new Error('迁移前请正常退出 WorkBuddy，已有任务不会被强制终止。');
  let state = initializeState(root, { gateway, migrateFrom });
  if (state.needsGateway) {
    const choice = await requestGateway(state.state, { open: url => execFileSync(actions, ['open-url', url], { stdio: 'ignore' }) });
    if (choice.cancelled) return { status: 'cancelled' };
    state = initializeState(root, { gateway: choice.gateway, migrateFrom });
  }
  const lock = path.join(state.state, 'launch.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!fs.existsSync(path.join(lock, 'owner.json')) && Date.now() - fs.statSync(lock).mtimeMs < 5000) return { status: 'starting' };
    const owner = json(path.join(lock, 'owner.json'));
    if (owner.kind !== KIND || !Number.isInteger(owner.pid) || !owner.fingerprint) throw new Error('启动锁不属于此客户端。');
    if (processFingerprint(owner.pid) === owner.fingerprint) return { status: 'starting' };
    fs.rmSync(lock, { recursive: true }); fs.mkdirSync(lock, { mode: 0o700 });
  }
  atomicJson(path.join(lock, 'owner.json'), { kind: KIND, pid: process.pid, fingerprint: processFingerprint(process.pid) });
  try {
    const result = await launchDesktopWorkbench(state.filename, {
      ensureGateway: async () => {
        try {
          const response = await fetch(state.settings.gateway + '/healthz', { signal: AbortSignal.timeout(10000) });
          const value = await response.json();
          if (!response.ok || value?.code !== 0 || value?.data?.service !== 'workbuddy-auth' || value?.data?.status !== 'ok') throw new Error();
        } catch { throw new Error('认证服务暂不可用，请检查地址、网络或证书信任后重试。客户端不会切换到其他认证服务。'); }
        return { started: false };
      },
      prepare: filename => { const prepared = prepareDoubleClickLaunch(filename); seedModels(prepared.profile, template.models); return prepared; },
      ...(start ? { start } : {}),
    });
    if (setup || !fs.existsSync(path.join(state.state, 'dock.json'))) {
      let legacy = '';
      const previous = path.join(os.homedir(), 'Applications', '企业AI工作台.app');
      try { if (json(path.join(previous, 'Contents/Resources/launcher.json')).buildOwner === 'enterprise-workbench-launcher') legacy = previous; } catch {}
      if (!fs.existsSync(previous)) {
        try { if (json(path.join(state.state, 'legacy-launcher.app/Contents/Resources/launcher.json')).buildOwner === 'enterprise-workbench-launcher') legacy = previous; } catch {}
      }
      execFileSync(actions, ['pin', state.settings.appPath, path.join(state.state, 'dock-before.plist'), legacy], { stdio: 'ignore' });
      execFileSync('/usr/bin/killall', ['Dock'], { stdio: 'ignore' });
      let pinned = false;
      for (let i = 0; i < 20; i++) {
        const actual = JSON.parse(execFileSync(actions, ['check-pin', state.settings.appPath, legacy], { encoding: 'utf8' }));
        if (actual.originalPins === 1 && actual.legacyPins === 0) { pinned = true; break; }
        await delay(100);
      }
      if (!pinned) throw new Error('系统 Dock 未保留原版图标设置，请联系管理员。');
      atomicJson(path.join(state.state, 'dock.json'), { configured: true });
    }
    if (!autostart) execFileSync(actions, ['activate', String(result.pid), state.settings.appPath], { stdio: 'ignore' });
    retireLegacyLogin();
    atomicJson(path.join(state.state, 'status.json'), { status: 'ready', version: manifest.version, pid: result.pid, at: new Date().toISOString() });
    return { status: result.status, pid: result.pid, version: manifest.version };
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const { values } = parseArgs({ options: { payload: { type: 'string' }, gateway: { type: 'string' }, 'migrate-from': { type: 'string' }, setup: { type: 'boolean' }, autostart: { type: 'boolean' }, quiet: { type: 'boolean' } } });
  const root = path.resolve(values.payload || fileURLToPath(new URL('../', import.meta.url)));
  try { console.log(JSON.stringify(await bootstrap({ root, gateway: values.gateway, migrateFrom: values['migrate-from'], setup: values.setup, autostart: values.autostart, quiet: values.quiet }))); }
  catch (error) {
    const message = error.message || '企业配置启动失败，请联系管理员。';
    if (!values.quiet) { try { execFileSync(path.join(root, 'native/ClientActions'), ['alert', message], { stdio: 'ignore' }); } catch {} }
    console.error(message); process.exitCode = 1;
  }
}
