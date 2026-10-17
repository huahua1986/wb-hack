import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { validatePublicUrl } from '../auth-gateway/src/config.mjs';
import { atomicJson } from './lib.mjs';

const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function page(body) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WorkBuddy 企业配置</title><style>body{margin:0;background:#f3f6f8;color:#183047;font:16px/1.7 system-ui}main{max-width:520px;margin:8vh auto;padding:32px;background:white;border:1px solid #dce4ea;border-radius:16px}h1{font-size:26px}label{display:block;font-weight:600}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #a7b7c4;border-radius:8px;font:inherit}button{padding:12px 18px;margin:20px 8px 0 0;border:0;border-radius:8px;background:#194f76;color:white;font:inherit}small{display:block;color:#607486}p[role=alert]{padding:12px;background:#fff0ef;color:#9c3029}code{font-size:14px}</style></head><body><main>' + body + '</main></body></html>';
}
function form(csrf, error = '') {
  return page('<h1>设置企业认证地址</h1><p>首次设置一次即可。填写管理员提供的认证服务地址，完成后会自动打开 WorkBuddy。</p>' +
    (error ? '<p role="alert">' + escape(error) + '</p>' : '') +
    '<form method="post" action="/setup"><input type="hidden" name="csrf" value="' + csrf + '"><label for="gateway">认证服务地址</label><input id="gateway" name="gateway" type="url" value="http://127.0.0.1:8787" required autocomplete="off"><small>本机测试可保留当前地址；远程服务使用 HTTPS。</small><button name="action" value="save">保存并启动 WorkBuddy</button><button name="action" value="cancel" formnovalidate>稍后设置</button></form><p><small>模型仍通过自定义配置直连。此页面只用于本机设置，不是账号管理后台；页面 5 分钟后失效。</small></p>');
}
export async function requestGateway(directory, { open, timeoutMs = 300000 } = {}) {
  const nonce = random(), csrf = random(), cookie = random(), cookieName = 'wb_setup_' + nonce.slice(0, 12);
  const filename = path.join(directory, 'setup-session.json');
  let origin, settled = false, finish, timer;
  const result = new Promise(resolve => { finish = resolve; });
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'strict-origin'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const send = (status, content) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(content); };
    const handle = async () => {
      if (req.headers.host !== new URL(origin).host) return send(400, page('<h1>无效的页面地址</h1>'));
      const url = new URL(req.url, origin);
      if (url.origin !== origin) return send(400, page('<h1>无效的请求</h1>'));
      if (settled) return send(410, page('<h1>设置已结束，请关闭此页面</h1>'));
      if (req.method === 'GET' && url.pathname === '/setup' && equal(url.searchParams.get('nonce'), nonce)) {
        res.setHeader('Set-Cookie', cookieName + '=' + cookie + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=300');
        return send(200, form(csrf));
      }
      if (req.method !== 'POST' || url.pathname !== '/setup') return send(404, page('<h1>页面不存在</h1>'));
      if (req.headers.origin !== origin || !(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) return send(403, page('<h1>设置来源无效</h1>'));
      const savedCookie = new RegExp('(?:^|;\\s*)' + cookieName + '=([A-Za-z0-9_-]{43})(?:;|$)').exec(req.headers.cookie || '')?.[1];
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 4096) return send(413, page('<h1>输入过长</h1>')); chunks.push(chunk); }
      const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if (body.getAll('csrf').length !== 1 || !equal(body.get('csrf'), csrf) || !equal(savedCookie, cookie)) return send(403, page('<h1>设置页面已失效</h1>'));
      let value;
      if (body.get('action') === 'cancel') value = { cancelled: true };
      else {
        if (body.getAll('gateway').length !== 1) return send(400, form(csrf, '请输入一个认证服务地址。'));
        try { value = { gateway: validatePublicUrl(body.get('gateway')) }; }
        catch { return send(400, form(csrf, '请输入有效的 HTTPS 地址；本机 HTTP 仅允许 loopback，不能带账号、密码、路径或查询参数。')); }
      }
      settled = true;
      res.once('finish', () => finish(value));
      send(200, page(value.cancelled ? '<h1>已暂缓设置</h1><p>重新打开安装入口可继续。</p>' : '<h1>地址已保存</h1><p>正在准备 WorkBuddy，完成后切回工作台即可。首次迁移旧配置可能需要等待。</p><p>此页面现在可以关闭。</p>'));
    };
    handle().catch(() => { if (!res.headersSent) send(500, page('<h1>设置暂不可用，请重新打开安装入口</h1>')); else res.end(); });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = 'http://127.0.0.1:' + server.address().port;
    const url = origin + '/setup?nonce=' + nonce;
    atomicJson(filename, { url, pid: process.pid, nonce });
    timer = setTimeout(() => { settled = true; finish({ cancelled: true }); }, timeoutMs);
    if (open) await open(url);
    return await result;
  } finally {
    clearTimeout(timer);
    server.close(); server.closeAllConnections();
    try { if (JSON.parse(fs.readFileSync(filename, 'utf8')).nonce === nonce) fs.unlinkSync(filename); } catch {}
  }
}
