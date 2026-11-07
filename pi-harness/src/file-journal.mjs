import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const FILE_JOURNAL_LIMITS = Object.freeze({
  maxFileBytes: 25 * 1024 * 1024,
  maxSnapshotBytes: 128 * 1024 * 1024,
  maxStoredBytes: 1024 * 1024 * 1024,
  maxFiles: 2048,
  maxScanEntries: 10000,
  maxScanMs: 5000,
  maxDepth: 32,
  maxIndexBytes: 16 * 1024 * 1024,
  maxDetailBytes: 48 * 1024,
});
export const FILE_JOURNAL_IGNORED = Object.freeze([
  '.git', 'node_modules', '.cache', '__pycache__', '.venv', 'venv', '.DS_Store',
]);
const CHANGE_OPERATIONS = new Set(['created', 'modified', 'deleted', 'unavailable']);
const FINAL_STATUSES = new Set(['completed', 'cancelled', 'failed', 'interrupted']);
const HASH = /^[a-f0-9]{64}$/;
const clone = value => structuredClone(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code, message, detail = {}) => Object.assign(new Error(message), { code: `FILE_JOURNAL_${code}`, ...detail });
const inside = (root, filename) => filename === root || filename.startsWith(root + path.sep);
const missing = () => ({ kind: 'missing' });
const unknown = reason => ({ kind: 'unknown', reason });

