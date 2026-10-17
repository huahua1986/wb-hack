import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clientPaths, json, KIND, LABEL, privateDirectory } from './lib.mjs';

export function disableClient({ home = os.homedir(), run = execFileSync } = {}) {
  const paths = clientPaths(home);
  if (json(path.join(paths.program, 'release.json')).kind !== KIND) throw new Error('程序目录不属于此客户端，已保留。');
  if (fs.existsSync(paths.agent)) {
    const agent = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', paths.agent], { encoding: 'utf8' }));
    if (agent.Label !== LABEL || agent.ProgramArguments?.[0] !== path.join(paths.program, 'runtime/node')) throw new Error('登录任务不属于此客户端，已保留。');
    try { run('/bin/launchctl', ['bootout', 'gui/' + process.getuid() + '/' + LABEL], { stdio: 'ignore' }); } catch (error) { if (![3, 113].includes(error.status)) throw error; }
    fs.renameSync(paths.agent, path.join(paths.base, 'disabled-login-' + Date.now() + '.plist'));
  }
  const archived = path.join(paths.state, 'legacy-launcher.app'), original = path.join(home, 'Applications', '企业AI工作台.app');
  if (fs.existsSync(archived) && !fs.existsSync(original)) {
    if (json(path.join(archived, 'Contents/Resources/launcher.json')).buildOwner !== 'enterprise-workbench-launcher') throw new Error('旧启动应用备份无法确认，已保留。');
    privateDirectory(path.dirname(original)); fs.renameSync(archived, original);
  }
  let legacyOwned = false;
  try { legacyOwned = json(path.join(original, 'Contents/Resources/launcher.json')).buildOwner === 'enterprise-workbench-launcher'; } catch {}
  const old = path.join(paths.state, 'legacy-login.plist');
  const restore = path.join(path.dirname(paths.agent), 'local.workbuddy.enterprise-ai-launcher.login.plist');
  if (fs.existsSync(old) && !fs.existsSync(restore) && legacyOwned) fs.renameSync(old, restore);
  return { loginDisabled: true, userDataPreserved: true, originalApplicationPreserved: true, legacyLoginRestoredForNextLogin: fs.existsSync(restore) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    if (process.getuid?.() === 0) throw new Error('请以当前用户运行停用入口。');
    console.log(JSON.stringify(disableClient()));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
