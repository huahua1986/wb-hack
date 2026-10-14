import { parseArgs } from 'node:util';
import path from 'node:path';
import { launchDesktopWorkbench } from '../src/desktop-launcher.mjs';

try {
  process.umask(0o077);
  const { values } = parseArgs({ options: { config: { type: 'string' } } });
  if (!values.config) throw new Error('缺少启动配置路径。');
  const result = await launchDesktopWorkbench(path.resolve(values.config));
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
