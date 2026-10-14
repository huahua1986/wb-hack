import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AuthStore, SessionConflictError } from './store.mjs';
import { constantEquals, csrfToken, hashPassword, isLoginState, normalizeUsername, randomSecret, verifyPassword } from './credentials.mjs';
import { compatibilityConfiguration } from './compatibility.mjs';
import { completePage, expiredPage, loginCss, loginPage } from './html.mjs';
import { requestIp } from './client-ip.mjs';
import { CatalogStore } from './catalog-store.mjs';
import { ContentHttp } from './content-http.mjs';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

class RateLimiter {
  constructor(store) { this.store = store; }
  check(key, limit, window = 300000) {
    if (!this.store.checkRateLimit(key, limit, window)) throw new HttpError(429, '请求过于频繁，请稍后再试');
  }
}

function json(res, status, code, data, msg = '') {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code, msg, ...(data === undefined ? {} : { data }) }));
}
function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body);
}
function accessToken(req) {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization || ''); return match?.[1];
}
function cookies(req) {
  const result = {};
  for (const item of (req.headers.cookie || '').split(';')) {
    const at = item.indexOf('=');
    if (at >= 0) result[item.slice(0, at).trim()] = item.slice(at + 1).trim();
  }
  return result;
}

async function body(req, form = false) {
  const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
  if (form ? contentType !== 'application/x-www-form-urlencoded' : contentType && contentType !== 'application/json') {
    throw new HttpError(415, '不支持的请求类型');
  }
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new HttpError(413, '请求内容过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (form) {
    const values = new URLSearchParams(text);
    for (const name of ['state', 'csrf', 'username', 'password']) if (values.getAll(name).length !== 1) throw new HttpError(400, '无效的登录表单');
    return Object.fromEntries(values);
  }
  try {
    const value = text ? JSON.parse(text) : {};
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw new HttpError(400, '无效的 JSON'); }
}

