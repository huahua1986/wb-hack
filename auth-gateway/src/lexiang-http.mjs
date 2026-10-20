import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { randomSecret, tokenHash, constantEquals } from './credentials.mjs';
import { validatePublicUrl } from './config.mjs';
import { normalizeLexiangTarget } from './lexiang-config.mjs';

const error = (status, message) => Object.assign(new Error(message), { status });
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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
    return { mode: 'mock' };
  }
  const webOrigin = validatePublicUrl(input.webOrigin), bridgeOrigin = validatePublicUrl(input.bridgeOrigin);
  const mcp = new URL(input.mcpUrl);
  validatePublicUrl(mcp.origin);
  if (mcp.username || mcp.password || mcp.hash || [...mcp.searchParams.keys()].some(key => /^(?:token|access_token|api_?key|secret|password|authorization)$/i.test(key))) throw new Error('乐享 MCP 地址不能包含认证凭据。');
  if (!input.members || Array.isArray(input.members) || typeof input.members !== 'object' || !Object.keys(input.members).length
    || Object.values(input.members).some(value => typeof value !== 'string' || !value.trim() || value.length > 256)) throw new Error('乐享 bridge 必须显式配置每个本地账号的成员映射。');
  if (typeof input.bridgeSecretFile !== 'string' || !input.bridgeSecretFile) throw new Error('乐享 bridge 需要服务端凭据文件。');
  const bridgeSecretFile = path.resolve(root, input.bridgeSecretFile), stat = fs.lstatSync(bridgeSecretFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (stat.mode & 0o077)) throw new Error('乐享 bridge 凭据必须是权限 0600 的普通文件。');
  const bridgeSecret = fs.readFileSync(bridgeSecretFile, 'utf8').trim();
  if (bridgeSecret.length < 32 || /\s/.test(bridgeSecret)) throw new Error('乐享 bridge 凭据格式无效。');
  const loginOrigins = (input.loginOrigins || [webOrigin]).map(validatePublicUrl);
  const timeoutMs = input.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) throw new Error('乐享 bridge 超时必须为 100–15000 毫秒。');
  return { mode: 'bridge', webOrigin, bridgeOrigin, mcpUrl: mcp.href, bridgeSecret, members: { ...input.members }, loginOrigins, timeoutMs };
}

