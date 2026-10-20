import { validatePublicUrl } from './config.mjs';

export const LEXIANG_PUBLIC_HOSTS = Object.freeze(['lexiangla.com', 'lexiangla.net', 'lexiang-app.com', 'lexiang.tencent.com']);

export function normalizeLexiangClient(value) {
  if (value === undefined) return undefined;
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('lexiang 必须是配置对象。');
  for (const key of Object.keys(value)) if (!['enabled', 'webOrigin', 'mcpOrigin'].includes(key)) throw new Error('lexiang 包含不支持的配置项；客户端不得配置认证凭据。');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('lexiang.enabled 必须是布尔值。');
  if (value.enabled === false) return { enabled: false };
  const webOrigin = validatePublicUrl(value.webOrigin);
  const mcpOrigin = validatePublicUrl(value.mcpOrigin || webOrigin);
  return { enabled: true, webOrigin, mcpOrigin };
}

export function privateLexiangProduct(value) {
  const config = normalizeLexiangClient(value);
  if (!config) return {};
  return config.enabled ? {
    privateHost: { lexiangHost: config.webOrigin, lexiangMCP: config.mcpOrigin },
    productFeatures: { TencentLexiangKnowledge: true },
  } : { productFeatures: { TencentLexiangKnowledge: false } };
}

// Only known Lexiang web hosts are remapped. Model URLs and other services are untouched.
export function rewriteLexiangUrl(value, webOrigin) {
  if (typeof value !== 'string') return value;
  let url; try { url = new URL(value); } catch { return value; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return value;
  if (!LEXIANG_PUBLIC_HOSTS.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return value;
  const target = new URL(webOrigin);
  target.pathname = url.pathname;
  for (const [key, item] of url.searchParams) {
    if (!/^(?:company_from|sso_auth_code|auth_token|access_token|refresh_token|code|state|ticket|token|authorization|api_?key|password|secret|signature)$/i.test(key)) target.searchParams.append(key, item);
  }
  // OAuth implicit-flow credentials can also be carried in URL fragments.
  target.hash = '';
  return target.href;
}

export function normalizeLexiangTarget(value, webOrigin) {
  if (typeof value !== 'string' || value.length > 4096) throw Object.assign(new Error('无效的乐享目标地址'), { status: 400 });
  let original; try { original = new URL(value); } catch { throw Object.assign(new Error('无效的乐享目标地址'), { status: 400 }); }
  if (original.username || original.password) throw Object.assign(new Error('乐享目标地址不能包含凭据'), { status: 400 });
  const target = new URL(rewriteLexiangUrl(value, webOrigin));
  if (target.origin !== webOrigin || !['http:', 'https:'].includes(target.protocol)) throw Object.assign(new Error('乐享目标地址不在配置的私有服务内'), { status: 400 });
  // Reissue identity through the configured backend, never copy stale public credentials.
  for (const key of [...target.searchParams.keys()]) if (/^(?:auth_token|access_token|refresh_token|code|state|ticket|token|sso_auth_code|authorization|api_?key|password|secret|signature)$/i.test(key)) target.searchParams.delete(key);
  target.hash = '';
  return target.href;
}