export async function createGateway(config, { now = Date.now, logger = () => {}, allowMockData = false } = {}) {
  const store = new AuthStore(config, now, { allowMockData });
  let catalog;
  try {
    store.reconcileActiveSessions();
    catalog = new CatalogStore(config, { db: store.db, key: store.key, now });
  }
  catch (error) { store.close(); throw error; }
  const content = new ContentHttp({ config, store, catalog, now });
  const limiter = new RateLimiter(store);
  const dummyPasswordHash = await hashPassword(randomSecret());
  let verifying = 0;
  const cookieName = new URL(config.publicUrl).protocol === 'https:' ? '__Host-wb_login' : 'wb_login';
  const cookieOptions = `Path=/; HttpOnly; SameSite=Strict${new URL(config.publicUrl).protocol === 'https:' ? '; Secure' : ''}`;
  const requireAccount = req => {
    const account = store.account(accessToken(req));
    if (!account) throw new HttpError(401, '登录已失效');
    return account;
  };

  const handler = async (req, res) => {
    const startedAt = performance.now();
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    // Keep form POST origins usable without exposing login state in referrer paths or queries.
    res.setHeader('Referrer-Policy', 'strict-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (new URL(config.publicUrl).protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    let route = 'invalid';
    try {
      if (req.headers.host !== new URL(config.publicUrl).host) throw new HttpError(400, '无效的服务地址');
      const url = new URL(req.url, config.publicUrl); route = url.pathname;
      const ip = requestIp(req, config.trustedProxyIPs);
      if (req.method === 'GET' && route === '/healthz') {
        store.db.prepare('SELECT 1').get();
        return json(res, 200, 0, { status: 'ok', service: 'workbuddy-auth', schema: 2, contentSchema: 1, sessionPolicy: 'single-session-reject' });
      }
      if (req.method === 'GET' && route === '/login/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }); return res.end(loginCss);
      }
      if (req.method === 'POST' && route === '/v2/plugin/auth/state') {
        limiter.check(`state:${ip}`, 120);
        if (url.searchParams.get('platform') !== 'workbuddy') throw new HttpError(400, '仅支持 WorkBuddy 登录');
        await body(req);
        const state = store.createLoginState();
        return json(res, 200, 0, { state, authUrl: `${config.publicUrl}/login?state=${state}` });
      }
      if (req.method === 'GET' && route === '/login') {
        const state = url.searchParams.get('state');
        const pending = store.getLoginState(state);
        if (!pending) return html(res, 410, expiredPage());
        if (pending.delivery) return html(res, 200, completePage());
        const nonce = randomSecret();
        res.setHeader('Set-Cookie', `${cookieName}=${nonce}; Max-Age=300; ${cookieOptions}`);
        return html(res, 200, loginPage(state, csrfToken(store.key, state, nonce)));
      }
      if (req.method === 'GET' && route === '/login/complete') return html(res, 200, completePage());
      if (req.method === 'POST' && route === '/login') {
        if (req.headers.origin && req.headers.origin !== config.publicUrl) throw new HttpError(403, '登录来源无效');
        const input = await body(req, true), nonce = cookies(req)[cookieName];
        if (!isLoginState(input.state) || !nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce)
          || !constantEquals(input.csrf, csrfToken(store.key, input.state, nonce))) throw new HttpError(403, '登录表单已失效，请重新打开登录链接');
        if (!store.getLoginState(input.state)) return html(res, 410, expiredPage());
        limiter.check(`login:${ip}`, 60);
        let username;
        try { username = normalizeUsername(input.username); } catch { username = ''; }
        limiter.check(`user:${username}`, 10);
        if (verifying >= 4) throw new HttpError(429, '登录请求较多，请稍后重试');
        const user = username ? store.getUser(username) : undefined;
        let valid;
        verifying++;
        try { valid = await verifyPassword(input.password, user?.password_hash || dummyPasswordHash); }
        finally { verifying--; }
        if (!valid || !user || user.disabled) {
          store.audit('login_failed', username || null, null, { actor: 'browser', sourceIp: ip });
          return html(res, 401, loginPage(input.state, input.csrf, '账号或密码不正确'));
        }
        try {
          if (!store.grantLogin(input.state, user.id, { expectedPasswordHash: user.password_hash, sourceIp: ip })) return html(res, 410, expiredPage());
        } catch (error) {
          if (error instanceof SessionConflictError) return html(res, 409, loginPage(input.state, input.csrf, error.message));
          throw error;
        }
        res.setHeader('Set-Cookie', `${cookieName}=; Max-Age=0; ${cookieOptions}`);
        res.writeHead(303, { Location: '/login/complete' }); return res.end();
      }
      if (req.method === 'GET' && route === '/v2/plugin/auth/token') {
        limiter.check(`poll:${ip}`, 2000);
        const result = store.pollLogin(url.searchParams.get('state'));
        if (result.status === 'pending') return json(res, 200, 11217, undefined, '等待网页登录');
        if (result.status === 'expired') throw new HttpError(410, '登录状态已失效，请重新登录');
        return json(res, 200, 0, result.auth);
      }
      if (req.method === 'GET' && route === '/v2/plugin/account') return json(res, 200, 0, requireAccount(req));
      if (req.method === 'POST' && route === '/v2/plugin/auth/token/refresh') {
        limiter.check(`refresh:${ip}`, 600); await body(req);
        const auth = store.refresh(req.headers['x-refresh-token']);
        if (!auth) throw new HttpError(401, '登录已失效，请重新登录');
        return json(res, 200, 0, auth);
      }
      if (req.method === 'POST' && route === '/v2/plugin/account/switch') {
        const account = requireAccount(req), input = await body(req);
        if (Object.keys(input).length) throw new HttpError(403, '此网关仅提供本地个人账号');
        const auth = store.refresh(req.headers['x-refresh-token'], account.uid);
        if (!auth) throw new HttpError(401, '登录已失效');
        return json(res, 200, 0, auth);
      }
      if (req.method === 'POST' && route === '/v2/plugin/auth/logout') {
        await body(req); store.revoke(req.headers['x-refresh-token']); return json(res, 200, 0, {});
      }
      if (req.method === 'GET' && ['/v1/config', '/v2/config', '/v3/config'].includes(route)) {
        return json(res, 200, 0, compatibilityConfiguration(config.productName));
      }
      if (req.method === 'POST' && route === '/v2/feature-flag/api/product-config') {
        requireAccount(req);
        // The desktop sends an empty POST with a form Content-Type. The input
        // never changes branding, but still enforce the normal request size cap.
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 16384) throw new HttpError(413, '请求内容过大');
        }
        // The original desktop filters productName from /v3/config, but accepts
        // it through this product overlay protocol. Never supply model changes.
        return json(res, 200, 0, config.productName
          ? { exp_id: 'private-product-branding', value: { productName: config.productName } }
          : {});
      }
      if (await content.handle(req, res, { url, requireAccount, readBody: body })) return;
      if (req.method === 'POST' && /^\/console\/as\/netdrive\/(?:projects\/[^/]+\/)?access-token$/.test(route)) {
        requireAccount(req); await body(req);
        // Empty successful tokens make the original SDK fall back to Tencent's host.
        return json(res, 501, 'NETDRIVE_DISABLED', null, '当前服务未启用云端网盘');
      }
      if (/chat\/completions|\/responses|\/messages|^\/v[123]\/chat\//.test(route)) {
        throw new HttpError(501, '认证网关不提供模型服务，请选择已配置的自定义模型');
      }
      req.resume(); throw new HttpError(404, '此认证网关不提供该接口');
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, error.status || 500, undefined, error.status ? error.message : '服务暂不可用');
      else res.end();
    } finally {
      // Never log query strings, request bodies, credentials, or tokens.
      logger({ requestId, method: req.method, route, status: res.statusCode, durationMs: Math.round(performance.now() - startedAt) });
    }
  };
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    handler(req, res).catch(() => { if (!res.headersSent) json(res, 500, 500, undefined, '服务暂不可用'); else res.end(); });
  });
  const timer = setInterval(() => { try { store.cleanup(); } catch { logger({ event: 'cleanup_failed' }); } }, 60000);
  timer.unref();
  return {
    server, store, catalog, config,
    async close() { clearInterval(timer); if (server.listening) await new Promise(resolve => server.close(resolve)); store.close(); },
  };
}