export class LexiangHttp {
  constructor({ config, store, settings, mock, request = fetch }) {
    this.config = config; this.store = store; this.settings = settings; this.request = request;
    if (!settings) return;
    store.db.exec(`CREATE TABLE IF NOT EXISTS lexiang_credentials (
      hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, expires INTEGER NOT NULL, target TEXT);
      CREATE INDEX IF NOT EXISTS lexiang_credential_session ON lexiang_credentials(session_id);
      CREATE TABLE IF NOT EXISTS lexiang_connections (user_id TEXT PRIMARY KEY REFERENCES users(id), enabled INTEGER NOT NULL);`);
    if (settings.mode === 'mock') this.mock = mock;
  }
  clientConfig() {
    if (!this.settings) return { enabled: false };
    return { enabled: true, webOrigin: this.settings.mode === 'mock' ? this.config.publicUrl : this.settings.webOrigin,
      mcpOrigin: this.settings.mode === 'mock' ? this.config.publicUrl : new URL(this.settings.mcpUrl).origin };
  }
  connected(user) {
    return (this.settings.mode === 'mock' || Object.hasOwn(this.settings.members, user.username))
      && this.store.db.prepare('SELECT enabled FROM lexiang_connections WHERE user_id=?').get(user.id)?.enabled !== 0;
  }
  issue(session, kind, ttlSeconds, target = null) {
    const value = 'lx_' + randomSecret(), expires = Math.min(this.store.now() + ttlSeconds * 1000, session.refresh_expires);
    this.store.db.prepare('DELETE FROM lexiang_credentials WHERE expires<=?').run(this.store.now());
    if (this.store.db.prepare('SELECT count(*) AS n FROM lexiang_credentials WHERE session_id=?').get(session.id).n >= 128) throw error(429, '乐享凭据请求过于频繁，请稍后再试');
    this.store.db.prepare('INSERT INTO lexiang_credentials VALUES(?,?,?,?,?)').run(tokenHash(value), session.id, kind, expires, target);
    return { value, expires: Math.floor(expires / 1000) };
  }
  credential(value, kind, consume = false) {
    if (typeof value !== 'string' || !/^lx_[A-Za-z0-9_-]{43}$/.test(value)) throw error(401, '乐享会话已失效');
    return this.store.transaction(() => {
      const item = this.store.db.prepare('SELECT * FROM lexiang_credentials WHERE hash=? AND kind=? AND expires>?').get(tokenHash(value), kind, this.store.now());
      const user = item && this.store.sessionUser(item.session_id);
      if (!item || !user || !this.connected(user)) throw error(401, '乐享会话已失效');
      if (consume) this.store.db.prepare('DELETE FROM lexiang_credentials WHERE hash=?').run(item.hash);
      return { item, user };
    });
  }
  async upstream(url, options) {
    let response;
    try { response = await this.request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(this.settings.timeoutMs) }); }
    catch { throw error(502, '私有乐享服务连接失败或超时'); }
    if (!response.ok) { await response.body?.cancel(); throw error(502, '私有乐享服务返回错误'); }
    const reader = response.body.getReader(); let bytes = 0; const chunks = [];
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 2 * 1024 * 1024) throw error(502, '私有乐享响应过大'); chunks.push(value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (cause) { await reader.cancel().catch(() => {}); if (cause.status) throw cause; throw error(502, '私有乐享响应格式无效'); }
  }
  async bridge(route, user, session, extra = {}) {
    const result = await this.upstream(this.settings.bridgeOrigin + route, { method: 'POST', headers: { Authorization: `Bearer ${this.settings.bridgeSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: this.settings.members[user.username], session_id: session.id, session_expires_at: Math.floor(session.refresh_expires / 1000), ...extra }) });
    if (!result || typeof result !== 'object' || result.code !== undefined && result.code !== 0) throw error(502, '私有乐享 bridge 拒绝了身份交换');
    return result;
  }
  async delegatedToken(user, session) {
    if (this.mock) { const token = this.issue(session, 'access', 300); return { access_token: token.value, expires_at: token.expires, expire_at: token.expires }; }
    const result = await this.bridge('/session', user, session), token = result.data ?? result;
    const expires = token.expires_at;
    if (typeof token.access_token !== 'string' || !token.access_token || token.access_token.length > 16384 || /\s/.test(token.access_token)
      || !Number.isInteger(expires) || expires * 1000 <= this.store.now() || expires * 1000 > this.store.now() + 300000
      || expires * 1000 > session.refresh_expires) throw error(502, '私有乐享 bridge 未返回有效的用户短期凭据');
    return { access_token: token.access_token, expires_at: expires, expire_at: expires };
  }
  async handle(req, res, { url, requireAccount, readBody }) {
    const route = url.pathname;
    const oauth = /^\/v2\/as\/connector\/oauth\/(?:lexiang-ol|lexiang)\/(status|start|accesstoken|temp-login-url|revoke|oauthuser)$/.exec(route);
    const mcp = /^\/console\/agent-gateway\/lexiang-ol(?:\/api)?\/mcp$/.test(route);
    const enterprise = /^\/console\/enterprises\/[^/]+\/lexiang\/temp-login-url$/.test(route);
    const mockRoute = route.startsWith('/spapi/') || route === '/private/lexiang/login' || route === '/wb' || route === '/'
      || /^\/(?:pages|spaces|t|s)\//.test(route);
    if (!oauth && !mcp && !enterprise && !['/private/lexiang/config', '/private/lexiang/bridge/introspect'].includes(route) && !(this.mock && mockRoute)) return false;
    if (!this.settings) throw error(501, '当前服务未配置私有乐享');
    const reply = (data, raw = false) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(raw ? data : { code: 0, msg: '', data })); return true; };
    if (route === '/private/lexiang/bridge/introspect') {
      if (this.settings.mode !== 'bridge') throw error(404, '未启用乐享 bridge');
      if (req.method !== 'POST') throw error(405, '只允许 POST');
      const serviceToken = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
      if (!constantEquals(serviceToken || '', this.settings.bridgeSecret)) throw error(401, '无效的服务凭据');
      const input = await readBody(req);
      if (typeof input.session_id !== 'string' || input.session_id.length > 128 || typeof input.subject !== 'string' || input.subject.length > 256) throw error(400, '无效的会话校验参数');
      const member = this.store.sessionUser(input.session_id);
      const active = !!member && this.connected(member) && this.settings.members[member.username] === input.subject;
      return reply({ active, ...(active ? { expires_at: Math.floor(member.refresh_expires / 1000) } : {}) });
    }
    if (this.mock && mockRoute) return this.handleMock(req, res, url, reply, readBody);
    const account = requireAccount(req);
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    const session = this.store.sessionForAccessToken(token), user = session && this.store.sessionUser(session.id);
    if (!session || !user || account.uid !== user.id) throw error(401, '登录已失效');
    if (route === '/private/lexiang/config' && req.method === 'GET') return reply({ client: this.clientConfig(), mode: this.settings.mode });
    const operation = oauth?.[1];
    if (operation === 'status' && req.method === 'GET') return reply({ status: this.connected(user) ? 'connected' : 'disconnected', connected_at: Math.floor(this.store.now() / 1000) });
    if (operation === 'revoke' && req.method === 'POST') {
      await readBody(req);
      this.store.db.prepare('INSERT INTO lexiang_connections VALUES(?,0) ON CONFLICT(user_id) DO UPDATE SET enabled=0').run(user.id);
      this.store.db.prepare('DELETE FROM lexiang_credentials WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?)').run(user.id);
      this.store.audit('lexiang_disconnected', user.username, session.id);
      return reply({ status: 'ok', revoked_count: 1 });
    }
    if (operation === 'start' && req.method === 'POST') {
      await readBody(req);
      if (!this.mock && !Object.hasOwn(this.settings.members, user.username)) throw error(403, '当前账号未配置乐享成员映射');
      this.store.db.prepare('INSERT INTO lexiang_connections VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET enabled=1').run(user.id);
      this.store.audit('lexiang_connected', user.username, session.id);
      return reply({ next_action: 'connected', request_id: randomUUID(), auth_type: 'oauth', expire_at: Math.floor(session.refresh_expires / 1000) });
    }
    if (!this.connected(user)) throw error(403, '当前账号尚未连接私有乐享');
    if (operation === 'oauthuser' && req.method === 'GET') return reply({ user: { id: this.mock ? user.id : this.settings.members[user.username], name: user.nickname } });
    if (operation === 'accesstoken' && req.method === 'GET') return reply(await this.delegatedToken(user, session));
    if ((operation === 'temp-login-url' || enterprise) && req.method === 'POST') {
      const input = await readBody(req), target = normalizeLexiangTarget(input.intend_url, this.clientConfig().webOrigin);
      if (!/^\/(?:$|wb(?:\/|$)|pages\/|spaces\/|t\/|s\/)/.test(new URL(target).pathname)) throw error(400, '不支持的乐享页面路径');
      if (this.mock) {
        const ticket = this.issue(session, 'ticket', 60, target);
        return reply({ login_url: this.config.publicUrl + '/private/lexiang/login?ticket=' + ticket.value });
      }
      const result = await this.bridge('/login-url', user, session, { intend_url: target }), login = result.data?.login_url ?? result.login_url;
      let parsed; try { parsed = new URL(login); } catch { throw error(502, '乐享 bridge 登录地址无效'); }
      if (parsed.username || parsed.password || !this.settings.loginOrigins.includes(parsed.origin)) throw error(502, '乐享 bridge 返回未允许的登录地址');
      return reply({ login_url: parsed.href });
    }
    if (mcp && req.method === 'POST') {
      const input = await readBody(req);
      if (input.method !== 'tools/call' || input.params?.name !== 'call_rpc' || !input.params?.arguments || typeof input.params.arguments.tool_name !== 'string'
        || typeof input.params.arguments.arguments !== 'object' || Array.isArray(input.params.arguments.arguments) || !input.params.arguments.arguments) throw error(400, '不支持的乐享 MCP 请求');
      if (this.mock) return reply({ jsonrpc: '2.0', id: input.id, result: { content: [{ type: 'text', text: JSON.stringify({ code: 0, data: this.mock.tool(user, input.params.arguments.tool_name, input.params.arguments.arguments) }) }] } }, true);
      const delegated = await this.delegatedToken(user, session);
      const result = await this.upstream(this.settings.mcpUrl, { method: 'POST', headers: { Authorization: `Bearer ${delegated.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      return reply(result, true);
    }
    throw error(405, '不支持的乐享请求方法');
  }
  async handleMock(req, res, url, reply, readBody) {
    if (url.pathname === '/private/lexiang/login' && req.method === 'GET') {
      const { item } = this.credential(url.searchParams.get('ticket'), 'ticket', true);
      const existing = /(?:^|;\s*)wb_lexiang=([^;]*)/.exec(req.headers.cookie || '')?.[1];
      let browser;
      if (existing) {
        try {
          const previous = this.credential(existing, 'browser').item;
          if (previous.session_id === item.session_id) {
            if (previous.expires > this.store.now() + 60000) browser = { value: existing, expires: Math.floor(previous.expires / 1000) };
            else this.store.db.prepare('DELETE FROM lexiang_credentials WHERE hash=?').run(previous.hash);
          }
        } catch (cause) { if (cause.status !== 401) throw cause; }
      }
      browser ||= this.issue({ id: item.session_id, refresh_expires: this.store.sessionUser(item.session_id).refresh_expires }, 'browser', 3600);
      const maxAge = Math.max(0, browser.expires - Math.floor(this.store.now() / 1000));
      res.setHeader('Set-Cookie', `wb_lexiang=${browser.value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${this.config.publicUrl.startsWith('https:') ? '; Secure' : ''}`);
      res.writeHead(303, { Location: item.target }); res.end(); return true;
    }
    if (url.pathname.startsWith('/spapi/')) {
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
      const { user } = this.credential(token, 'access');
      if (req.method !== 'GET' && !(req.method === 'POST' && url.pathname === '/spapi/search/v1/kb/search')) throw error(405, 'Mock 不支持此写入操作');
      return reply(this.mock.api(user, url, req.method === 'POST' ? await readBody(req) : {}));
    }
    if (req.method !== 'GET') throw error(405, '不支持的页面请求');
    const cookie = /(?:^|;\s*)wb_lexiang=([^;]*)/.exec(req.headers.cookie || '')?.[1];
    const { user } = this.credential(cookie, 'browser');
    const { entries } = this.mock.data(user);
    const match = /^\/pages\/([^/]+)$/.exec(url.pathname);
    const doc = match ? this.mock.document(user, decodeURIComponent(match[1])) : undefined;
    if (match && !doc) throw error(404, 'Mock 知识不存在或无权访问');
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self' file:; form-action 'none'; base-uri 'none'");
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(doc?.name || '私有乐享 Mock')}</title><style>body{font:16px/1.8 system-ui;margin:40px auto;max-width:900px;padding:24px;color:#243342}aside{background:#eaf4f0;padding:12px 18px;border-radius:8px;color:#176343}h1{font-size:28px}a{color:#146c77}p{white-space:pre-wrap}</style><aside>本地 Mock 乐享 · 仅用于验证 · 当前账号：${escape(user.nickname)}</aside><h1>${escape(doc?.name || '私有乐享知识库')}</h1>${doc ? '<p>' + escape(doc.body) + '</p><a href="/wb">返回知识库</a>' : '<ul>' + entries.map(entry => `<li><a href="/pages/${encodeURIComponent(entry.id)}">${escape(entry.name)}</a></li>`).join('') + '</ul>'}</html>`);
    return true;
  }
}
