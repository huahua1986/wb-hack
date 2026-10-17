import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { KIND, LABEL, clientPaths, privateDirectory, verifyPayload, json, launchAgent, initializeState } from './lib.mjs';

export function installPayload(source, { home = os.homedir(), register = true } = {}) {
  const manifest = verifyPayload(source), paths = clientPaths(home);
  privateDirectory(paths.base);
  const previousProgram = fs.lstatSync(paths.program, { throwIfNoEntry: false });
  if (previousProgram && (!previousProgram.isDirectory() || previousProgram.isSymbolicLink())) throw new Error('程序目录存在链接或冲突，已保留。');
  if (fs.existsSync(paths.program) && json(path.join(paths.program, 'release.json')).kind !== KIND) throw new Error('已有程序目录不属于此安装包，已保留。');
  const previousAgent = fs.lstatSync(paths.agent, { throwIfNoEntry: false });
  if (previousAgent) {
    if (!previousAgent.isFile() || previousAgent.isSymbolicLink()) throw new Error('登录任务存在链接或冲突，已保留。');
    const previous = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', paths.agent], { encoding: 'utf8' }));
    if (previous.Label !== LABEL || previous.ProgramArguments?.[0] !== path.join(paths.program, 'runtime/node')) throw new Error('登录任务已有其他配置，已保留。');
  }
  const staged = path.join(paths.base, 'program.new.' + randomUUID());
  let backup;
  try {
    fs.cpSync(source, staged, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    verifyPayload(staged);
    if (fs.existsSync(paths.program)) { backup = path.join(paths.base, 'program.previous.' + Date.now()); fs.renameSync(paths.program, backup); }
    try { fs.renameSync(staged, paths.program); } catch (error) { if (backup) fs.renameSync(backup, paths.program); throw error; }
  } finally { if (fs.existsSync(staged)) fs.rmSync(staged, { recursive: true, force: true }); }
  privateDirectory(path.dirname(paths.agent));
  fs.writeFileSync(paths.agent, launchAgent(paths.program, manifest.caFile), { mode: 0o600 });
  if (register) {
    const service = 'gui/' + process.getuid() + '/' + LABEL;
    try { execFileSync('/bin/launchctl', ['bootout', service], { stdio: 'ignore' }); } catch (error) { if (![3, 113].includes(error.status)) throw error; }
    execFileSync('/bin/launchctl', ['bootstrap', 'gui/' + process.getuid(), paths.agent], { stdio: 'ignore' });
  }
  return { ...paths, backup };
}
export function retireLegacyLogin(home = os.homedir(), { run = execFileSync } = {}) {
  const paths = clientPaths(home), app = path.join(home, 'Applications', '企业AI工作台.app');
  const agent = path.join(home, 'Library/LaunchAgents/local.workbuddy.enterprise-ai-launcher.login.plist');
  const backup = path.join(paths.state, 'legacy-login.plist');
  if (!fs.existsSync(app) || !fs.existsSync(agent) && !fs.existsSync(backup)) return;
  try { if (json(path.join(app, 'Contents/Resources/launcher.json')).buildOwner !== 'enterprise-workbench-launcher') return; } catch { return; }
  const previous = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', fs.existsSync(agent) ? agent : backup], { encoding: 'utf8' }));
  if (previous.Label !== 'local.workbuddy.enterprise-ai-launcher.login' || !previous.ProgramArguments?.includes(app)) return;
  privateDirectory(paths.state);
  if (fs.existsSync(agent)) {
    if (fs.existsSync(backup)) throw new Error('旧登录任务备份已存在，未覆盖。');
    try { run('/bin/launchctl', ['bootout', 'gui/' + process.getuid() + '/' + previous.Label], { stdio: 'ignore' }); } catch (error) { if (![3, 113].includes(error.status)) throw error; }
    fs.renameSync(agent, backup);
  }
  const archived = path.join(paths.state, 'legacy-launcher.app');
  if (fs.existsSync(archived)) return;
  const executable = path.join(app, 'Contents/MacOS/EnterpriseLauncher');
  try {
    const ids = run('/usr/bin/pgrep', ['-f', '^' + executable.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&') + '([[:space:]]|$)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (String(ids).trim()) return;
  } catch (error) { if (error.status !== 1) throw error; }
  fs.renameSync(app, archived);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    if (process.getuid?.() === 0) throw new Error('此安装入口按当前用户安装，请不要使用 sudo。系统安装包请交给 macOS Installer。');
    const { values } = parseArgs({ options: { source: { type: 'string' }, gateway: { type: 'string' }, 'migrate-from': { type: 'string' }, 'no-start': { type: 'boolean' } } });
    const source = path.resolve(values.source || fileURLToPath(new URL('../', import.meta.url)));
    // Install without registering first, so initial configuration and legacy retirement finish before login dispatch.
    const result = installPayload(source, { register: false });
    let configured = false;
    if (!values['no-start']) {
      const args = [path.join(result.program, 'client-distribution/bootstrap.mjs'), '--payload', result.program, '--setup'];
      if (values.gateway) args.push('--gateway', values.gateway);
      if (values['migrate-from']) args.push('--migrate-from', path.resolve(values['migrate-from']));
      const release = verifyPayload(result.program);
      const output = execFileSync(path.join(result.program, 'runtime/node'), args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'],
        env: { ...process.env, ...(release.caFile ? { NODE_EXTRA_CA_CERTS: path.join(result.program, release.caFile) } : {}) } });
      const status = JSON.parse(output.trim().split('\n').at(-1));
      configured = status.status !== 'cancelled';
    }
    else initializeState(result.program, { gateway: values.gateway });
    if (configured) retireLegacyLogin();
    const service = 'gui/' + process.getuid() + '/' + LABEL;
    try { execFileSync('/bin/launchctl', ['bootout', service], { stdio: 'ignore' }); } catch (error) { if (![3, 113].includes(error.status)) throw error; }
    if (configured) execFileSync('/bin/launchctl', ['bootstrap', 'gui/' + process.getuid(), result.agent], { stdio: 'ignore' });
    const resultInfo = { installed: true, configured, version: verifyPayload(result.program).version, agent: result.agent, noNewApplication: true };
    if (process.stdout.isTTY) console.log(configured ? '企业配置已安装。以后登录电脑后，点击原版 WorkBuddy 图标即可使用。完整退出后需重新应用企业配置。此窗口现在可以关闭。' : '客户端组件已安装，首次地址配置尚未完成。重新运行安装入口可继续。');
    else console.log(JSON.stringify(resultInfo));
  } catch (error) {
    console.error(process.stdout.isTTY ? '安装尚未完成。请正常退出 WorkBuddy 后重试；若仍失败，请联系管理员。' : error.message);
    process.exitCode = 1;
  }
}
