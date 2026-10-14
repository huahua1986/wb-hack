import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const source = path.join(root, 'dist', 'macos-launcher', '企业AI工作台.app');
const target = path.join(os.homedir(), 'Applications', '企业AI工作台.app');
const label = 'local.workbuddy.enterprise-ai-launcher.login';
const agent = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const marker = app => JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'launcher.json'), 'utf8'));
const pinHelper = path.join(root, 'dist', 'macos-launcher', 'PinDock');
if (!fs.existsSync(pinHelper)) throw new Error('Missing Dock helper; rebuild before installing');
if (fs.existsSync(target)) {
  try {
    const ids = execFileSync('/usr/bin/pgrep', ['-f', `^${path.join(target, 'Contents', 'MacOS', 'EnterpriseLauncher').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([[:space:]]|$)`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (ids.trim()) throw new Error('请先正常退出企业AI工作台启动应用，再更新安装。');
  } catch (error) { if (error.status !== 1) throw error; }
}
if (marker(source).buildOwner !== 'enterprise-workbench-launcher') throw new Error('Invalid build ownership');
const workspaceRoot = marker(source).workspaceRoot;
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', source]);
if (fs.existsSync(target) && marker(target).buildOwner !== 'enterprise-workbench-launcher') throw new Error('Target application already belongs to another installation');
if (fs.existsSync(agent)) {
  const data = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', agent], { encoding: 'utf8' }));
  if (data.Label !== label || !data.ProgramArguments?.includes(target)) throw new Error('Login agent belongs to another configuration');
}
fs.mkdirSync(path.dirname(target), { recursive: true });
const staged = path.join(path.dirname(target), `.enterprise-${randomUUID()}.app`);
execFileSync('/usr/bin/ditto', [source, staged]);
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
if (fs.existsSync(target)) {
  const backup = path.join(root, 'macos-launcher', 'install-backups', `${Date.now()}.app`);
  fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.renameSync(target, backup);
}
fs.renameSync(staged, target);
const logDir = path.join(os.homedir(), 'Library', 'Logs', '企业AI工作台'); fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
const data = { Label: label, ProgramArguments: ['/usr/bin/open', '-a', target, '--args', '--autostart'], RunAtLoad: true, KeepAlive: false,
  StandardOutPath: path.join(logDir, 'login.stdout.log'), StandardErrorPath: path.join(logDir, 'login.stderr.log'), ProcessType: 'Interactive' };
fs.mkdirSync(path.dirname(agent), { recursive: true });
const temp = path.join(os.tmpdir(), `enterprise-agent-${randomUUID()}.json`); fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
try { execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', agent, temp]); fs.chmodSync(agent, 0o600); } finally { fs.unlinkSync(temp); }
const evidence = path.join(root, 'evidence', 'dock-launcher'); fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(path.join(evidence, 'installation.json'), JSON.stringify({ app: target, agent, label, workspaceRoot }, null, 2) + '\n');
execFileSync(pinHelper, [target, JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'workbuddy-launcher.json'))).appPath, path.join(evidence, 'dock-original-tile.plist')], { stdio: 'inherit' });
execFileSync('/usr/bin/killall', ['Dock']);
const service = `gui/${process.getuid()}/${label}`;
try { execFileSync('/bin/launchctl', ['bootout', service], { stdio: 'ignore' }); } catch (error) { if (![3, 113].includes(error.status)) throw error; }
execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, agent]);
console.log(JSON.stringify({ app: target, agent, label }));
