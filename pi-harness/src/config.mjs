import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeSshPi } from './ssh-pi.mjs';
import { isPiHttpDocxName, normalizeHttpPi } from './pi-http-client.mjs';

export function normalizeSshOffice(value, base) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['stagingRoot', 'mode', 'documents'].includes(key))
    || !['read', 'edit'].includes(value.mode)
    || typeof value.stagingRoot !== 'string' || !value.stagingRoot.trim() || /[\x00-\x1f\x7f]/.test(value.stagingRoot)
    || !Array.isArray(value.documents) || value.documents.length < 1 || value.documents.length > 8
    || new Set(value.documents).size !== value.documents.length
    || value.documents.some(name => typeof name !== 'string' || !/^[^./\\\x00-\x1f\x7f][^/\\\x00-\x1f\x7f]{0,246}\.docx$/i.test(name))) {
    throw Error('Pi SSH Office requires a mode, staging root and explicitly selected DOCX filenames');
  }
  const stagingRoot = path.resolve(base, value.stagingRoot.replace(/^~\//, os.homedir() + '/'));
  if (stagingRoot === path.parse(stagingRoot).root) throw Error('Pi SSH Office staging root cannot be the filesystem root');
  return { stagingRoot, mode: value.mode, documents: [...value.documents] };
}

export function readPiConfig(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw Error('Pi configuration must be a bounded regular file');
  const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const base = fs.realpathSync(path.dirname(filename));
  if (!data || Array.isArray(data) || typeof data !== 'object') throw Error('Invalid Pi configuration');
  const allowed = new Set(['command', 'args', 'tools', 'cwd', 'workspaceRoot', 'approvalMode', 'stateDir', 'agentDir', 'provider', 'model', 'modelName', 'officialOnly', 'officialBridgeDir', 'ssh', 'sshOffice', 'https', 'officeDocuments']);
  if (Object.keys(data).some(k => !allowed.has(k))) throw Error('Unknown Pi configuration field');
  const result = {};
  if (data.ssh !== undefined) {
    if (['command', 'args', 'tools', 'workspaceRoot', 'officialBridgeDir'].some(key => data[key] !== undefined)
      || data.officialOnly === true || data.approvalMode === 'auto') throw Error('Pi SSH mode only supports text chats with a remote model');
    result.ssh = normalizeSshPi(data.ssh, base);
  }
  if (data.sshOffice !== undefined) {
    if (!result.ssh) throw Error('Pi SSH Office requires SSH');
    result.sshOffice = normalizeSshOffice(data.sshOffice, base);
  }
  if (data.https !== undefined) {
    if (result.ssh || ['command', 'args', 'tools', 'workspaceRoot', 'officialBridgeDir'].some(key => data[key] !== undefined)
      || data.officialOnly === true || data.approvalMode === 'auto') throw Error('Pi HTTPS requires an isolated remote profile');
    result.https = normalizeHttpPi(data.https, base);
  }
  if (data.officeDocuments !== undefined) {
    result.officeDocuments = normalizeOfficeDocuments(data.officeDocuments, result.https);
  }
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
  for (const key of [...(result.ssh || result.https ? [] : ['command']), 'cwd', 'stateDir', 'agentDir']) {
    if (typeof data[key] !== 'string' || !data[key].trim() || /[\x00-\x1f]/.test(data[key])) throw Error(`Invalid Pi ${key}`);
    result[key] = path.resolve(base, data[key].replace(/^~\//, os.homedir() + '/'));
  }
  if (!fs.statSync(result.cwd).isDirectory()) throw Error('Pi workspace unavailable');
  if (result.sshOffice && fs.realpathSync(result.cwd) !== result.cwd) throw Error('Pi SSH Office workspace must be a canonical local directory');
  if (!result.ssh && !result.https) {
    if (!fs.statSync(result.command).isFile()) throw Error('Pi executable unavailable');
    fs.accessSync(result.command, fs.constants.X_OK);
  }
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

export function normalizeOfficeDocuments(documents, https) {
  if (https?.mode !== 'fileOffice' || !Array.isArray(documents) || documents.length > 8
    || new Set(documents).size !== documents.length
    || documents.some(name => !isPiHttpDocxName(name))) {
    throw Error('HTTPS Office documents must be explicitly selected DOCX filenames');
  }
  return [...documents];
}
