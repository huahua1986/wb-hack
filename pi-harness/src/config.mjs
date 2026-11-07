import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function readPiConfig(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw Error('Pi configuration must be a bounded regular file');
  const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const base = fs.realpathSync(path.dirname(filename));
  if (!data || Array.isArray(data) || typeof data !== 'object') throw Error('Invalid Pi configuration');
  const allowed = new Set(['command', 'args', 'tools', 'cwd', 'workspaceRoot', 'approvalMode', 'stateDir', 'agentDir', 'provider', 'model', 'modelName', 'officialOnly', 'officialBridgeDir']);
  if (Object.keys(data).some(k => !allowed.has(k))) throw Error('Unknown Pi configuration field');
  const result = {};
  if (data.approvalMode !== undefined) {
    if (!['manual', 'auto'].includes(data.approvalMode)) throw Error('Invalid Pi approvalMode');
    result.approvalMode = data.approvalMode;
  }
  if (data.workspaceRoot !== undefined) {
    if (typeof data.workspaceRoot !== 'string' || !data.workspaceRoot.trim() || /[\x00-\x1f]/.test(data.workspaceRoot)) throw Error('Invalid Pi workspaceRoot');
    result.workspaceRoot = path.resolve(base, data.workspaceRoot.replace(/^~\//, os.homedir() + '/'));
  }
  if (data.officialOnly !== undefined && typeof data.officialOnly !== 'boolean') throw Error('Invalid officialOnly');
  if (data.officialOnly === true) {
    if (data.provider !== undefined && data.provider !== 'workbuddy-official') throw Error('Official mode rejects non-official providers');
    result.officialOnly = true;
    data.provider ??= 'workbuddy-official';
    data.model ??= 'hy4';
    if (typeof data.officialBridgeDir !== 'string' || !data.officialBridgeDir.trim() || /[\x00-\x1f]/.test(data.officialBridgeDir)) throw Error('Invalid officialBridgeDir');
    result.officialBridgeDir = path.resolve(base, data.officialBridgeDir.replace(/^~\//, os.homedir() + '/'));
  } else if (data.officialBridgeDir !== undefined || data.provider === 'workbuddy-official') {
    throw Error('Official provider requires officialOnly and officialBridgeDir');
  }
  if (data.args !== undefined) {
    if (!Array.isArray(data.args) || data.args.length > 8 || data.args.some(v => typeof v !== 'string' || v.length > 4096 || /[\x00-\x1f]/.test(v))) throw Error('Invalid Pi arguments');
    result.args = [...data.args];
  }
  if (data.tools !== undefined) {
    const tools = new Set(['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls']);
    if (!Array.isArray(data.tools) || !data.tools.length || data.tools.some(v => !tools.has(v))) throw Error('Invalid Pi tool selection');
    result.tools = [...new Set(data.tools)];
  }
  for (const key of ['command', 'cwd', 'stateDir', 'agentDir']) {
    if (typeof data[key] !== 'string' || !data[key].trim() || /[\x00-\x1f]/.test(data[key])) throw Error(`Invalid Pi ${key}`);
    result[key] = path.resolve(base, data[key].replace(/^~\//, os.homedir() + '/'));
  }
  if (!fs.statSync(result.command).isFile() || !fs.statSync(result.cwd).isDirectory()) throw Error('Pi executable or workspace unavailable');
  fs.accessSync(result.command, fs.constants.X_OK);
  for (const key of ['provider', 'model', 'modelName']) {
    if (key === 'modelName' && data[key] === undefined) continue;
    if (typeof data[key] !== 'string' || !data[key].trim() || data[key].length > 256 || /[\x00-\x1f]/.test(data[key])) throw Error(`Invalid Pi ${key}`);
    result[key] = data[key].trim();
  }
  for (const key of ['stateDir', 'agentDir', ...(result.officialOnly ? ['officialBridgeDir'] : [])]) {
    let current = path.parse(result[key]).root;
    for (const part of result[key].slice(current.length).split(path.sep)) {
      current = path.join(current, part);
      if (fs.existsSync(current) && (fs.lstatSync(current).isSymbolicLink() || !fs.lstatSync(current).isDirectory())) throw Error('Pi data path contains a symlink or conflict');
    }
    fs.mkdirSync(result[key], { recursive: true, mode: 0o700 });
    fs.chmodSync(result[key], 0o700);
  }
  return result;
}
