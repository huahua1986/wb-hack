import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const VERIFIED_PI_ARTIFACTS = Object.freeze({
  local: Object.freeze([
    Object.freeze({ version: '5.9.1', sha256: '1fc0a56ddec5437d4dc55a55ba1c028b291ab29cb17306500827015987424233' }),
  ]),
  ssh: Object.freeze([
    Object.freeze({ version: '5.11.2', sha256: '6d6ec0fc44a312249837385014205ecfcacc7ca457dba29ec9afcd7d0e19233d' }),
    Object.freeze({ version: '5.11.3', sha256: '45965c389b9674ef359fb5fc331a40ca0c0777c8380104f2e9ea8950bced614f' }),
  ]),
});

export function normalizePiHarness(value, base = process.cwd()) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean' || Object.keys(value).some(k => !['enabled', 'configFile'].includes(k))) throw Error('Invalid Pi Harness configuration');
  if (!value.enabled) return { enabled: false };
  if (typeof value.configFile !== 'string' || !value.configFile.trim() || /[\x00-\x1f]/.test(value.configFile)) throw Error('Pi Harness requires configFile');
  const configFile = path.resolve(base, value.configFile);
  const stat = fs.lstatSync(configFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw Error('Pi configFile must be a bounded regular file');
  return { enabled: true, configFile };
}

export function verifyPiRuntime(asarPath, { transport = 'local' } = {}) {
  const artifactMode = transport === 'https' ? 'ssh' : transport;
  if (!Object.hasOwn(VERIFIED_PI_ARTIFACTS, artifactMode)) throw Error('Unknown Pi Harness transport');
  const artifacts = VERIFIED_PI_ARTIFACTS[artifactMode];
  const hash = createHash('sha256'), fd = fs.openSync(asarPath, 'r'), bytes = Buffer.alloc(4 * 1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, bytes)) > 0) hash.update(bytes.subarray(0, n)); } finally { fs.closeSync(fd); }
  const digest = hash.digest('hex');
  const artifact = artifacts.find(item => item.sha256 === digest);
  if (!artifact) throw Error(`Pi Harness only supports verified WorkBuddy artifacts (${artifacts.map(item => item.version).join(', ')}) for ${transport} transport`);
  return artifact;
}

export function piRuntimeScript(appAsarPath, settings) {
  if (!settings?.enabled) return '';
  const runtimeFile = fileURLToPath(new URL('../../pi-harness/src/electron-runtime.cjs', import.meta.url));
  return `process.getBuiltinModule('module').createRequire(${JSON.stringify(appAsarPath + '/package.json')})(${JSON.stringify(runtimeFile)}).install(${JSON.stringify({ appAsarPath, configFile: settings.configFile })})`;
}
