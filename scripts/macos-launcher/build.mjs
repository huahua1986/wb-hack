import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const { values } = parseArgs({ options: { 'workspace-root': { type: 'string' } } });
const workspaceRoot = path.resolve(values['workspace-root'] || root);
if (!fs.existsSync(path.join(workspaceRoot, 'workbuddy-launcher.json'))) throw new Error('Missing workspace launcher configuration');
const app = path.join(root, 'dist', 'macos-launcher', '企业AI工作台.app');
if (fs.existsSync(app)) {
  const marker = JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'launcher.json')));
  if (marker.buildOwner !== 'enterprise-workbench-launcher') throw new Error('Build output is not owned by this builder');
  fs.rmSync(app, { recursive: true });
}
const contents = path.join(app, 'Contents'), resources = path.join(contents, 'Resources');
fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true }); fs.mkdirSync(resources);
fs.writeFileSync(path.join(resources, 'launcher.json'), JSON.stringify({ version: 1, buildOwner: 'enterprise-workbench-launcher', workspaceRoot }, null, 2) + '\n');
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-launcher-build-'));
try {
  execFileSync('/usr/bin/swiftc', ['-O', '-framework', 'AppKit', '-module-cache-path', path.join(cache, 'modules'), path.join(root, 'macos-launcher', 'LauncherApp.swift'), '-o', path.join(contents, 'MacOS', 'EnterpriseLauncher')], { stdio: 'inherit' });
  const iconBuilder = path.join(cache, 'BuildIcon');
  execFileSync('/usr/bin/swiftc', ['-O', '-framework', 'AppKit', '-module-cache-path', path.join(cache, 'modules'), path.join(root, 'macos-launcher', 'BuildIcon.swift'), '-o', iconBuilder], { stdio: 'inherit' });
  const iconset = path.join(cache, 'Launcher.iconset'); execFileSync(iconBuilder, [iconset], { stdio: 'inherit' });
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'Launcher.icns')]);
  fs.writeFileSync(path.join(resources, 'launcher.json'), JSON.stringify({ version: 1, buildOwner: 'enterprise-workbench-launcher', workspaceRoot }, null, 2) + '\n');
  const info = {
    CFBundleIdentifier: 'local.workbuddy.enterprise-ai-launcher', CFBundleName: '企业AI工作台', CFBundleDisplayName: '企业AI工作台',
    CFBundleExecutable: 'EnterpriseLauncher', CFBundlePackageType: 'APPL', CFBundleShortVersionString: '1.0.0', CFBundleVersion: '1',
    CFBundleIconFile: 'Launcher.icns', LSApplicationCategoryType: 'public.app-category.productivity', NSHighResolutionCapable: true,
    LSMinimumSystemVersion: '13.0', LSMultipleInstancesProhibited: true,
    NSDocumentsFolderUsageDescription: '读取已配置的工作台启动器和本地数据，沿用现有账号与模型设置。',
  };
  const json = path.join(cache, 'info.json'); fs.writeFileSync(json, JSON.stringify(info));
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', path.join(contents, 'Info.plist'), json]);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  execFileSync('/usr/bin/swiftc', ['-O', '-module-cache-path', path.join(cache, 'modules'), path.join(root, 'macos-launcher', 'PinDock.swift'), '-o', path.join(root, 'dist', 'macos-launcher', 'PinDock')], { stdio: 'inherit' });
  console.log(app);
} finally { fs.rmSync(cache, { recursive: true, force: true }); }
