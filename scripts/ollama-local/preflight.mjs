import path from 'node:path';
import { readLauncherSettings, workbuddyProcessIds } from '../../auth-gateway/src/double-click-launcher.mjs';
const settings = readLauncherSettings(path.resolve('workbuddy-launcher.json'));
const executable = path.join(settings.appPath, 'Contents', 'MacOS', 'Electron');
if (workbuddyProcessIds(executable).length) {
  throw new Error('请完整退出 WorkBuddy 后再运行；此脚本不会中断正在执行的任务。');
}
