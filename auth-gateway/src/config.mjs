import path from 'node:path';
import fs from 'node:fs';
import { normalizeIp } from './client-ip.mjs';

export function validatePublicUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('GATEWAY_PUBLIC_URL must be an origin without credentials, path, query, or fragment');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Use HTTPS for a public gateway; HTTP is limited to loopback development');
  }
  return url.origin;
}

function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${name}`);
  return parsed;
}

export function readConfig(env = process.env) {
  const port = integer(env.GATEWAY_PORT, 8787, 1, 65535, 'GATEWAY_PORT');
  const trustedProxyIPs = [...new Set((env.GATEWAY_TRUSTED_PROXY_IPS || '').split(',').filter(Boolean).map(value => normalizeIp(value.trim())))];
  const dataDir = path.resolve(env.GATEWAY_DATA_DIR || './data');
  let productName = env.GATEWAY_PRODUCT_NAME;
  if (productName === undefined) {
    try { productName = JSON.parse(fs.readFileSync(path.join(dataDir, 'product-branding.json'), 'utf8')).productName; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid product-branding.json'); }
  }
  if (productName !== undefined && (typeof productName !== 'string' || !productName.trim() || productName.length > 128 || /[\u0000-\u001f\u007f]/.test(productName))) throw new Error('Invalid product name');
  return {
    host: env.GATEWAY_HOST || '127.0.0.1',
    port,
    publicUrl: validatePublicUrl(env.GATEWAY_PUBLIC_URL || `http://127.0.0.1:${port}`),
    dataDir,
    productName: productName?.trim(),
    accessTtlSeconds: integer(env.GATEWAY_ACCESS_TTL_SECONDS, 3600, 60, 86400, 'access TTL'),
    refreshTtlSeconds: integer(env.GATEWAY_REFRESH_TTL_SECONDS, 1209600, 3600, 2592000, 'refresh TTL'),
    loginTtlSeconds: 300,
    trustedProxyIPs,
    auditRetentionDays: integer(env.GATEWAY_AUDIT_RETENTION_DAYS, 90, 1, 3650, 'audit retention days'),
  };
}
