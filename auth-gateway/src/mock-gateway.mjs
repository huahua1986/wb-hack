import fs from 'node:fs';
import path from 'node:path';
import { createGateway } from './gateway.mjs';
import { csrfToken, constantEquals, hashPassword, isLoginState, randomSecret } from './credentials.mjs';
import { completePage, expiredPage } from './html.mjs';
import { SessionConflictError } from './store.mjs';

function mockForm(state, csrf) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WorkBuddy 本地 Mock 登录</title><link rel="stylesheet" href="/login/style.css"></head><body><main><section class="card"><div class="brand"><span class="mark" aria-hidden="true">W</span>WORKBUDDY 本地 MOCK</div><h1>模拟登录</h1><p>使用一次性本地测试身份完成客户端登录。这里不连接真实账号系统，无需输入密码。</p><form method="post" action="/mock/login"><input type="hidden" name="state" value="${state}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">以 Mock 测试账号登录</button></form><p class="hint">仅限本机协议验证，不代表腾讯账号或模型权限。</p></section></main></body></html>`;
}

function headers(res) {
  res.setHeader('Cache-Control', 'no-store');
  // no-referrer can turn a browser form POST's Origin into null. Omit paths/queries while preserving its origin.
  res.setHeader('Referrer-Policy', 'strict-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
}
function page(res, status, html) { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); }
function failure(res, status, message) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ code: status, msg: message })); }

export async function createMockGateway(config, { logger = () => {}, now = Date.now } = {}) {
  const origin = new URL(config.publicUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.protocol !== 'http:') throw new Error('Mock 网关只允许本机 HTTP loopback 地址。');
  const marker = path.join(config.dataDir, 'mock-mode.json');
  if (fs.existsSync(config.dataDir) && fs.readdirSync(config.dataDir).length) {
    if (!fs.existsSync(marker)) throw new Error('拒绝把已有账号数据库切换为 mock，请使用独立 mock-data 目录。');
    const value = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (value.kind !== 'workbuddy-loopback-mock' || value.version !== 1) throw new Error('Mock 数据目录标记无效。');
  } else {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, JSON.stringify({ kind: 'workbuddy-loopback-mock', version: 1 }), { flag: 'wx', mode: 0o600 });
  }
  const app = await createGateway(config, { logger, now, allowMockData: true });
  const username = 'mock-user';
  if (!app.store.getUser(username)) app.store.addUser(username, 'Mock 测试账号', await hashPassword(randomSecret()));
  const mockUser = app.store.getUser(username);
  const normalRequest = app.server.listeners('request')[0];
  app.server.removeAllListeners('request');
  let pendingGrants = 0;
  const mockRequest = async (req, res) => {
    const url = new URL(req.url, config.publicUrl);
    if (!(req.method === 'GET' && url.pathname === '/login') && !(req.method === 'POST' && url.pathname === '/mock/login')) {
      return normalRequest(req, res);
    }
    headers(res);
    let status = 200;
    try {
      if (req.headers.host !== new URL(config.publicUrl).host) throw { status: 400, message: '无效的服务地址' };
      if (req.method === 'GET') {
        const state = url.searchParams.get('state'), pending = app.store.getLoginState(state);
        if (!pending) { status = 410; return page(res, status, expiredPage()); }
        if (pending.delivery) return page(res, 200, completePage());
        const nonce = randomSecret();
        res.setHeader('Set-Cookie', `wb_mock_login=${nonce}; Max-Age=300; Path=/; HttpOnly; SameSite=Strict`);
        return page(res, 200, mockForm(state, csrfToken(app.store.key, state, nonce)));
      }
      if (req.headers.origin && req.headers.origin !== config.publicUrl) throw { status: 403, message: '无效的来源' };
      if (pendingGrants >= 4) throw { status: 429, message: '请稍后重试' };
      pendingGrants++;
      try {
        if (!(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) throw { status: 415, message: '无效的表单类型' };
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 4096) throw { status: 413, message: '表单过大' }; chunks.push(chunk); }
        const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const state = body.get('state'), csrf = body.get('csrf');
        const nonce = /(?:^|;\s*)wb_mock_login=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
        if (body.getAll('state').length !== 1 || body.getAll('csrf').length !== 1 || !isLoginState(state) || !nonce || !constantEquals(csrf, csrfToken(app.store.key, state, nonce))) throw { status: 403, message: 'Mock 登录表单无效' };
        if (!app.store.grantLogin(state, mockUser.id)) { status = 410; return page(res, status, expiredPage()); }
        res.setHeader('Set-Cookie', 'wb_mock_login=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict');
        status = 303; res.writeHead(status, { Location: '/login/complete' }); res.end();
      } finally { pendingGrants--; }
    } catch (error) {
      status = error instanceof SessionConflictError ? 409 : error.status || 500;
      if (!res.headersSent) failure(res, status, status === 409 || error.status ? error.message : 'Mock 服务暂不可用'); else res.end();
    } finally { logger({ method: req.method, route: url.pathname, status, mode: 'mock' }); }
  };
  app.server.on('request', (req, res) => mockRequest(req, res).catch(() => { if (!res.headersSent) failure(res, 500, 'Mock 服务暂不可用'); else res.end(); }));
  return app;
}
