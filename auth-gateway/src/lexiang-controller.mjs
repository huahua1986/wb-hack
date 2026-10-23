import { createHash, randomUUID } from 'node:crypto';
import { constantEquals, csrfToken, normalizeUsername, randomSecret, tokenHash, unseal } from './credentials.mjs';
import { normalizeLexiangTarget } from './lexiang-config.mjs';
import { LexiangAuthStore, lexiangAuthError as error, authorizationRequired } from './lexiang-auth-store.mjs';
import { lexiangLoginPage, lexiangConsentPage, lexiangAuthorizationComplete, lexiangAuthorizationExpired, lexiangScriptCsp } from './lexiang-auth-html.mjs';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cookie = (req, name) => (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(name + '='))?.slice(name.length + 1);

export class LexiangHttp {
  constructor({ config, store, settings, mock, request = fetch }) {
    this.config = config; this.store = store; this.settings = settings; this.mock = mock; this.request = request;
    this.refreshing = new Map(); this.verifying = 0;
    if (settings) this.auth = new LexiangAuthStore(store);
  }
  clientConfig() {
    if (!this.settings) return { enabled: false };
    return { enabled: true, webOrigin: this.mock ? this.config.publicUrl : this.settings.webOrigin, mcpOrigin: this.mock ? this.config.publicUrl : new URL(this.settings.mcpUrl).origin };
  }
  validBinding(binding, user) {
    return !!binding && binding.provider === this.settings.mode && binding.refresh_expires > this.store.now()
      && (!this.settings.members?.[user.username] || this.settings.members[user.username] === binding.subject)
      && (!this.mock || this.mock.validBinding(binding));
  }
  binding(user) {
    const binding = this.auth.binding(user.id);
    if (!this.validBinding(binding, user)) throw authorizationRequired();
    return binding;
  }
  credential(value, kind, consume = false) {
    if (typeof value !== 'string' || !/^lx_[A-Za-z0-9_-]{43}$/.test(value)) throw error(401, '乐享访问凭据已失效');
    return this.store.transaction(() => {
      const item = this.store.db.prepare('SELECT * FROM lexiang_credentials WHERE hash=? AND kind=? AND expires>?').get(tokenHash(value), kind, this.store.now());
      const user = item && this.store.sessionUser(item.session_id), binding = user && this.auth.binding(user.id);
      if (!item || !user || !this.validBinding(binding, user) || binding.id !== item.binding_id) throw error(401, '乐享访问凭据已失效');
      if (consume) this.store.db.prepare('DELETE FROM lexiang_credentials WHERE hash=?').run(item.hash);
      return { item, user, binding, member: this.mock?.member(binding.subject) };
    });
  }
  async upstream(url, options) {
    let response;
    try { response = await this.request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(this.settings.timeoutMs) }); }
    catch { throw error(502, '私有乐享服务连接失败或超时'); }
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(error(502, '私有乐享服务返回错误'), { upstreamStatus: response.status }); }
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2 * 1024 * 1024) throw error(502, '私有乐享响应过大'); chunks.push(value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (cause) { await reader.cancel().catch(() => {}); if (cause.status) throw cause; throw error(502, '私有乐享响应格式无效'); }
  }
  async bridge(route, body) {
    const result = await this.upstream(this.settings.bridgeOrigin + route, { method: 'POST', headers: { Authorization: `Bearer ${this.settings.bridgeSecret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (result?.error === 'invalid_grant' || result?.code === 'LEXIANG_AUTH_EXPIRED') throw authorizationRequired();
    if (!result || typeof result !== 'object' || result.code !== undefined && result.code !== 0) throw error(502, '私有乐享 bridge 拒绝了请求');
    return result.data ?? result;
  }
  validateGrant(grant, expectedSubject = undefined) {
    if (!grant || typeof grant.subject !== 'string' || !grant.subject.trim() || grant.subject.length > 256 || expectedSubject && grant.subject !== expectedSubject
      || typeof grant.refresh_token !== 'string' || !grant.refresh_token || grant.refresh_token.length > 16384 || /\s/.test(grant.refresh_token)
      || !Number.isInteger(grant.refresh_expires_at) || grant.refresh_expires_at * 1000 <= this.store.now() || grant.refresh_expires_at * 1000 > this.store.now() + 30 * 86400000
      || grant.display_name !== undefined && (typeof grant.display_name !== 'string' || grant.display_name.length > 256)) throw error(502, '乐享授权结果缺少有效的成员或刷新凭据');
    return grant;
  }
  async delegatedToken(user, session, force = false) {
    const binding = this.binding(user);
    const cached = !force && this.auth.cached(binding, session); if (cached) return cached;
    const key = binding.id + ':' + session.id;
    if (this.refreshing.has(key)) return this.refreshing.get(key);
    const task = (async () => {
      let result;
      if (this.mock) {
        result = this.store.transaction(() => {
          const current = this.binding(user); if (current.id !== binding.id) throw authorizationRequired();
          const grant = this.mock.refresh(this.auth.refreshToken(current), binding.id);
          const issued = this.auth.issue(session, current, 'access', this.settings.accessTtlSeconds);
          const token = { access_token: issued.value, expires_at: issued.expires, expire_at: issued.expires };
          this.auth.cache(current, session, token, grant.refresh_token, grant.refresh_expires_at); return token;
        });
      } else {
        const grant = this.validateGrant(await this.bridge('/refresh', { subject: binding.subject, binding_id: binding.id, session_id: session.id, refresh_token: this.auth.refreshToken(binding) }), binding.subject);
        if (typeof grant.access_token !== 'string' || !grant.access_token || /\s/.test(grant.access_token) || grant.access_token.length > 16384
          || !Number.isInteger(grant.expires_at) || grant.expires_at * 1000 <= this.store.now() || grant.expires_at * 1000 > this.store.now() + 300000
          || grant.expires_at * 1000 > Math.min(session.refresh_expires, grant.refresh_expires_at * 1000)) throw error(502, '私有乐享 bridge 未返回有效的用户短期凭据');
        const current = this.binding(user); if (current.id !== binding.id) throw authorizationRequired();
        result = { access_token: grant.access_token, expires_at: grant.expires_at, expire_at: grant.expires_at };
        this.auth.cache(current, session, result, grant.refresh_token, grant.refresh_expires_at);
        // Keep the rotated B grant, but never deliver its access token to a revoked A session.
        if (!this.store.sessionUser(session.id)) throw error(403, 'WorkBuddy 会话已失效，请重新登录');
      }
      this.store.audit('lexiang_token_refreshed', user.username, session.id); return result;
    })();
    this.refreshing.set(key, task);
    try { return await task; }
    catch (cause) { if (cause.lexiangAuthorizationRequired && this.auth.binding(user.id)?.id === binding.id) this.auth.revoke(user.id); throw cause; }
    finally { if (this.refreshing.get(key) === task) this.refreshing.delete(key); }
  }
  page(res, html, status = 200) {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src ${lexiangScriptCsp}; connect-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self' file:; form-action 'self'; base-uri 'none'`);
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return true;
  }
  async authorize(req, res, url, readBody) {
    const name = this.config.publicUrl.startsWith('https:') ? '__Host-lx_authorize' : 'lx_authorize';
    const flags = `Path=/; HttpOnly; SameSite=Lax${this.config.publicUrl.startsWith('https:') ? '; Secure' : ''}`;
    const input = req.method === 'POST' ? await readBody(req, true, ['state', 'csrf', 'action']) : null;
    const state = input?.state ?? url.searchParams.get('state');
    let pending; try { pending = this.auth.authorization(state, ['pending', 'authenticated', 'complete']); }
    catch (cause) { if (cause.status !== 410) throw cause; return this.page(res, lexiangAuthorizationExpired(), 410); }
    if (pending.row.phase === 'complete') return this.page(res, lexiangAuthorizationComplete());
    let nonce = cookie(req, name);
    if (req.method === 'GET') {
      if (!pending.row.browser_hash) {
        nonce = randomSecret(); this.store.db.prepare('UPDATE lexiang_authorizations SET browser_hash=? WHERE hash=? AND browser_hash IS NULL').run(tokenHash(nonce), pending.row.hash);
      } else if (!nonce || tokenHash(nonce) !== pending.row.browser_hash) throw error(403, '请在最初打开的乐享授权窗口中继续');
      res.setHeader('Set-Cookie', `${name}=${nonce}; Max-Age=300; ${flags}`);
    } else if (req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== this.config.publicUrl || !nonce || tokenHash(nonce) !== pending.row.browser_hash
        || !constantEquals(input.csrf, csrfToken(this.store.key, 'lexiang:' + state, nonce))) throw error(403, '乐享授权表单已失效或来源无效');
    } else throw error(405, '不支持的授权请求');
    const csrf = csrfToken(this.store.key, 'lexiang:' + state, nonce), workbuddyName = pending.user.nickname;
    const consent = member => this.page(res, lexiangConsentPage({ state, csrf, workbuddyName, memberName: member.nickname }));
    if (req.method === 'GET') {
      if (pending.row.phase === 'authenticated') { const member = this.mock.member(pending.row.member_id); if (!member || member.revision !== pending.row.member_revision) throw authorizationRequired(); return consent(member); }
      return this.page(res, lexiangLoginPage({ state, csrf, workbuddyName }));
    }
    if (input.action === 'login' && pending.row.phase === 'pending') {
      let username; try { username = normalizeUsername(input.username); } catch { username = ''; }
      if (!this.store.checkRateLimit('lexiang-login-ip:' + req.socket.remoteAddress, 60, 300000) || !this.store.checkRateLimit('lexiang-login-user:' + username, 10, 300000) || this.verifying >= 4) throw error(429, '乐享登录请求过于频繁，请稍后重试');
      let member; this.verifying++; try { member = await this.mock.authenticate(input.username, input.password); } finally { this.verifying--; }
      if (!member) { this.store.audit('lexiang_login_failed', username || null, pending.session.id, { actor: 'lexiang-browser' }); return this.page(res, lexiangLoginPage({ state, csrf, workbuddyName, error: '乐享账号或密码不正确' }), 401); }
      this.auth.authenticate(state, member.id, member.revision); return consent(member);
    }
    if (input.action === 'deny') { this.auth.finish(state, 'denied'); res.setHeader('Set-Cookie', `${name}=; Max-Age=0; ${flags}`); return this.page(res, '<h1>已取消乐享授权</h1><p>WorkBuddy 的登录不受影响。</p>'); }
    if (input.action === 'approve' && pending.row.phase === 'authenticated') {
      this.store.transaction(() => {
        const proof = this.auth.consume(state, 'authenticated'), member = this.mock.member(proof.row.member_id); if (!member || member.revision !== proof.row.member_revision) throw authorizationRequired();
        const previous = this.auth.binding(proof.user.id); if (previous) this.mock.revoke(previous.id);
        const id = randomUUID(), grant = this.mock.grant(member.id, id);
        this.auth.saveBinding(proof.user.id, grant, 'mock', id); this.auth.finish(state);
        this.store.audit('lexiang_authorized', proof.user.username, proof.session.id);
      });
      res.setHeader('Set-Cookie', `${name}=; Max-Age=0; ${flags}`); return this.page(res, lexiangAuthorizationComplete());
    }
    throw error(400, '乐享授权步骤无效');
  }
  async callback(req, res, url) {
    if (req.method !== 'GET' || !url.searchParams.get('code') || url.searchParams.get('code').length > 2048) throw error(400, '无效的乐享授权回调');
    const state = url.searchParams.get('state'), pending = this.auth.consume(state, 'pending');
    const id = randomUUID(); let grant, saved = false;
    try {
      grant = this.validateGrant(await this.bridge('/exchange', { code: url.searchParams.get('code'), state, redirect_uri: this.config.publicUrl + '/private/lexiang/callback', code_verifier: unseal(this.store.key, pending.row.verifier_sealed), binding_id: id, session_id: pending.session.id }));
      if (this.settings.members?.[pending.user.username] && this.settings.members[pending.user.username] !== grant.subject) throw error(403, '此乐享成员不在该 WorkBuddy 账号允许的绑定范围内');
      this.store.transaction(() => {
        const current = this.auth.authorization(state, ['consuming']);
        if (current.row.request_id !== pending.row.request_id || current.session.id !== pending.session.id) throw error(410, '乐享授权已取消或被替换');
        this.auth.saveBinding(pending.user.id, grant, 'bridge', id); this.auth.finish(state); saved = true;
      });
      this.store.audit('lexiang_authorized', pending.user.username, pending.session.id); return this.page(res, lexiangAuthorizationComplete());
    } catch (cause) {
      this.auth.finish(state, 'denied');
      if (grant && !saved) try { await this.bridge('/revoke', { subject: grant.subject, binding_id: id, refresh_token: grant.refresh_token }); } catch { /* Local binding absence also makes introspection fail closed. */ }
      throw cause;
    }
  }
  async handle(req, res, { url, requireAccount, readBody }) {
    const route = url.pathname;
    const oauth = /^\/v2\/as\/connector\/oauth\/(?:lexiang-ol|lexiang)\/(status|start|accesstoken|refresh|temp-login-url|revoke|oauthuser)$/.exec(route);
    const mcp = /^\/console\/agent-gateway\/lexiang-ol(?:\/api)?\/mcp$/.test(route), enterprise = /^\/console\/enterprises\/[^/]+\/lexiang\/temp-login-url$/.test(route);
    const privateRoute = ['/private/lexiang/config', '/private/lexiang/bridge/introspect', '/private/lexiang/authorize', '/private/lexiang/callback'].includes(route);
    const mockRoute = route.startsWith('/spapi/') || route === '/private/lexiang/login' || route === '/wb' || route === '/' || /^\/(?:pages|spaces|t|s|kb)\//.test(route);
    if (!oauth && !mcp && !enterprise && !privateRoute && !(this.mock && mockRoute)) return false;
    if (!this.settings) throw error(501, '当前服务未配置私有乐享');
    const reply = (data, raw = false) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(raw ? data : { code: 0, msg: '', data })); return true; };
    if (route === '/private/lexiang/authorize' && this.mock) return this.authorize(req, res, url, readBody);
    if (route === '/private/lexiang/callback' && !this.mock) return this.callback(req, res, url);
    if (route === '/private/lexiang/bridge/introspect') {
      if (this.mock) throw error(404, '未启用乐享 bridge');
      if (req.method !== 'POST') throw error(405, '只允许 POST');
      const serviceToken = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
      if (!constantEquals(serviceToken || '', this.settings.bridgeSecret)) throw error(401, '无效的服务凭据');
      const input = await readBody(req);
      if (![input.subject, input.session_id, input.binding_id].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)) throw error(400, '无效的会话校验参数');
      const user = this.store.sessionUser(input.session_id), binding = user && this.auth.binding(user.id);
      const active = !!user && this.validBinding(binding, user) && binding.id === input.binding_id && binding.subject === input.subject;
      return reply({ active, ...(active ? { expires_at: Math.floor(Math.min(user.refresh_expires, binding.refresh_expires) / 1000) } : {}) });
    }
    if (this.mock && mockRoute) return this.handleMock(req, res, url, reply, readBody);
    const account = requireAccount(req), token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    const session = this.store.sessionForAccessToken(token), user = session && this.store.sessionUser(session.id);
    if (!session || !user || account.uid !== user.id) throw error(401, '登录已失效');
    const operation = oauth?.[1]; let mcpInput;
    try {
      if (route === '/private/lexiang/config' && req.method === 'GET') return reply({ client: this.clientConfig(), mode: this.settings.mode, authorization: 'independent-account' });
      if (operation === 'status' && req.method === 'GET') {
        const binding = this.auth.binding(user.id), valid = this.validBinding(binding, user);
        const pending = this.store.db.prepare('SELECT phase FROM lexiang_authorizations WHERE session_id=? AND expires>? ORDER BY expires DESC LIMIT 1').get(session.id, this.store.now());
        const waiting = pending && ['pending', 'authenticated', 'consuming'].includes(pending.phase);
        return reply({ status: waiting ? 'pending' : valid ? 'connected' : binding ? 'expired' : pending?.phase === 'denied' ? 'failed' : 'not_connected',
          ...(valid ? { connected_at: Math.floor(binding.created_at / 1000) } : {}) });
      }
      if (operation === 'start' && req.method === 'POST') {
        await readBody(req);
        if (!this.store.checkRateLimit('lexiang-start:' + session.id, 30, 300000)) throw error(429, '乐享授权请求过于频繁');
        const verifier = this.mock ? null : randomSecret(), pending = this.auth.start(session, verifier);
        let authorize = this.config.publicUrl + '/private/lexiang/authorize?state=' + pending.state;
        if (!this.mock) {
          const result = await this.bridge('/authorize', { state: pending.state, redirect_uri: this.config.publicUrl + '/private/lexiang/callback', session_id: session.id, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', expires_at: Math.floor(pending.expires / 1000) });
          let target; try { target = new URL(result.authorize_url); } catch { throw error(502, '乐享授权地址无效'); }
          if (target.username || target.password || !this.settings.authorizationOrigins.includes(target.origin)) throw error(502, '乐享授权地址不在允许范围'); authorize = target.href;
        }
        return reply({ next_action: 'redirect', request_id: pending.requestId, auth_type: 'oauth', authorize_url: authorize, expire_at: Math.floor(pending.expires / 1000) });
      }
      if (operation === 'revoke' && req.method === 'POST') {
        await readBody(req); const binding = this.auth.revoke(user.id); let upstreamRevoked = true;
        if (binding) {
          if (this.mock) this.mock.revoke(binding.id);
          else try { await this.bridge('/revoke', { subject: binding.subject, binding_id: binding.id, refresh_token: this.auth.refreshToken(binding) }); } catch { upstreamRevoked = false; }
        }
        this.store.audit('lexiang_disconnected', user.username, session.id);
        return reply({ status: 'ok', revoked_count: binding ? 1 : 0, upstream_revoked: upstreamRevoked });
      }
      if (mcp && req.method === 'POST') mcpInput = await readBody(req);
      const binding = this.binding(user);
      if (operation === 'oauthuser' && req.method === 'GET') return reply({ user: { id: binding.subject, name: binding.display_name } });
      if (operation === 'accesstoken' && req.method === 'GET') return reply(await this.delegatedToken(user, session, true));
      if (operation === 'refresh' && req.method === 'POST') { await readBody(req); return reply(await this.delegatedToken(user, session, true)); }
      if ((operation === 'temp-login-url' || enterprise) && req.method === 'POST') {
        const input = await readBody(req), target = normalizeLexiangTarget(input.intend_url, this.clientConfig().webOrigin);
        if (!/^\/(?:$|wb(?:\/|$)|pages\/|spaces\/|t\/|s\/|kb\/)/.test(new URL(target).pathname)) throw error(400, '不支持的乐享页面路径');
        if (this.mock) { const ticket = this.auth.issue(session, binding, 'ticket', 60, target); return reply({ login_url: this.config.publicUrl + '/private/lexiang/login?ticket=' + ticket.value }); }
        const result = await this.bridge('/login-url', { subject: binding.subject, binding_id: binding.id, session_id: session.id, refresh_token: this.auth.refreshToken(binding), intend_url: target });
        let login; try { login = new URL(result.login_url); } catch { throw error(502, '乐享登录地址无效'); }
        if (login.username || login.password || !this.settings.loginOrigins.includes(login.origin)) throw error(502, '乐享返回未允许的登录地址');
        return reply({ login_url: login.href });
      }
      if (mcp && req.method === 'POST') {
        const input = mcpInput;
        if (input.method !== 'tools/call' || input.params?.name !== 'call_rpc' || !input.params?.arguments || typeof input.params.arguments.tool_name !== 'string' || !input.params.arguments.arguments || typeof input.params.arguments.arguments !== 'object' || Array.isArray(input.params.arguments.arguments)) throw error(400, '不支持的乐享 MCP 请求');
        if (this.mock) return reply({ jsonrpc: '2.0', id: input.id, result: { content: [{ type: 'text', text: JSON.stringify({ code: 0, data: this.mock.tool(this.mock.member(binding.subject), input.params.arguments.tool_name, input.params.arguments.arguments) }) }] } }, true);
        const send = async force => { const delegated = await this.delegatedToken(user, session, force); return this.upstream(this.settings.mcpUrl, { method: 'POST', headers: { Authorization: `Bearer ${delegated.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); };
        try { return reply(await send(false), true); } catch (cause) { if (cause.upstreamStatus !== 401) throw cause; return reply(await send(true), true); }
      }
      throw error(405, '不支持的乐享请求方法');
    } catch (cause) {
      // A valid WorkBuddy session must not be logged out when its separate Lexiang grant expires.
      if (!cause.lexiangAuthorizationRequired) throw cause;
      if (mcp) return reply({ jsonrpc: '2.0', id: mcpInput?.id ?? null, error: { code: 401, message: 'Lexiang authorization required; reconnect Lexiang' } }, true);
      return reply({ code: 401, msg: 'Lexiang authorization required; 请重新连接乐享' }, true);
    }
  }
  async handleMock(req, res, url, reply, readBody) {
    if (url.pathname === '/private/lexiang/login' && req.method === 'GET') {
      const { item, binding } = this.credential(url.searchParams.get('ticket'), 'ticket', true);
      const existing = cookie(req, 'wb_lexiang'); let browser;
      if (existing) try { const previous = this.credential(existing, 'browser').item; if (previous.session_id === item.session_id && previous.binding_id === binding.id && previous.expires > this.store.now() + 60000) browser = { value: existing, expires: Math.floor(previous.expires / 1000) }; } catch (cause) { if (cause.status !== 401) throw cause; }
      browser ||= this.auth.issue({ id: item.session_id, refresh_expires: this.store.sessionUser(item.session_id).refresh_expires }, binding, 'browser', 3600);
      res.setHeader('Set-Cookie', `wb_lexiang=${browser.value}; Path=/; Max-Age=${Math.max(0, browser.expires - Math.floor(this.store.now() / 1000))}; HttpOnly; SameSite=Lax${this.config.publicUrl.startsWith('https:') ? '; Secure' : ''}`);
      res.writeHead(303, { Location: item.target }); res.end(); return true;
    }
    if (url.pathname.startsWith('/spapi/')) {
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1], { member } = this.credential(token, 'access');
      if (req.method !== 'GET' && !(req.method === 'POST' && url.pathname === '/spapi/search/v1/kb/search')) throw error(405, 'Mock 不支持此写入操作');
      return reply(this.mock.api(member, url, req.method === 'POST' ? await readBody(req) : {}));
    }
    if (req.method !== 'GET') throw error(405, '不支持的页面请求');
    const { member } = this.credential(cookie(req, 'wb_lexiang'), 'browser'), { entries } = this.mock.data(member);
    const match = /^\/pages\/([^/]+)$/.exec(url.pathname), doc = match ? this.mock.document(member, decodeURIComponent(match[1])) : undefined;
    if (match && !doc) throw error(404, 'Mock 知识不存在或无权访问');
    return this.page(res, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(doc?.name || '私有乐享 Mock')}</title><style>body{font:16px/1.8 system-ui;margin:40px auto;max-width:900px;padding:24px;color:#243342}aside{background:#eaf4f0;padding:12px 18px;border-radius:8px;color:#176343}h1{font-size:28px}a{color:#146c77}p{white-space:pre-wrap}</style><aside>本地 Mock 乐享 · 独立账号：${escape(member.nickname)}</aside><h1>${escape(doc?.name || '私有乐享知识库')}</h1>${doc ? '<p>' + escape(doc.body) + '</p><a href="/wb">返回知识库</a>' : '<ul>' + entries.map(entry => `<li><a href="/pages/${encodeURIComponent(entry.id)}">${escape(entry.name)}</a></li>`).join('') + '</ul>'}</html>`);
  }
}
