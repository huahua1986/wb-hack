import fs from 'node:fs';
import path from 'node:path';
import { validatePublicUrl } from './config.mjs';

function readObject(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('乐享服务配置必须是普通 JSON 文件。');
  let value;
  try { value = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new Error('乐享服务配置不是有效的 JSON。'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('乐享服务配置必须是对象。');
  return value;
}
export function readLexiangConfig(config) {
  if (!config.lexiang && !config.lexiangConfigFile) return undefined;
  const input = config.lexiang ?? readObject(config.lexiangConfigFile);
  const root = config.lexiangConfigFile ? path.dirname(config.lexiangConfigFile) : config.dataDir;
  if (!input || !['mock', 'bridge'].includes(input.mode)) throw new Error('lexiang.mode 必须是 mock 或 bridge。');
  if (input.mode === 'mock') {
    const url = new URL(config.publicUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || config.host && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) throw new Error('乐享 Mock 只允许绑定本机回环地址。');
    const accessTtlSeconds = input.accessTtlSeconds ?? 300;
    if (!Number.isInteger(accessTtlSeconds) || accessTtlSeconds < 60 || accessTtlSeconds > 300) throw new Error('乐享短期令牌有效期应为 60–300 秒。');
    return { mode: 'mock', accessTtlSeconds };
  }
  const webOrigin = validatePublicUrl(input.webOrigin), bridgeOrigin = validatePublicUrl(input.bridgeOrigin);
  const mcp = new URL(input.mcpUrl);
  validatePublicUrl(mcp.origin);
  if (mcp.username || mcp.password || mcp.hash || [...mcp.searchParams.keys()].some(key => /^(?:token|access_token|api_?key|secret|password|authorization)$/i.test(key))) throw new Error('乐享 MCP 地址不能包含认证凭据。');
  if (input.members !== undefined && (!input.members || Array.isArray(input.members) || typeof input.members !== 'object'
    || Object.values(input.members).some(value => typeof value !== 'string' || !value.trim() || value.length > 256))) throw new Error('乐享 members 只能作为显式的成员绑定范围限制。');
  if (typeof input.bridgeSecretFile !== 'string' || !input.bridgeSecretFile) throw new Error('乐享 bridge 需要服务端凭据文件。');
  const bridgeSecretFile = path.resolve(root, input.bridgeSecretFile), stat = fs.lstatSync(bridgeSecretFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (stat.mode & 0o077)) throw new Error('乐享 bridge 凭据必须是权限 0600 的普通文件。');
  const bridgeSecret = fs.readFileSync(bridgeSecretFile, 'utf8').trim();
  if (bridgeSecret.length < 32 || /\s/.test(bridgeSecret)) throw new Error('乐享 bridge 凭据格式无效。');
  const loginOrigins = (input.loginOrigins || [webOrigin]).map(validatePublicUrl);
  const authorizationOrigins = (input.authorizationOrigins || [bridgeOrigin]).map(validatePublicUrl);
  const timeoutMs = input.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) throw new Error('乐享 bridge 超时必须为 100–15000 毫秒。');
  return { mode: 'bridge', webOrigin, bridgeOrigin, mcpUrl: mcp.href, bridgeSecret, members: { ...input.members }, loginOrigins, authorizationOrigins, timeoutMs };
}

export { LexiangHttp } from './lexiang-controller.mjs';
