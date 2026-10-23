import { randomUUID } from 'node:crypto';
import { randomSecret, isLoginState, tokenHash, seal, unseal } from './credentials.mjs';

export const lexiangAuthError = (status, message) => Object.assign(new Error(message), { status });
export const authorizationRequired = () => Object.assign(lexiangAuthError(403, '请先登录并授权乐享账号'), { lexiangAuthorizationRequired: true });

export class LexiangAuthStore {
  transaction(action) { return this.store.db.isTransaction ? action() : this.store.transaction(action); }
  constructor(store) {
    this.store = store;
    store.transaction(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS lexiang_bindings (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), subject TEXT NOT NULL,
        display_name TEXT NOT NULL, provider TEXT NOT NULL, refresh_sealed TEXT NOT NULL, refresh_expires INTEGER NOT NULL,
        access_sealed TEXT, access_expires INTEGER NOT NULL DEFAULT 0, access_session_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, refresh_count INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS lexiang_authorizations (
        hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        expires INTEGER NOT NULL, phase TEXT NOT NULL, member_id TEXT, verifier_sealed TEXT, request_id TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS lexiang_authorization_session ON lexiang_authorizations(session_id);
        CREATE TABLE IF NOT EXISTS lexiang_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS lexiang_credentials (
        hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, expires INTEGER NOT NULL, target TEXT,
        binding_id TEXT REFERENCES lexiang_bindings(id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS lexiang_credential_session ON lexiang_credentials(session_id);`);
      const columns = store.db.prepare('PRAGMA table_info(lexiang_credentials)').all();
      if (!columns.some(column => column.name === 'binding_id')) store.db.exec('ALTER TABLE lexiang_credentials ADD COLUMN binding_id TEXT REFERENCES lexiang_bindings(id) ON DELETE CASCADE');
      if (!store.db.prepare('PRAGMA table_info(lexiang_authorizations)').all().some(column => column.name === 'browser_hash')) store.db.exec('ALTER TABLE lexiang_authorizations ADD COLUMN browser_hash TEXT');
      if (!store.db.prepare('PRAGMA table_info(lexiang_authorizations)').all().some(column => column.name === 'member_revision')) store.db.exec('ALTER TABLE lexiang_authorizations ADD COLUMN member_revision INTEGER');
      const version = store.db.prepare('SELECT version FROM lexiang_schema WHERE id=1').get()?.version;
      if (version && version > 2) throw Error('乐享授权数据库版本高于当前服务');
      if (!version) {
        // Earlier implicit account mappings are not proof of a second account's consent.
        store.db.exec('DELETE FROM lexiang_credentials; INSERT INTO lexiang_schema VALUES(1,2);');
        store.audit('lexiang_independent_authorization_required');
      }
    });
  }
  start(session, verifier = null) {
    const state = randomSecret(), expires = Math.min(this.store.now() + 300000, session.refresh_expires), requestId = randomUUID();
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM lexiang_authorizations WHERE expires<=? OR session_id=?').run(this.store.now(), session.id);
      this.store.db.prepare('INSERT INTO lexiang_authorizations(hash,session_id,expires,phase,member_id,verifier_sealed,request_id) VALUES(?,?,?,?,?,?,?)').run(tokenHash(state), session.id, expires, 'pending', null, verifier ? seal(this.store.key, verifier) : null, requestId);
    });
    return { state, expires, requestId };
  }
  authorization(state, phases = ['pending', 'authenticated']) {
    if (!isLoginState(state)) throw lexiangAuthError(410, '乐享授权链接已失效，请重新连接');
    const row = this.store.db.prepare('SELECT * FROM lexiang_authorizations WHERE hash=? AND expires>?').get(tokenHash(state), this.store.now());
    const user = row && this.store.sessionUser(row.session_id);
    if (!row || !user || !phases.includes(row.phase)) throw lexiangAuthError(410, '乐享授权链接已失效或已使用');
    return { row, user, session: { id: row.session_id, refresh_expires: user.refresh_expires } };
  }
  authenticate(state, memberId, revision) {
    const { row } = this.authorization(state, ['pending']);
    this.store.db.prepare("UPDATE lexiang_authorizations SET phase='authenticated',member_id=?,member_revision=? WHERE hash=?").run(memberId, revision, row.hash);
  }
  consume(state, phase) {
    return this.transaction(() => {
      const pending = this.authorization(state, [phase]);
      this.store.db.prepare("UPDATE lexiang_authorizations SET phase='consuming' WHERE hash=?").run(pending.row.hash);
      return pending;
    });
  }
  finish(state, phase = 'complete') { this.store.db.prepare('UPDATE lexiang_authorizations SET phase=? WHERE hash=?').run(phase, tokenHash(state)); }
  binding(userId) { return this.store.db.prepare('SELECT * FROM lexiang_bindings WHERE user_id=?').get(userId); }
  saveBinding(userId, grant, provider, id = randomUUID()) {
    return this.transaction(() => {
      const old = this.binding(userId);
      if (old) this.store.db.prepare('DELETE FROM lexiang_bindings WHERE id=?').run(old.id);
      const now = this.store.now();
      this.store.db.prepare('INSERT INTO lexiang_bindings(id,user_id,subject,display_name,provider,refresh_sealed,refresh_expires,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, userId, grant.subject, grant.display_name || grant.subject, provider, seal(this.store.key, grant.refresh_token), grant.refresh_expires_at * 1000, now, now);
      return this.binding(userId);
    });
  }
  revoke(userId) {
    return this.store.transaction(() => {
      const binding = this.binding(userId);
      if (binding) this.store.db.prepare('DELETE FROM lexiang_bindings WHERE id=?').run(binding.id);
      this.store.db.prepare('DELETE FROM lexiang_authorizations WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?)').run(userId);
      return binding;
    });
  }
  refreshToken(binding) { return unseal(this.store.key, binding.refresh_sealed); }
  cache(binding, session, token, refreshToken = undefined, refreshExpires = undefined) {
    const now = this.store.now();
    const changed = this.store.db.prepare(`UPDATE lexiang_bindings SET access_sealed=?,access_expires=?,access_session_id=?,
      refresh_sealed=?,refresh_expires=?,updated_at=?,refresh_count=refresh_count+1 WHERE id=?`)
      .run(seal(this.store.key, token.access_token), token.expires_at * 1000, session.id,
        refreshToken ? seal(this.store.key, refreshToken) : binding.refresh_sealed, refreshExpires ? refreshExpires * 1000 : binding.refresh_expires,
        now, binding.id).changes;
    if (!changed) throw authorizationRequired();
  }
  cached(binding, session) {
    if (!binding.access_sealed || binding.access_session_id !== session.id || binding.access_expires <= this.store.now() + 30000) return;
    return { access_token: unseal(this.store.key, binding.access_sealed), expires_at: Math.floor(binding.access_expires / 1000), expire_at: Math.floor(binding.access_expires / 1000) };
  }
  issue(session, binding, kind, ttl, target = null) {
    const value = 'lx_' + randomSecret(), expires = Math.min(this.store.now() + ttl * 1000, session.refresh_expires, binding.refresh_expires);
    this.store.db.prepare('DELETE FROM lexiang_credentials WHERE expires<=?').run(this.store.now());
    if (this.store.db.prepare('SELECT count(*) AS n FROM lexiang_credentials WHERE session_id=?').get(session.id).n >= 128) throw lexiangAuthError(429, '乐享凭据请求过于频繁，请稍后再试');
    this.store.db.prepare('INSERT INTO lexiang_credentials(hash,session_id,kind,expires,target,binding_id) VALUES(?,?,?,?,?,?)')
      .run(tokenHash(value), session.id, kind, expires, target, binding.id);
    return { value, expires: Math.floor(expires / 1000) };
  }
}
