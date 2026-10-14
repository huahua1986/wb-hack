import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isAccessToken, isLoginState, isRefreshToken, newAccessToken, newRefreshToken, normalizeUsername, randomSecret, seal, tokenHash, unseal } from './credentials.mjs';

export class AuthStore {
  constructor(config, now = Date.now, { allowMockData = false } = {}) {
    this.config = config;
    this.now = now;
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    if (!allowMockData && fs.existsSync(path.join(config.dataDir, 'mock-mode.json'))) throw new Error('Real authentication must use a separate data directory, not mock-data');
    const keyPath = path.join(config.dataDir, 'delivery.key');
    const dbPath = path.join(config.dataDir, 'gateway.sqlite');
    for (const filename of [keyPath, dbPath]) {
      if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) throw new Error('Authentication data files must not be symlinks');
    }
    if (fs.existsSync(dbPath) && !fs.existsSync(keyPath)) throw new Error('Existing database has no delivery.key; restore the original key before starting');
    try { fs.writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    this.key = fs.readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('Invalid delivery key');
    fs.chmodSync(keyPath, 0o600);
    this.db = new DatabaseSync(dbPath);
    if (this.db.prepare('PRAGMA user_version').get().user_version > 2) { this.db.close(); throw new Error('Database schema is newer than this server'); }
    fs.chmodSync(dbPath, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL,
        password_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), refresh_hash TEXT NOT NULL UNIQUE,
        refresh_expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
        previous_refresh_hash TEXT, previous_refresh_until INTEGER, previous_delivery TEXT
      );
      CREATE TABLE IF NOT EXISTS access_tokens (
        hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_states (
        hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        delivery TEXT
      );
      CREATE INDEX IF NOT EXISTS access_session ON access_tokens(session_id);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    `);
    this.migrate();
  }

  migrate() {
    this.transaction(() => {
      const columns = new Set(this.db.prepare('PRAGMA table_info(sessions)').all().map(row => row.name));
      for (const [name, type] of [['created_at', 'INTEGER NOT NULL DEFAULT 0'], ['last_seen_at', 'INTEGER NOT NULL DEFAULT 0'], ['revoked_at', 'INTEGER'], ['revoke_reason', 'TEXT']]) {
        if (!columns.has(name)) this.db.exec('ALTER TABLE sessions ADD COLUMN ' + name + ' ' + type);
      }
      this.db.exec('CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, username TEXT, session_id TEXT, source_ip TEXT); CREATE INDEX IF NOT EXISTS audit_time ON audit_events(time); CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires INTEGER NOT NULL); PRAGMA user_version=2;');
    });
  }

  audit(action, username = null, sessionId = null, { actor = 'system', sourceIp = null } = {}) {
    this.db.prepare('INSERT INTO audit_events(time,actor,action,username,session_id,source_ip) VALUES(?,?,?,?,?,?)')
      .run(this.now(), String(actor).replace(/[\r\n]/g, ' ').slice(0, 128), action, username, sessionId, sourceIp);
  }

  listAudit({ limit = 100, username } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Audit limit must be 1-1000');
    return username === undefined
      ? this.db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM audit_events WHERE username=? ORDER BY id DESC LIMIT ?').all(normalizeUsername(username), limit);
  }

  checkRateLimit(key, limit, window = 300000) {
    return this.transaction(() => {
      const now = this.now(), row = this.db.prepare('SELECT * FROM rate_limits WHERE key=?').get(key);
      if (row?.expires > now && row.hits >= limit) return false;
      if (!row) {
        this.db.prepare('DELETE FROM rate_limits WHERE expires<=?').run(now);
        if (this.db.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n >= 10000) return false;
      }
      this.db.prepare('INSERT INTO rate_limits(key,hits,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET hits=excluded.hits,expires=excluded.expires')
        .run(key, row?.expires > now ? row.hits + 1 : 1, row?.expires > now ? row.expires : now + window);
      return true;
    });
  }

  unlockUser(username, context = {}) {
    const user = this.getUser(normalizeUsername(username));
    if (!user) throw new Error('User does not exist');
    this.transaction(() => {
      this.db.prepare('DELETE FROM rate_limits WHERE key=?').run('user:' + user.username);
      this.audit('user_login_unlocked', user.username, null, context);
    });
  }

  listSessions(username, { includeInactive = false } = {}) {
    const user = this.getUser(normalizeUsername(username));
    if (!user) throw new Error('User does not exist');
    return this.db.prepare('SELECT id,created_at,last_seen_at,refresh_expires,revoked,revoked_at,revoke_reason FROM sessions WHERE user_id=? ORDER BY created_at DESC').all(user.id)
      .map(row => ({ id: row.id, username: user.username, createdAt: row.created_at || null, lastSeenAt: row.last_seen_at || null, expiresAt: row.refresh_expires, active: !row.revoked && row.refresh_expires > this.now() && !user.disabled, revokedAt: row.revoked_at, reason: row.revoke_reason }))
      .filter(row => includeInactive || row.active);
  }

  revokeUserSessions(username, { sessionId, actor = 'system' } = {}) {
    const user = this.getUser(normalizeUsername(username));
    if (!user) throw new Error('User does not exist');
    if (sessionId !== undefined && (!/^[a-f0-9-]{36}$/.test(sessionId) || !this.db.prepare('SELECT id FROM sessions WHERE id=? AND user_id=?').get(sessionId, user.id))) throw new Error('Session does not belong to this user');
    return this.transaction(() => {
      const result = sessionId === undefined
        ? this.db.prepare("UPDATE sessions SET revoked=1,revoked_at=?,revoke_reason='admin',previous_delivery=NULL WHERE user_id=? AND revoked=0").run(this.now(), user.id)
        : this.db.prepare("UPDATE sessions SET revoked=1,revoked_at=?,revoke_reason='admin',previous_delivery=NULL WHERE id=? AND user_id=? AND revoked=0").run(this.now(), sessionId, user.id);
      this.db.prepare('DELETE FROM login_states WHERE session_id IN (SELECT id FROM sessions WHERE user_id=? AND revoked=1)').run(user.id);
      this.audit(sessionId === undefined ? 'user_sessions_revoked' : 'session_revoked', user.username, sessionId ?? null, { actor });
      return Number(result.changes);
    });
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getUser(username) { return this.db.prepare('SELECT * FROM users WHERE username=?').get(username); }
  listUsers() { return this.db.prepare('SELECT username,nickname,disabled FROM users ORDER BY username').all(); }

  addUser(username, nickname, passwordHash, context = {}) {
    username = normalizeUsername(username);
    if (this.getUser(username)) throw new Error('User already exists');
    if (typeof nickname !== 'string' || !nickname.trim() || nickname.length > 128) throw new Error('Invalid display name');
    this.transaction(() => {
      this.db.prepare('INSERT INTO users(id,username,nickname,password_hash,created_at) VALUES(?,?,?,?,?)')
        .run('local_' + randomUUID(), username, nickname.trim(), passwordHash, this.now());
      this.audit('user_created', username, null, context);
    });
  }

  updateUser(username, passwordHash = undefined, disabled = undefined, context = {}) {
    const user = this.getUser(normalizeUsername(username));
    if (!user) throw new Error('User does not exist');
    this.transaction(() => {
      if (passwordHash !== undefined) this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, user.id);
      if (disabled !== undefined) this.db.prepare('UPDATE users SET disabled=? WHERE id=?').run(disabled ? 1 : 0, user.id);
      this.db.prepare("UPDATE sessions SET revoked=1,revoked_at=?,revoke_reason='account_changed',previous_delivery=NULL WHERE user_id=? AND revoked=0").run(this.now(), user.id);
      this.db.prepare('DELETE FROM login_states WHERE session_id IN (SELECT id FROM sessions WHERE user_id=?)').run(user.id);
      this.audit(passwordHash !== undefined ? 'user_password_changed' : disabled ? 'user_disabled' : 'user_enabled', user.username, null, context);
    });
  }

  setDisplayName(username, nickname, context = {}) {
    const user = this.getUser(normalizeUsername(username));
    if (!user) throw new Error('User does not exist');
    if (typeof nickname !== 'string' || !nickname.trim() || nickname.length > 128) throw new Error('Invalid display name');
    this.transaction(() => {
      this.db.prepare('UPDATE users SET nickname=? WHERE id=?').run(nickname.trim(), user.id);
      this.audit('user_profile_updated', user.username, null, context);
    });
  }

  createLoginState() {
    this.cleanup();
    if (this.db.prepare('SELECT COUNT(*) AS n FROM login_states').get().n >= 10000) throw new Error('Too many pending logins');
    const state = randomSecret();
    this.db.prepare('INSERT INTO login_states(hash,expires) VALUES(?,?)')
      .run(tokenHash(state), this.now() + this.config.loginTtlSeconds * 1000);
    return state;
  }

  getLoginState(state) {
    if (!isLoginState(state)) return undefined;
    return this.db.prepare('SELECT * FROM login_states WHERE hash=? AND expires>?').get(tokenHash(state), this.now());
  }

  credentialPair(sessionId, refreshExpires) {
    const accessToken = newAccessToken(), refreshToken = newRefreshToken();
    const expiresAt = Math.min(this.now() + this.config.accessTtlSeconds * 1000, refreshExpires);
    const pair = {
      accessToken, refreshToken, tokenType: 'Bearer', scope: 'workbuddy.local',
      domain: new URL(this.config.publicUrl).hostname,
      expiresAt, expiresIn: Math.max(0, Math.floor((expiresAt - this.now()) / 1000)),
      refreshExpiresAt: refreshExpires, refreshExpiresIn: Math.max(0, Math.floor((refreshExpires - this.now()) / 1000)),
    };
    this.db.prepare('INSERT INTO access_tokens(hash,session_id,expires) VALUES(?,?,?)').run(tokenHash(accessToken), sessionId, expiresAt);
    return pair;
  }

  grantLogin(state, userId, { expectedPasswordHash, actor = 'browser', sourceIp = null } = {}) {
    return this.transaction(() => {
      const pending = this.getLoginState(state);
      const user = this.db.prepare('SELECT id,username,password_hash FROM users WHERE id=? AND disabled=0').get(userId);
      if (!pending || pending.delivery || !user || (expectedPasswordHash !== undefined && user.password_hash !== expectedPasswordHash)) return false;
      const id = randomUUID(), expires = this.now() + this.config.refreshTtlSeconds * 1000;
      // credentialPair creates an access row, so establish its FK parent first.
      this.db.prepare('INSERT INTO sessions(id,user_id,refresh_hash,refresh_expires,created_at,last_seen_at) VALUES(?,?,?,?,?,?)').run(id, userId, 'pending_' + randomSecret(), expires, this.now(), this.now());
      const pair = this.credentialPair(id, expires);
      this.db.prepare('UPDATE sessions SET refresh_hash=? WHERE id=?').run(tokenHash(pair.refreshToken), id);
      this.db.prepare('UPDATE login_states SET session_id=?,delivery=? WHERE hash=?').run(id, seal(this.key, pair), pending.hash);
      this.audit('login_succeeded', user.username, id, { actor, sourceIp });
      return true;
    });
  }

  pollLogin(state) {
    return this.transaction(() => {
      const pending = this.getLoginState(state);
      if (!pending) return { status: 'expired' };
      if (!pending.delivery) return { status: 'pending' };
      const session = this.db.prepare('SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.revoked=0 AND u.disabled=0 AND s.refresh_expires>?')
        .get(pending.session_id, this.now());
      if (!session) { this.db.prepare('DELETE FROM login_states WHERE hash=?').run(pending.hash); return { status: 'expired' }; }
      const auth = unseal(this.key, pending.delivery);
      this.db.prepare('DELETE FROM login_states WHERE hash=?').run(pending.hash);
      return { status: 'complete', auth };
    });
  }

  account(accessToken) {
    if (!isAccessToken(accessToken)) return undefined;
    const row = this.db.prepare(`SELECT u.id,u.username,u.nickname,s.id AS session_id FROM access_tokens a
      JOIN sessions s ON s.id=a.session_id JOIN users u ON u.id=s.user_id
      WHERE a.hash=? AND a.expires>? AND s.refresh_expires>? AND s.revoked=0 AND u.disabled=0`)
      .get(tokenHash(accessToken), this.now(), this.now());
    if (!row) return undefined;
    this.db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=? AND last_seen_at<?').run(this.now(), row.session_id, this.now() - 30000);
    return { uid: row.id, username: row.username, nickname: row.nickname, type: 'personal', lastLogin: true };
  }

  refresh(refreshToken, expectedUserId = undefined) {
    if (!isRefreshToken(refreshToken)) return undefined;
    return this.transaction(() => {
      const hash = tokenHash(refreshToken);
      const session = this.db.prepare(`SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE (s.refresh_hash=? OR s.previous_refresh_hash=?) AND s.refresh_expires>? AND s.revoked=0 AND u.disabled=0`)
        .get(hash, hash, this.now());
      if (!session || (expectedUserId && expectedUserId !== session.user_id)) return undefined;
      // A short retry window prevents parallel daemon/CLI refresh from invalidating
      // one another. It returns the same encrypted replacement, not another rotation.
      if (session.refresh_hash !== hash) {
        return session.previous_refresh_until > this.now() && session.previous_delivery
          ? unseal(this.key, session.previous_delivery) : undefined;
      }
      const pair = this.credentialPair(session.id, session.refresh_expires);
      this.db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(this.now(), session.id);
      this.db.prepare(`UPDATE sessions SET refresh_hash=?,previous_refresh_hash=?,previous_refresh_until=?,previous_delivery=? WHERE id=?`)
        .run(tokenHash(pair.refreshToken), hash, this.now() + 10000, seal(this.key, pair), session.id);
      return pair;
    });
  }

  revoke(refreshToken) {
    if (!isRefreshToken(refreshToken)) return;
    const hash = tokenHash(refreshToken);
    this.transaction(() => {
      const session = this.db.prepare('SELECT s.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.refresh_hash=? OR s.previous_refresh_hash=?').get(hash, hash);
      if (!session) return;
      this.db.prepare("UPDATE sessions SET revoked=1,revoked_at=?,revoke_reason='logout',previous_delivery=NULL WHERE id=?").run(this.now(), session.id);
      this.db.prepare('DELETE FROM login_states WHERE session_id=?').run(session.id);
      this.audit('session_logged_out', session.username, session.id);
    });
  }

  cleanup() {
    const now = this.now();
    this.db.prepare('DELETE FROM login_states WHERE expires<=?').run(now);
    this.db.prepare('DELETE FROM access_tokens WHERE expires<=?').run(now);
    this.db.prepare('DELETE FROM sessions WHERE refresh_expires<=?').run(now);
    this.db.prepare('UPDATE sessions SET previous_delivery=NULL WHERE previous_refresh_until<=?').run(now);
    this.db.prepare('DELETE FROM rate_limits WHERE expires<=?').run(now);
    this.db.prepare('DELETE FROM audit_events WHERE time<?').run(now - (this.config.auditRetentionDays || 90) * 86400000);
  }

  close() { this.db.close(); }
}