function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw failure('INVALID', `${label}无效。`);
  return value;
}
function absolute(value) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value) || value.length > 8192 ||
    /[\x00-\x1f\x7f\\]/.test(value) || value.split('/').some(p => p === '.' || p === '..')) throw failure('PATH_INVALID', '文件记录需要规范的本地路径。');
  return path.resolve(value);
}
function checkSignal(signal) {
  if (signal?.aborted) throw failure('CANCELLED', '文件快照已取消。');
}
function identity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
}
function sameIdentity(a, b, { moved = false } = {}) {
  return a?.dev === b?.dev && a?.ino === b?.ino && a?.mtimeNs === b?.mtimeNs && (moved || a?.ctimeNs === b?.ctimeNs);
}
function statSame(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function checkDirectories(filename, { create = false, stopAtMissing = false } = {}) {
  const chain = []; let current = path.parse(filename).root;
  for (const component of ['', ...filename.slice(current.length).split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current, { bigint: true }); }
    catch (error) {
      if (error.code === 'ENOENT' && create) { fs.mkdirSync(current, { mode: 0o700 }); stat = fs.lstatSync(current, { bigint: true }); }
      else if (error.code === 'ENOENT' && stopAtMissing) return chain;
      else throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('UNSAFE_PATH', '文件路径包含符号链接或非目录节点。');
    chain.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return chain;
}
function assertDirectories(chain) {
  for (const previous of chain) {
    const stat = fs.lstatSync(previous.path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== previous.dev || stat.ino !== previous.ino) throw failure('PATH_CHANGED', '文件父目录在处理期间发生变化。');
  }
}
function readOrdinary(filename, maxBytes) {
  const chain = checkDirectories(path.dirname(filename));
  const before = fs.lstatSync(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw failure('UNSAFE_PATH', '快照只接受非符号链接的独立普通文件。');
  if (before.size > BigInt(maxBytes)) throw failure('LIMIT', '文件超过快照大小限制。');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!statSame(before, opened)) throw failure('FILE_CHANGED', '文件在打开快照时发生变化。');
    const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!count) throw failure('FILE_CHANGED', '文件在读取快照时发生变化。');
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true }), selected = fs.lstatSync(filename, { bigint: true });
    if (!statSame(opened, after) || !statSame(after, selected) || selected.isSymbolicLink()) throw failure('FILE_CHANGED', '文件在读取快照期间发生变化。');
    assertDirectories(chain);
    return { bytes, stat: after };
  } finally { fs.closeSync(fd); }
}
function syncDirectory(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function atomicJson(filename, value, maximum) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > maximum) throw failure('LIMIT', '文件记录索引达到上限，请先归档历史。');
  const chain = checkDirectories(path.dirname(filename));
  if (fs.existsSync(filename)) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw failure('UNSAFE_STATE', '文件记录索引不是安全的普通文件。');
  }
  const temporary = filename + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { assertDirectories(chain); fs.renameSync(temporary, filename); syncDirectory(path.dirname(filename)); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function validSnapshot(value) {
  if (!value || typeof value !== 'object' || !['missing', 'file', 'unknown', 'unsafe', 'unavailable'].includes(value.kind)) return false;
  if (value.kind !== 'file') return true;
  return Number.isSafeInteger(value.size) && value.size >= 0 && Number.isSafeInteger(value.mode)
    && (value.sha256 === null || HASH.test(value.sha256)) && (value.blob === null || value.blob === value.sha256)
    && value.identity && ['dev', 'ino', 'mtimeNs', 'ctimeNs'].every(k => /^\d+$/.test(value.identity[k]));
}
function restorable(value) { return value?.kind === 'missing' || value?.kind === 'file' && Boolean(value.blob); }
function contentEqual(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'missing') return true;
  if (a.kind !== 'file') return false;
  return a.size === b.size && a.sha256 && a.sha256 === b.sha256 && a.mode === b.mode;
}
function stateEqual(a, b, options) {
  return contentEqual(a, b) && (a.kind === 'missing' || sameIdentity(a.identity, b.identity, options));
}
function changed(a, b) {
  if (contentEqual(a, b)) return false;
  if (a?.kind === 'file' && b?.kind === 'file' && !a.sha256 && !b.sha256) return a.size !== b.size || a.mode !== b.mode || !sameIdentity(a.identity, b.identity);
  return a?.kind !== 'missing' || b?.kind !== 'missing';
}
function operation(before, after) {
  if (before.kind === 'missing' && after.kind === 'file') return 'created';
  if (before.kind === 'file' && after.kind === 'missing') return 'deleted';
  if (before.kind === 'file' && after.kind === 'file') return 'modified';
  return 'unavailable';
}
function textOf(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /\0|[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(text) ? undefined : text;
  } catch { return undefined; }
}
function mime(filename) {
  return ({ '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html' })[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/** Local private journal. It records selected files, not arbitrary shell effects or an OS sandbox. */
export class FileJournal {
  #tail = Promise.resolve();
  #state;
  #blocked;
  #plans = new Map();
  #storedBytes = 0;

  constructor({ stateDir, limits = {}, now = () => new Date().toISOString() } = {}) {
    this.root = absolute(stateDir);
    if (this.root === path.parse(this.root).root) throw failure('INVALID', '快照目录不能是文件系统根目录。');
    this.limits = { ...FILE_JOURNAL_LIMITS };
    for (const [key, value] of Object.entries(limits)) {
      if (!(key in this.limits) || !Number.isSafeInteger(value) || value < 1 || value > this.limits[key]) throw failure('INVALID', '文件记录限制只能收紧。');
      this.limits[key] = value;
    }
    if (typeof now !== 'function') throw failure('INVALID', '文件记录时钟无效。');
    this.now = now;
    checkDirectories(this.root, { create: true });
    const rootStat = fs.lstatSync(this.root);
    if ((rootStat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && rootStat.uid !== process.getuid()) throw failure('UNSAFE_STATE', '文件快照目录必须由当前用户独占（0700）。');
    this.blobsDir = path.join(this.root, 'blobs'); this.transactionsDir = path.join(this.root, 'transactions');
    checkDirectories(this.blobsDir, { create: true }); checkDirectories(this.transactionsDir, { create: true });
    for (const name of fs.readdirSync(this.blobsDir)) {
      const stat = fs.lstatSync(path.join(this.blobsDir, name));
      if (!HASH.test(name) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw failure('UNSAFE_STATE', '文件快照存储含未知或不安全节点。');
      this.#storedBytes += stat.size;
    }
    this.indexFile = path.join(this.root, 'index.json');
    this.#state = { version: 1, revision: 0, turns: [], liveStates: {} };
    if (fs.existsSync(this.indexFile)) {
      const value = JSON.parse(readOrdinary(this.indexFile, this.limits.maxIndexBytes).bytes.toString('utf8'));
      if (value.version !== 1 || !Number.isSafeInteger(value.revision) || !Array.isArray(value.turns)) throw failure('STATE_INVALID', '文件快照索引损坏，未修改工作目录。');
      for (const turn of value.turns) {
        identifier(turn.threadId, '会话'); identifier(turn.turnId, '轮次'); absolute(turn.cwd);
        if (!turn.before || !turn.after || !Array.isArray(turn.changes) || !turn.coverage || !turn.blobs) throw failure('STATE_INVALID', '文件快照轮次记录损坏。');
        for (const snapshots of [turn.before, turn.after]) for (const [filename, snapshot] of Object.entries(snapshots)) {
          absolute(filename); if (inside(this.root, filename) || !validSnapshot(snapshot)) throw failure('STATE_INVALID', '文件快照路径或内容记录无效。');
        }
        for (const change of turn.changes) if (!CHANGE_OPERATIONS.has(change.operation) || !turn.before[change.path] || !turn.after[change.path]) throw failure('STATE_INVALID', '文件变更记录无效。');
      }
      value.liveStates ??= {};
      for (const [filename, snapshot] of Object.entries(value.liveStates)) {
        absolute(filename); if (inside(this.root, filename) || !validSnapshot(snapshot)) throw failure('STATE_INVALID', '文件回退当前状态记录无效。');
      }
      this.#state = value;
    }
    const pending = [];
    for (const name of fs.readdirSync(this.transactionsDir)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw failure('STATE_INVALID', '回退事务目录含未知文件。');
      const transaction = JSON.parse(readOrdinary(path.join(this.transactionsDir, name), this.limits.maxIndexBytes).bytes.toString('utf8'));
      if (!['committed', 'abandoned'].includes(transaction.status)) pending.push({ transactionId: transaction.id, status: transaction.status, paths: transaction.entries?.map(e => e.path) ?? [] });
    }
    if (pending.length) this.#blocked = { code: 'RECOVERY_REQUIRED', reason: '存在未完成的文件回退事务；请先人工核对恢复记录。', transactions: pending };
  }
  #serial(callback) {
    const next = this.#tail.then(callback); this.#tail = next.catch(() => {}); return next;
  }
  #assertWritable() {
    if (this.#blocked) throw failure('RECOVERY_REQUIRED', this.#blocked.reason, { recovery: clone(this.#blocked) });
  }
  #persist() {
    try { this.#state.revision++; atomicJson(this.indexFile, this.#state, this.limits.maxIndexBytes); }
    catch (error) {
      this.#blocked = { code: 'RECOVERY_REQUIRED', reason: '文件快照索引未能持久化；已停止后续文件记录操作，需人工核对。' };
      throw failure('RECOVERY_REQUIRED', this.#blocked.reason, { cause: error });
    }
  }
  #turn(threadId, turnId) {
    identifier(threadId, '会话'); identifier(turnId, '轮次');
    const turn = this.#state.turns.find(t => t.threadId === threadId && t.turnId === turnId);
    if (!turn) throw failure('NOT_FOUND', '未找到该轮次的文件记录。');
    return turn;
  }
  #reason(turn, code) {
    turn.coverage.complete = false;
    if (!turn.coverage.reasons.includes(code)) turn.coverage.reasons.push(code);
  }
  #blob(snapshot, bytes, turn) {
    const digest = hash(bytes);
    if (!turn.blobs[digest]) {
      const total = Object.values(turn.blobs).reduce((sum, size) => sum + size, 0);
      if (total + bytes.length > this.limits.maxSnapshotBytes) { this.#reason(turn, 'snapshot-byte-limit'); return { ...snapshot, sha256: digest, blob: null, reason: 'snapshot-byte-limit' }; }
      const filename = path.join(this.blobsDir, digest);
      if (fs.existsSync(filename)) {
        const value = readOrdinary(filename, this.limits.maxFileBytes);
        if (hash(value.bytes) !== digest) throw failure('STATE_INVALID', '文件快照内容校验失败。');
      } else {
        if (this.#storedBytes + bytes.length > this.limits.maxStoredBytes) { this.#reason(turn, 'journal-storage-limit'); return { ...snapshot, sha256: digest, blob: null, reason: 'journal-storage-limit' }; }
        const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        this.#storedBytes += bytes.length;
        syncDirectory(this.blobsDir);
      }
      turn.blobs[digest] = bytes.length;
    }
    return { ...snapshot, sha256: digest, blob: digest };
  }
  #snapshot(filename, turn, { strict = false, signal } = {}) {
    checkSignal(signal);
    try {
      if (inside(this.root, filename)) throw failure('UNSAFE_PATH', '不能将快照自身目录作为任务文件。');
      const chain = checkDirectories(path.dirname(filename), { stopAtMissing: true });
      let stat;
      try { stat = fs.lstatSync(filename, { bigint: true }); }
      catch (error) { if (error.code === 'ENOENT') { assertDirectories(chain); return missing(); } throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw failure('UNSAFE_PATH', '无法跟踪符号链接、硬链接或特殊文件。');
      const base = { kind: 'file', size: Number(stat.size), mode: Number(stat.mode & 0o777n), identity: identity(stat), sha256: null, blob: null };
      if (stat.size > BigInt(this.limits.maxFileBytes)) { this.#reason(turn, 'file-byte-limit'); return { ...base, reason: 'file-byte-limit' }; }
      const known = turn.after?.[filename]?.blob ? turn.after[filename] : turn.before?.[filename];
      if (known?.blob && known.size === base.size && known.mode === base.mode && sameIdentity(known.identity, base.identity)) { assertDirectories(chain); return clone(known); }
      if (Object.values(turn.blobs).reduce((sum, size) => sum + size, 0) + base.size > this.limits.maxSnapshotBytes) {
        this.#reason(turn, 'snapshot-byte-limit'); return { ...base, reason: 'snapshot-byte-limit' };
      }
      const { bytes, stat: after } = readOrdinary(filename, this.limits.maxFileBytes);
      return this.#blob({ ...base, identity: identity(after) }, bytes, turn);
    } catch (error) {
      if (strict || error.code === 'FILE_JOURNAL_CANCELLED' || error.code === 'FILE_JOURNAL_STATE_INVALID') {
        if (error.code?.startsWith('FILE_JOURNAL_')) throw error;
        throw failure('CAPTURE_FAILED', '无法读取文件快照；本次修改尚未获准执行。', { cause: error });
      }
      this.#reason(turn, error.code === 'FILE_JOURNAL_UNSAFE_PATH' ? 'unsafe-path-skipped' : 'file-read-failed');
      return { kind: error.code === 'FILE_JOURNAL_UNSAFE_PATH' ? 'unsafe' : 'unavailable', reason: error.code ?? 'file-read-failed' };
    }
  }
  #toolPath(turn, value) {
    if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.split('/').includes('..')) throw failure('PATH_INVALID', '写入工具缺少安全的文件路径。');
    const filename = absolute(path.isAbsolute(value) ? value : path.resolve(turn.cwd, value));
    if (inside(this.root, filename)) throw failure('UNSAFE_PATH', '写入目标位于文件快照目录。');
    return filename;
  }
  #ignored(filename, name) { return FILE_JOURNAL_IGNORED.includes(name) || name.startsWith('.wb-file-journal-') || inside(this.root, filename); }
  async #scan(turn, { signal } = {}) {
    const result = {}, unsafePrefixes = []; let entries = 0, inventoryComplete = true;
    const deadline = Date.now() + this.limits.maxScanMs;
    const visit = async (dir, depth) => {
      checkSignal(signal);
      if (Date.now() >= deadline) { inventoryComplete = false; this.#reason(turn, 'scan-time-limit'); return; }
      if (depth > this.limits.maxDepth) { inventoryComplete = false; this.#reason(turn, 'scan-depth-limit'); return; }
      let chain, names;
      try { chain = checkDirectories(dir); names = fs.readdirSync(dir).sort(); }
      catch { inventoryComplete = false; this.#reason(turn, 'directory-read-failed'); return; }
      for (const name of names) {
        checkSignal(signal);
        if (Date.now() >= deadline) { inventoryComplete = false; this.#reason(turn, 'scan-time-limit'); return; }
        if (++entries > this.limits.maxScanEntries) { inventoryComplete = false; this.#reason(turn, 'scan-entry-limit'); return; }
        const filename = path.join(dir, name);
        if (this.#ignored(filename, name)) continue;
        let stat;
        try { stat = fs.lstatSync(filename); assertDirectories(chain); }
        catch { inventoryComplete = false; this.#reason(turn, 'path-changed-during-scan'); continue; }
        if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) { unsafePrefixes.push(filename); this.#reason(turn, 'unsafe-path-skipped'); continue; }
        if (stat.isDirectory()) await visit(filename, depth + 1);
        else {
          if (Object.keys(result).length >= this.limits.maxFiles) { inventoryComplete = false; this.#reason(turn, 'scan-file-limit'); return; }
          result[filename] = this.#snapshot(filename, turn, { signal });
        }
        if (entries % 32 === 0) await new Promise(resolve => setImmediate(resolve));
      }
    };
    await visit(turn.cwd, 0);
    return { files: result, inventoryComplete, unsafePrefixes };
  }
  #changes(turn) {
    const changes = [];
    for (const filename of Object.keys(turn.before).sort()) {
      const before = turn.before[filename], after = turn.after[filename] ?? unknown('post-state-not-captured');
      if (!changed(before, after)) continue;
      changes.push({ id: hash(Buffer.from(`${turn.threadId}\0${turn.turnId}\0${filename}`)), path: filename,
        relativePath: inside(turn.cwd, filename) ? path.relative(turn.cwd, filename) : filename,
        name: path.basename(filename), operation: operation(before, after), before, after,
        rollbackAvailable: restorable(before) && restorable(after), createdAt: turn.createdAt, updatedAt: this.now() });
    }
    turn.changes = changes;
  }
  async #refresh(turn, { signal } = {}) {
    if (turn.workspaceScanned) {
      const scan = await this.#scan(turn, { signal });
      for (const [filename, snapshot] of Object.entries(scan.files)) {
        if (!Object.hasOwn(turn.before, filename)) {
          const uncertain = !turn.baselineInventoryComplete || turn.unsafePrefixes.some(prefix => inside(prefix, filename));
          if (Object.keys(turn.before).length >= this.limits.maxFiles) { this.#reason(turn, 'tracked-file-limit'); continue; }
          turn.before[filename] = uncertain ? unknown('incomplete-baseline') : missing();
        }
        turn.after[filename] = snapshot;
      }
      for (const filename of Object.keys(turn.before)) if (!Object.hasOwn(scan.files, filename)) turn.after[filename] = this.#snapshot(filename, turn, { signal });
    } else {
      for (const filename of Object.keys(turn.before)) turn.after[filename] = this.#snapshot(filename, turn, { signal });
    }
    this.#changes(turn);
  }
  #publicChange(turn, change) {
    const summary = snapshot => snapshot.kind === 'file' ? { kind: 'file', size: snapshot.size, sha256: snapshot.sha256, mode: snapshot.mode, snapshotAvailable: Boolean(snapshot.blob), ...(snapshot.reason ? { reason: snapshot.reason } : {}) } : clone(snapshot);
    return { id: change.id, threadId: turn.threadId, turnId: turn.turnId, path: change.path, filePath: change.path,
      relativePath: change.relativePath, name: change.name, operation: change.operation, before: summary(change.before), after: summary(change.after),
      rollbackAvailable: change.rollbackAvailable && FINAL_STATUSES.has(turn.status) && !turn.rolledBackAt && !turn.rolledBackPaths?.includes(change.path) && !this.#blocked,
      rolledBack: Boolean(turn.rolledBackAt || turn.rolledBackPaths?.includes(change.path)), createdAt: change.createdAt, updatedAt: change.updatedAt };
  }
  #manifest(turn) {
    return { id: turn.turnId, threadId: turn.threadId, turnId: turn.turnId, cwd: turn.cwd, status: turn.status,
      createdAt: turn.createdAt, finishedAt: turn.finishedAt ?? null, rolledBackAt: turn.rolledBackAt ?? null,
      coverage: clone(turn.coverage), changes: turn.changes.map(c => this.#publicChange(turn, c)),
      rollbackAvailable: FINAL_STATUSES.has(turn.status) && !turn.rolledBackAt && turn.coverage.complete && turn.changes.length > 0 && turn.changes.every(c => c.rollbackAvailable) && !this.#blocked };
  }

  beginTurn({ threadId, turnId, cwd } = {}) {
    return this.#serial(() => {
      this.#assertWritable(); identifier(threadId, '会话'); identifier(turnId, '轮次'); cwd = absolute(cwd); checkDirectories(cwd);
      if (inside(this.root, cwd) || inside(cwd, this.root) && cwd === this.root) throw failure('UNSAFE_PATH', '任务目录不能是文件快照目录。');
      const existing = this.#state.turns.find(t => t.threadId === threadId && t.turnId === turnId);
      if (existing) { if (existing.cwd !== cwd) throw failure('INVALID', '轮次的工作目录不能变化。'); return this.#manifest(existing); }
      const turn = { threadId, turnId, cwd, createdAt: this.now(), status: 'running', before: {}, after: {}, changes: [], blobs: {},
        workspaceScanned: false, baselineInventoryComplete: true, unsafePrefixes: [],
        coverage: { scope: 'explicit-tool-files', complete: true, reasons: [], ignoredNames: [...FILE_JOURNAL_IGNORED], notes: ['仅记录显式写入/编辑目标；Bash启用工作目录内有界扫描，不覆盖任意目录外副作用。', '不回退目录、权限ACL、网络请求或外部服务副作用。'] } };
      this.#state.turns.push(turn); this.#persist(); return this.#manifest(turn);
    });
  }
  beforeTool({ threadId, turnId, toolName, args = {}, signal } = {}) {
    return this.#serial(async () => {
      this.#assertWritable(); const turn = this.#turn(threadId, turnId);
      if (turn.status !== 'running') throw failure('TURN_CLOSED', '该轮次已结束，不能继续执行文件修改。');
      checkSignal(signal);
      if (['write', 'edit'].includes(toolName)) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw failure('INVALID', '写入工具参数无效。');
        if (args.path !== undefined && args.file_path !== undefined && args.path !== args.file_path) throw failure('PATH_INVALID', '文件路径参数不一致。');
        const filename = this.#toolPath(turn, args.path ?? args.file_path);
        if (!Object.hasOwn(turn.before, filename)) {
          if (Object.keys(turn.before).length >= this.limits.maxFiles) this.#reason(turn, 'tracked-file-limit');
          else turn.before[filename] = this.#snapshot(filename, turn, { strict: true, signal });
        }
      } else if (toolName === 'bash' && !turn.workspaceScanned) {
        turn.coverage.scope = 'workspace-and-explicit-tool-files';
        const scan = await this.#scan(turn, { signal });
        for (const [filename, snapshot] of Object.entries(scan.files)) if (!Object.hasOwn(turn.before, filename)) {
          if (Object.keys(turn.before).length >= this.limits.maxFiles) this.#reason(turn, 'tracked-file-limit');
          else turn.before[filename] = snapshot;
        }
        turn.workspaceScanned = true; turn.baselineInventoryComplete = scan.inventoryComplete; turn.unsafePrefixes = scan.unsafePrefixes;
      }
      this.#persist(); return this.#manifest(turn);
    });
  }
  afterTool({ threadId, turnId, signal } = {}) {
    return this.#serial(async () => {
      this.#assertWritable(); const turn = this.#turn(threadId, turnId);
      if (turn.status !== 'running') return this.#manifest(turn);
      await this.#refresh(turn, { signal }); this.#persist(); return this.#manifest(turn);
    });
  }
  finishTurn({ threadId, turnId, status = 'completed' } = {}) {
    return this.#serial(async () => {
      this.#assertWritable(); const turn = this.#turn(threadId, turnId);
      if (!FINAL_STATUSES.has(status)) throw failure('INVALID', '文件记录终态无效。');
      if (turn.status !== 'running') return this.#manifest(turn);
      await this.#refresh(turn); turn.status = status; turn.finishedAt = this.now(); this.#persist(); return this.#manifest(turn);
    });
  }
  recoverInterruptedTurns() {
    return this.#serial(async () => {
      this.#assertWritable(); const recovered = [];
      for (const turn of this.#state.turns.filter(t => t.status === 'running')) {
        await this.#refresh(turn); turn.status = 'interrupted'; turn.finishedAt = this.now(); recovered.push(this.#manifest(turn));
      }
      if (recovered.length) this.#persist(); return recovered;
    });
  }
  listChanges({ threadId, turnId } = {}) {
    return this.#serial(() => { identifier(threadId, '会话'); return this.#state.turns.filter(t => t.threadId === threadId && (!turnId || t.turnId === turnId)).flatMap(t => t.changes.map(c => this.#publicChange(t, c))); });
  }
  listManifests({ threadId } = {}) {
    return this.#serial(() => { identifier(threadId, '会话'); return this.#state.turns.filter(t => t.threadId === threadId).map(t => this.#manifest(t)); });
  }
  listFiles({ threadId } = {}) {
    return this.#serial(() => {
      identifier(threadId, '会话'); const latest = new Map();
      for (const turn of this.#state.turns.filter(t => t.threadId === threadId && !t.rolledBackAt)) for (const change of turn.changes) {
        if (!turn.rolledBackPaths?.includes(change.path)) latest.set(change.path, { turn, change });
      }
      return [...latest.values()].map(({ turn, change }) => {
        let exists = false, currentChanged = false, status = 'unavailable';
        try {
          checkDirectories(path.dirname(change.path));
          const stat = fs.lstatSync(change.path, { bigint: true });
          exists = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;
          const ownRestored = this.#state.liveStates[change.path];
          const restoredByJournal = ownRestored && contentEqual(ownRestored, change.after) && sameIdentity(identity(stat), ownRestored.identity);
          currentChanged = change.after.kind !== 'file' || !sameIdentity(identity(stat), change.after.identity) && !restoredByJournal;
          status = exists ? currentChanged ? 'changed' : 'available' : 'unavailable';
        } catch (error) { if (error.code === 'ENOENT') status = 'deleted'; }
        return { ...this.#publicChange(turn, change), type: 'file', mimeType: mime(change.path),
          size: change.after.kind === 'file' ? change.after.size : change.before.size, exists, status, currentChanged };
      });
    });
  }
  async listArtifacts(params) { return (await this.listFiles(params)).filter(file => file.exists); }
  #readBlob(snapshot) {
    if (snapshot.kind === 'missing') return Buffer.alloc(0);
    if (!snapshot.blob || !HASH.test(snapshot.blob)) throw failure('SNAPSHOT_UNAVAILABLE', '该文件没有完整快照，不能回退或显示内容差异。');
    const { bytes } = readOrdinary(path.join(this.blobsDir, snapshot.blob), this.limits.maxFileBytes);
    if (bytes.length !== snapshot.size || hash(bytes) !== snapshot.sha256) throw failure('STATE_INVALID', '文件快照哈希校验失败，未修改工作目录。');
    return bytes;
  }
  getChangeDetail({ threadId, changeId, maxBytes = this.limits.maxDetailBytes } = {}) {
    return this.#serial(() => {
      identifier(threadId, '会话'); identifier(changeId, '变更');
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.limits.maxDetailBytes) throw failure('INVALID', '差异预览上限无效。');
      const turn = this.#state.turns.find(t => t.threadId === threadId && t.changes.some(c => c.id === changeId));
      if (!turn) throw failure('NOT_FOUND', '未找到文件变更。');
      const change = turn.changes.find(c => c.id === changeId), result = { ...this.#publicChange(turn, change), diffAvailable: false };
      if (!restorable(change.before) || !restorable(change.after)) return { ...result, reason: 'snapshot-unavailable' };
      if ((change.before.size ?? 0) + (change.after.size ?? 0) > maxBytes) return { ...result, reason: 'text-preview-limit' };
      const beforeBytes = this.#readBlob(change.before), afterBytes = this.#readBlob(change.after);
      const beforeText = textOf(beforeBytes), afterText = textOf(afterBytes);
      if (beforeText === undefined || afterText === undefined) return { ...result, binary: true, reason: 'binary-file' };
      let diff = '';
      try {
        const args = ['-u', '-L', 'before/' + change.name, '-L', 'after/' + change.name,
          change.before.kind === 'missing' ? '/dev/null' : path.join(this.blobsDir, change.before.blob),
          change.after.kind === 'missing' ? '/dev/null' : path.join(this.blobsDir, change.after.blob)];
        try { diff = execFileSync('/usr/bin/diff', args, { encoding: 'utf8', maxBuffer: maxBytes, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }); }
        catch (error) { if (error.status === 1 && typeof error.stdout === 'string') diff = error.stdout; else throw error; }
      } catch { return { ...result, binary: false, reason: 'diff-unavailable' }; }
      const complete = { ...result, binary: false, diffAvailable: true, beforeText, afterText, diff };
      return Buffer.byteLength(JSON.stringify(complete)) > maxBytes ? { ...result, binary: false, reason: 'text-preview-limit' } : complete;
    });
  }
  #rollbackPlan({ threadId, turnId, turnIds, paths } = {}) {
    this.#assertWritable(); identifier(threadId, '会话');
    const ids = turnIds ?? (turnId ? [turnId] : []);
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || new Set(ids).size !== ids.length) throw failure('INVALID', '回退轮次列表无效。');
    ids.forEach(id => identifier(id, '轮次'));
    if (paths !== undefined && (!Array.isArray(paths) || !paths.length || paths.length > this.limits.maxFiles)) throw failure('INVALID', '回退文件选择无效。');
    const selectedPaths = paths?.map(absolute);
    const turns = this.#state.turns.filter(t => t.threadId === threadId && ids.includes(t.turnId));
    if (turns.length !== ids.length) throw failure('NOT_FOUND', '部分回退轮次不存在。');
    const coverage = turns.map(t => ({ turnId: t.turnId, ...clone(t.coverage) }));
    if (turns.some(t => t.status === 'running' || t.rolledBackAt)) return { available: false, reason: 'turn-not-revertible', turnIds: ids, coverage };
    if (!selectedPaths && turns.some(t => !t.coverage.complete)) return { available: false, reason: 'snapshot-incomplete', turnIds: ids, coverage };
    const entries = new Map();
    for (const turn of turns) for (const change of turn.changes) {
      if (turn.rolledBackPaths?.includes(change.path)) continue;
      if (selectedPaths && !selectedPaths.includes(change.path)) continue;
      const existing = entries.get(change.path);
      if (!existing) entries.set(change.path, { path: change.path, before: change.before, after: change.after, changeIds: [change.id] });
      else { existing.after = change.after; existing.changeIds.push(change.id); }
    }
    if (selectedPaths?.some(p => !entries.has(p))) throw failure('NOT_FOUND', '所选文件不属于这些轮次的变更。');
    const values = [...entries.values()].filter(e => !contentEqual(e.before, e.after));
    if (!values.length) return { available: false, reason: 'no-file-changes', turnIds: ids, coverage };
    const revertingPaths = new Set(values.map(entry => entry.path)), aliases = new Map();
    const rememberAlias = (key, filename) => {
      const names = aliases.get(key) ?? new Set(); names.add(filename); aliases.set(key, names);
    };
    // Independent path entries must never act on the same physical file. Also
    // reject Darwin's common case/Unicode aliases without rewriting saved paths.
    // Include captured unchanged paths: a net-unchanged alias can otherwise hide
    // the actual pre-turn baseline of a changed spelling.
    for (const turn of turns) for (const filename of Object.keys(turn.before)) {
      if (process.platform === 'darwin') rememberAlias('path:' + filename.normalize('NFD').toLowerCase(), filename);
      for (const snapshot of [turn.before[filename], turn.after[filename]]) {
        if (snapshot?.kind === 'file' && snapshot.identity) rememberAlias(`inode:${snapshot.identity.dev}:${snapshot.identity.ino}`, filename);
      }
    }
    const ambiguous = [...aliases.values()].find(names => names.size > 1 && [...names].some(filename => revertingPaths.has(filename)));
    if (ambiguous) {
      const names = [...ambiguous];
      return { available: false, reason: 'ambiguous-file-alias', turnIds: ids,
        coverage: coverage.map(item => ({ ...item, complete: false, reasons: [...new Set([...item.reasons, 'ambiguous-file-alias'])] })),
        conflicts: names.map(filename => ({ path: filename, reason: 'ambiguous-file-alias' })) };
    }
    if (values.some(e => !restorable(e.before) || !restorable(e.after))) return { available: false, reason: 'snapshot-unavailable', turnIds: ids, coverage };
    if (this.#state.turns.some(t => t.status === 'running' && values.some(e => inside(t.cwd, e.path) || Object.hasOwn(t.before, e.path)))) {
      return { available: false, reason: 'workspace-busy', turnIds: ids, coverage };
    }
    for (const entry of values) { this.#readBlob(entry.before); this.#readBlob(entry.after); }
    const plan = { threadId, turnIds: turns.map(t => t.turnId), entries: clone(values), coverage, revision: this.#state.revision, selectedPaths };
    const conflicts = this.#validateEntries(plan);
    if (conflicts.length) return { available: false, reason: 'files-changed', turnIds: ids, coverage, conflicts };
    return { available: true, plan };
  }
  #validateEntries(plan) {
    const scratch = { blobs: {}, coverage: { complete: true, reasons: [] } }, conflicts = [];
    for (const entry of plan.entries) {
      const current = this.#snapshot(entry.path, scratch);
      const restoredByJournal = contentEqual(current, entry.after) && stateEqual(current, this.#state.liveStates[entry.path]);
      if (!stateEqual(current, entry.after) && !restoredByJournal) conflicts.push({ path: entry.path, reason: 'current-file-does-not-match-recorded-post-state' });
    }
    return conflicts;
  }
  prepareRollback(params) {
    return this.#serial(() => {
      const value = this.#rollbackPlan(params);
      if (!value.available) return value;
      const token = randomUUID(); this.#plans.set(token, value.plan);
      return { available: true, token, turnIds: value.plan.turnIds, coverage: value.plan.coverage,
        changes: value.plan.entries.map(e => ({ path: e.path, operation: operation(e.after, e.before), changeIds: e.changeIds })) };
    });
  }
  validateRollback({ threadId, token } = {}) {
    return this.#serial(() => {
      this.#assertWritable(); const plan = this.#plans.get(token);
      if (!plan || plan.threadId !== identifier(threadId, '会话')) return { valid: false, reason: 'rollback-plan-expired' };
      if (plan.revision !== this.#state.revision) return { valid: false, reason: 'journal-changed' };
      const conflicts = this.#validateEntries(plan); return conflicts.length ? { valid: false, reason: 'files-changed', conflicts } : { valid: true };
    });
  }
  checkpointRead({ threadId, turnId, turnIds } = {}) {
    return this.#serial(() => {
      const value = this.#rollbackPlan({ threadId, turnId, turnIds });
      return value.available ? { available: true, turnIds: value.plan.turnIds, coverage: value.plan.coverage,
        files: value.plan.entries.map(e => ({ path: e.path, operation: operation(e.before, e.after), beforeSize: e.before.size ?? 0, afterSize: e.after.size ?? 0 })) } : value;
    });
  }
  rollbackTurn({ threadId, turnId, turnIds, token, paths } = {}) {
    return this.#serial(() => {
      this.#assertWritable(); identifier(threadId, '会话'); let plan;
      if (token) {
        plan = this.#plans.get(token);
        if (!plan || plan.threadId !== threadId) return { applied: false, reason: 'rollback-plan-expired' };
        if (plan.revision !== this.#state.revision) return { applied: false, reason: 'journal-changed' };
      } else {
        const value = this.#rollbackPlan({ threadId, turnId, turnIds, paths });
        if (!value.available) return { applied: false, ...value };
        plan = value.plan;
      }
      const conflicts = this.#validateEntries(plan);
      if (conflicts.length) return { applied: false, reason: 'files-changed', conflicts };
      const id = randomUUID(), filename = path.join(this.transactionsDir, id + '.json');
      const transaction = { id, threadId, turnIds: plan.turnIds, status: 'prepared', createdAt: this.now(), entries: plan.entries.map(e => ({ ...e, phase: 'pending' })) };
      let started = false;
      const save = () => atomicJson(filename, transaction, this.limits.maxIndexBytes);
      try {
        save(); transaction.status = 'committing'; save();
        for (const entry of transaction.entries) {
          // Re-check immediately before each move; existing bytes are preserved in a sibling backup.
          const fresh = this.#validateEntries({ entries: [entry] });
          if (fresh.length) throw failure('CONFLICT', '文件在回退提交前发生变化。', { conflicts: fresh });
          const parent = path.dirname(entry.path), chain = checkDirectories(parent, { create: entry.before.kind === 'file' });
          const prefix = path.join(parent, '.wb-file-journal-' + id + '-' + hash(Buffer.from(entry.path)).slice(0, 12));
          entry.backupPath = prefix + '.backup'; entry.temporaryPath = prefix + '.restore'; save();
          if (entry.before.kind === 'file') {
            const bytes = this.#readBlob(entry.before);
            const fd = fs.openSync(entry.temporaryPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, entry.before.mode & 0o777);
            try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, entry.before.mode & 0o777); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          }
          assertDirectories(chain);
          if (entry.after.kind === 'file') {
            if (fs.existsSync(entry.backupPath)) throw failure('CONFLICT', '回退备份路径已被占用。');
            fs.renameSync(entry.path, entry.backupPath); started = true; entry.phase = 'original-moved'; save();
            const scratch = { blobs: {}, coverage: { complete: true, reasons: [] } };
            const moved = this.#snapshot(entry.backupPath, scratch, { strict: true });
            const restoredByJournal = contentEqual(moved, entry.after) && stateEqual(moved, this.#state.liveStates[entry.path], { moved: true });
            if (!stateEqual(moved, entry.after, { moved: true }) && !restoredByJournal) throw failure('CONFLICT', '提交期间文件被外部修改；已保留实际文件备份，未覆盖。');
          }
          if (entry.before.kind === 'file') {
            assertDirectories(chain);
            // link is no-clobber: a newly-created destination is never overwritten.
            fs.linkSync(entry.temporaryPath, entry.path); started = true;
            fs.unlinkSync(entry.temporaryPath); entry.phase = 'restored';
          } else entry.phase = 'removed';
          syncDirectory(parent); save();
        }
        for (const entry of transaction.entries) {
          const scratch = { blobs: {}, coverage: { complete: true, reasons: [] } };
          const current = this.#snapshot(entry.path, scratch, { strict: true });
          if (!contentEqual(current, entry.before)) throw failure('CONFLICT', '文件回退结果在提交完成前发生变化。');
          this.#state.liveStates[entry.path] = current;
        }
        for (const turn of this.#state.turns.filter(t => t.threadId === threadId && plan.turnIds.includes(t.turnId))) {
          if (plan.selectedPaths) {
            turn.rolledBackPaths = [...new Set([...(turn.rolledBackPaths ?? []), ...plan.selectedPaths])];
            if (turn.changes.every(c => turn.rolledBackPaths.includes(c.path))) turn.rolledBackAt = this.now();
          } else turn.rolledBackAt = this.now();
          turn.rollbackTransactionId = id;
        }
        this.#persist(); transaction.status = 'committed'; transaction.completedAt = this.now(); save();
        const cleanupPending = [];
        for (const entry of transaction.entries) if (entry.after.kind === 'file' && fs.existsSync(entry.backupPath)) {
          try {
            const scratch = { blobs: {}, coverage: { complete: true, reasons: [] } };
            const backup = this.#snapshot(entry.backupPath, scratch, { strict: true });
            if (!stateEqual(backup, entry.after, { moved: true })) throw failure('CONFLICT', '回退备份已变化，保留供人工核对。');
            fs.unlinkSync(entry.backupPath);
          } catch { cleanupPending.push(entry.backupPath); }
        }
        this.#plans.clear();
        return { applied: true, transactionId: id, turnIds: plan.turnIds, changes: transaction.entries.map(e => ({ path: e.path, operation: operation(e.after, e.before) })),
          coverage: plan.coverage, cleanupPending };
      } catch (error) {
        transaction.status = started ? 'failed-partial' : 'failed'; transaction.failedAt = this.now();
        try { save(); } catch {}
        this.#blocked = { code: 'RECOVERY_REQUIRED', reason: '文件回退事务未完整完成；实际文件及备份已保留，后续修改被阻止，需人工核对。',
          transactions: [{ transactionId: id, status: transaction.status, paths: transaction.entries.map(e => e.path) }] };
        throw failure('RECOVERY_REQUIRED', this.#blocked.reason, { transactionId: id, cause: error });
      }
    });
  }
  getRecoveryStatus() { return this.#serial(() => this.#blocked ? { blocked: true, ...clone(this.#blocked) } : { blocked: false }); }
}
