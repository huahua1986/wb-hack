import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '../../client-distribution/bootstrap.mjs';
import { spawnPreparedWorkBuddy, workbuddyProcessIds } from '../../auth-gateway/src/double-click-launcher.mjs';
import { installRuntimeBranding } from '../../auth-gateway/src/runtime-branding.mjs';
import { offlineFaultScript } from './faults.mjs';
import { LABEL, verifyPayload, json } from '../../client-distribution/lib.mjs';

process.umask(0o077);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: { payload: { type: 'string' }, delay: { type: 'string' } } });
const root = path.resolve(values.payload || path.join(repo, 'dist/offline-validation/payload'));
verifyPayload(root);
const template = json(path.join(root, 'client-config.json'));
if (spawnSync('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/' + LABEL], { stdio: 'ignore' }).status === 0) throw new Error('验收前请暂停本项目登录任务；不会与正常入口竞争。');
if (workbuddyProcessIds(path.join(template.appPath, 'Contents/MacOS/Electron')).length) throw new Error('验收前请完整退出 WorkBuddy；已有实例不会被当作故障注入成功。');
const delayMs = Number(values.delay || 0);
if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5000) throw new Error('delay must be between 0 and 5000 ms');
const directory = path.join(repo, 'evidence/offline-acceptance'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const configPath = path.join(directory, 'network-fault-config.json');
const preload = path.join(repo, 'scripts/offline-validation/preload.cjs');
const proxy = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8' });
const proxyPorts = [...proxy.matchAll(/(?:HTTP|HTTPS|SOCKS)Port\s*:\s*(\d+)/g)].map(m => Number(m[1]));
fs.writeFileSync(configPath, JSON.stringify({ log: path.join(directory, 'network-fault-events.jsonl'), proxyPorts, hosts: [], delayMs }), { mode: 0o600 });
const result = await bootstrap({ root, quiet: true }, { start: prepared => spawnPreparedWorkBuddy(prepared, {
  brandingInstaller: (endpoint, options) => installRuntimeBranding(endpoint, options, {
    beforeResume: evaluate => evaluate(offlineFaultScript({ configPath, preload, appAsarPath: options.appAsarPath })),
  }),
}) });
if (result.status !== 'started') throw new Error('未创建本次注入实例，不能算作离线验收成功。');
console.log(JSON.stringify({ offlineHttpFaultInjection: true, delayMs, ...result }));
