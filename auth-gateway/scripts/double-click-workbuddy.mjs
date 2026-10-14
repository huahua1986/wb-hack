import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { prepareDoubleClickLaunch, spawnPreparedWorkBuddy } from '../src/double-click-launcher.mjs';

try {
  if (process.platform !== 'darwin') throw new Error('此双击启动入口适用于 macOS。');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本。');
  process.umask(0o077);
  const { values } = parseArgs({ options: { config: { type: 'string' }, check: { type: 'boolean', default: false } } });
  const configFilename = path.resolve(values.config || fileURLToPath(new URL('../../workbuddy-launcher.json', import.meta.url)));
  const prepared = prepareDoubleClickLaunch(configFilename);
  console.log(`网关：${prepared.settings.gateway}`);
  console.log(`认证模式：${prepared.settings.mode}；登录文件：${path.basename(prepared.authPath)}`);
  if (values.check) console.log('检查通过，外部启动配置已准备；没有启动 WorkBuddy。');
  else {
    const result = await spawnPreparedWorkBuddy(prepared);
    console.log(`WorkBuddy 进程已启动（PID ${result.pid}），已传入 WORKBUDDY_DEV_ENDPOINT_OVERRIDE。`);
    if (result.runtimeBranding) console.log(`显示名称：${prepared.settings.productName}；临时调试入口已关闭。`);
  }
} catch (error) { console.error(`启动失败：${error.message}`); process.exitCode = 1; }
