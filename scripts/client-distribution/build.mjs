import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { CLIENT_MODULES, KIND, LABEL, VERSION, digest, validateModelPreset, json, launchAgent } from '../../client-distribution/lib.mjs';
import { validatePublicUrl } from '../../auth-gateway/src/config.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: { 'node-dir': { type: 'string' }, output: { type: 'string' }, gateway: { type: 'string' }, ca: { type: 'string' }, models: { type: 'string' }, 'application-signing-identity': { type: 'string' }, 'installer-signing-identity': { type: 'string' }, 'require-signed': { type: 'boolean' } } });
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('当前构建目标为 macOS arm64。');
if (!values['node-dir']) throw new Error('请用 --node-dir 指定已校验的官方 Node 24 arm64 解压目录。');
if (values['require-signed'] && (!values['application-signing-identity'] || !values['installer-signing-identity'])) throw new Error('正式构建必须提供应用和安装包签名身份。');
const nodeDir = path.resolve(values['node-dir']), node = path.join(nodeDir, 'bin/node');
execFileSync('/usr/bin/codesign', ['--verify', '--strict', node], { stdio: 'pipe' });
const runtime = JSON.parse(execFileSync(node, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'], { encoding: 'utf8' }));
if (Number(runtime.version.slice(1).split('.')[0]) < 24 || runtime.platform !== 'darwin' || runtime.arch !== 'arm64') throw new Error('运行时必须是官方 macOS arm64 Node 24+。');
const output = path.resolve(values.output || path.join(root, 'dist/client-distribution'));
if (fs.existsSync(output)) throw new Error('构建输出目录已存在，请指定新的 --output。');
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-client-build-'));
const delivery = path.join(output, 'WorkBuddy企业配置'), payload = path.join(delivery, 'payload');
const copy = (source, destination, executable = false) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination); fs.chmodSync(destination, executable ? 0o755 : 0o644);
};
try {
  fs.mkdirSync(payload, { recursive: true });
  copy(node, path.join(payload, 'runtime/node'), true);
  copy(path.join(nodeDir, 'LICENSE'), path.join(payload, 'runtime/LICENSE'));
  for (const name of CLIENT_MODULES) copy(path.join(root, 'auth-gateway/src', name + '.mjs'), path.join(payload, 'auth-gateway/src', name + '.mjs'));
  for (const name of ['lib.mjs', 'bootstrap.mjs', 'install.mjs', 'uninstall.mjs', 'setup.mjs']) copy(path.join(root, 'client-distribution', name), path.join(payload, 'client-distribution', name));
  const config = json(path.join(root, 'client-distribution/client-config.example.json'));
  config.gateway = values.gateway ? validatePublicUrl(values.gateway) : '';
  if (values.models) config.models = validateModelPreset(json(path.resolve(values.models)));
  if (values.ca) {
    const bytes = fs.readFileSync(path.resolve(values.ca)), certificate = new X509Certificate(bytes);
    if (bytes.includes(Buffer.from('PRIVATE KEY')) || !certificate.ca || Date.parse(certificate.validTo) <= Date.now() || Date.parse(certificate.validFrom) > Date.now()) throw new Error('只能分发有效的公开 CA 证书。');
    config.caFile = 'certs/enterprise-ca.pem'; copy(path.resolve(values.ca), path.join(payload, config.caFile));
  }
  fs.writeFileSync(path.join(payload, 'client-config.json'), JSON.stringify(config, null, 2) + '\n');
  const actions = path.join(payload, 'native/ClientActions'); fs.mkdirSync(path.dirname(actions));
  const helperInfoJson = path.join(cache, 'helper-info.json'), helperInfo = path.join(cache, 'helper-info.plist');
  fs.writeFileSync(helperInfoJson, JSON.stringify({ CFBundleIdentifier: 'local.workbuddy.enterprise-client.actions', CFBundleName: 'WorkBuddy 企业配置', CFBundleExecutable: 'ClientActions', CFBundleVersion: '1', LSUIElement: true, NSHighResolutionCapable: true }));
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', helperInfo, helperInfoJson]);
  execFileSync('/usr/bin/swiftc', ['-O', '-target', 'arm64-apple-macos13.0', '-framework', 'AppKit', '-module-cache-path', path.join(cache, 'modules'), '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', helperInfo, path.join(root, 'client-distribution/ClientActions.swift'), '-o', actions], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', values['application-signing-identity'] || '-', ...(values['application-signing-identity'] ? ['--options', 'runtime', '--timestamp'] : []), actions], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', actions]);
  const files = {};
  const inventory = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const filename = path.join(directory, entry.name); if (entry.isDirectory()) inventory(filename); else files[path.relative(payload, filename)] = digest(filename); } };
  inventory(payload);
  const manifest = { kind: KIND, version: VERSION, architecture: 'arm64', runtime, runtimeSha256: digest(node),
    signing: values['application-signing-identity'] && values['installer-signing-identity'] ? 'signed-not-notarized' : 'internal-test',
    compatibility: json(path.join(root, 'client-distribution/compatibility.json')), ...(config.caFile ? { caFile: config.caFile } : {}), files };
  fs.writeFileSync(path.join(payload, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
  const command = '#!/bin/zsh -f\nBASE="$' + '{0:A:h}"\nexec "$BASE/payload/runtime/node" "$BASE/payload/client-distribution/install.mjs" --source "$BASE/payload" "$@"\n';
  fs.writeFileSync(path.join(delivery, '安装企业配置.command'), command, { mode: 0o755 });
  const disableCommand = '#!/bin/zsh -f\nCLIENT="$HOME/Library/Application Support/EnterpriseWorkbenchClient/program"\nif [[ ! -x "$CLIENT/runtime/node" ]]; then print -- "未找到用户级企业配置组件。"; exit 1; fi\nexec "$CLIENT/runtime/node" "$CLIENT/client-distribution/uninstall.mjs"\n';
  fs.writeFileSync(path.join(delivery, '停用企业配置（保留数据）.command'), disableCommand, { mode: 0o755 });
  copy(path.join(root, 'client-distribution/README.md'), path.join(delivery, 'README.md'));
  const prefix = '/Library/Application Support/EnterpriseWorkbenchClient', staging = path.join(cache, 'package-root'), scripts = path.join(cache, 'package-scripts');
  fs.mkdirSync(path.dirname(path.join(staging, prefix)), { recursive: true });
  fs.cpSync(payload, path.join(staging, prefix), { recursive: true });
  const agents = path.join(staging, 'Library/LaunchAgents'); fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, LABEL + '.plist'), launchAgent(prefix, manifest.caFile));
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, 'preinstall'), '#!/bin/bash\nset -e\nROOT="/Library/Application Support/EnterpriseWorkbenchClient"\nif [ "$3" != "/" ]; then echo "Only the running system volume is supported." >&2; exit 1; fi\n[ "$(/usr/bin/uname -m)" = arm64 ] || { echo "This package supports Apple Silicon only." >&2; exit 1; }\n[ ! -L "$ROOT" ] || { echo "Program directory is a link." >&2; exit 1; }\nif [ -e "$ROOT" ]; then\n KIND=$(/usr/bin/plutil -extract kind raw -o - "$ROOT/release.json" 2>/dev/null || true)\n [ "$KIND" = "' + KIND + '" ] || { echo "Existing directory is not owned by this installer." >&2; exit 1; }\nfi\n', { mode: 0o755 });
  fs.writeFileSync(path.join(scripts, 'postinstall'), '#!/bin/bash\nset -e\nUSER_NAME=$(/usr/bin/stat -f %Su /dev/console)\nif [ "$USER_NAME" = root ] || [ "$USER_NAME" = loginwindow ] || [ "$USER_NAME" = _mbsetupuser ]; then exit 0; fi\nUSER_ID=$(/usr/bin/id -u "$USER_NAME")\nif [ "$USER_ID" -lt 500 ]; then exit 0; fi\n/bin/launchctl bootout "gui/$USER_ID/' + LABEL + '" >/dev/null 2>&1 || true\n/bin/launchctl bootstrap "gui/$USER_ID" "/Library/LaunchAgents/' + LABEL + '.plist"\n', { mode: 0o755 });
  const pkg = path.join(output, 'WorkBuddy-企业配置-' + VERSION + '-arm64-' + manifest.signing + '.pkg');
  execFileSync('/usr/bin/pkgbuild', ['--root', staging, '--scripts', scripts, '--identifier', 'local.workbuddy.enterprise-client', '--version', VERSION, '--install-location', '/', ...(values['installer-signing-identity'] ? ['--sign', values['installer-signing-identity']] : []), pkg], { stdio: 'inherit' });
  const zip = path.join(output, 'WorkBuddy-企业配置-' + VERSION + '-arm64-' + manifest.signing + '.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', delivery, zip]);
  for (const filename of [pkg, zip]) fs.writeFileSync(filename + '.sha256', digest(filename) + '  ' + path.basename(filename) + '\n');
  fs.writeFileSync(path.join(output, 'build-report.json'), JSON.stringify({ version: VERSION, signing: manifest.signing, pkg: path.basename(pkg), zip: path.basename(zip), runtime, files: Object.keys(files).length, includesBackendDatabase: false, includesWorkBuddy: false, newApplicationBundle: false }, null, 2));
  console.log(JSON.stringify({ output, pkg, zip, signing: manifest.signing }));
} finally { fs.rmSync(cache, { recursive: true, force: true }); }
