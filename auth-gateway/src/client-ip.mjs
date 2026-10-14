import { isIP } from 'node:net';

export function normalizeIp(value) {
  if (typeof value !== 'string' || !isIP(value)) throw new Error('Invalid IP address');
  if (isIP(value) === 4) return value;
  const canonical = new URL('http://[' + value + ']/').hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
}

export function requestIp(req, trustedProxyIPs = []) {
  const peer = normalizeIp(req.socket.remoteAddress);
  if (!trustedProxyIPs.includes(peer) || req.headers['x-real-ip'] === undefined) return peer;
  try { return normalizeIp(req.headers['x-real-ip']); }
  catch { const error = new Error('无效的代理来源地址'); error.status = 400; throw error; }
}
