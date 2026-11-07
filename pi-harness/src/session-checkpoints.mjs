import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const MAX_BYTES = 256 * 1024 * 1024;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const THREAD = new RegExp(`^pi-thread-${UUID}$`);
const TURN = new RegExp(`^pi-turn-${UUID}$`);
const TRANSACTION = new RegExp(`^${UUID}$`);
const fail = message => { const e = new Error(message); e.code = 'PI_CHECKPOINT_UNAVAILABLE'; throw e; };
function regular(filename) {
  try {
    const s = fs.lstatSync(filename);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > MAX_BYTES) fail('会话检查点不是受支持的普通文件或超过大小限制。');
    return s;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
const same = (a, b) => a && b && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(k => a[k] === b[k]);
function digest(filename, length) {
  const before = regular(filename);
  if (!before) { if (!length) return createHash('sha256').digest('hex'); fail('会话检查点来源已丢失。'); }
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024);
  try {
    if (!same(before, fs.fstatSync(fd))) fail('读取会话检查点时文件已变化。');
    let offset = 0; const size = length ?? before.size;
    if (size > before.size) fail('会话检查点长度不完整。');
    while (offset < size) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (!n) fail('会话检查点读取不完整。'); hash.update(chunk.subarray(0, n)); offset += n;
    }
    if (!same(before, fs.fstatSync(fd)) || !same(before, regular(filename))) fail('读取会话检查点时文件已变化。');
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function writeJson(filename, value) {
  const temp = filename + '.' + randomUUID();
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); sync(temp); fs.renameSync(temp, filename); sync(path.dirname(filename));
}
function sync(filename) { const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function privateDirectory(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077
    || process.getuid && stat.uid !== process.getuid() || fs.realpathSync(filename) !== filename) fail('会话检查点目录不安全。');
}
function transactionBinding(value) {
  if (!value || value.version !== 1 || !THREAD.test(value.threadId) || !TURN.test(value.turnId)
    || typeof value.currentExisted !== 'boolean' || !/^[a-f0-9]{64}$/.test(value.currentSHA256 ?? '')
    || value.checkpoint?.version !== 1 || typeof value.checkpoint.existed !== 'boolean'
    || value.checkpoint.threadId !== value.threadId || value.checkpoint.turnId !== value.turnId
    || !Number.isSafeInteger(value.checkpoint.bytes) || value.checkpoint.bytes < 0 || value.checkpoint.bytes > MAX_BYTES
    || !/^[a-f0-9]{64}$/.test(value.checkpoint.sha256 ?? '')
    || !value.checkpoint.existed && value.checkpoint.bytes !== 0) fail('会话回退事务无效。');
  return { version: 1, threadId: value.threadId, turnId: value.turnId, checkpoint: value.checkpoint,
    currentExisted: value.currentExisted, currentSHA256: value.currentSHA256 };
}
/** Append-only Pi history checkpoints retain an exact prefix, not one full copy per turn. */
export class SessionCheckpoints {
  constructor({ stateDir }) {
    const supplied = path.resolve(stateDir);
    this.stateDir = fs.realpathSync(stateDir);
    if (supplied !== this.stateDir) fail('会话目录不可通过符号链接访问。');
    privateDirectory(this.stateDir); this.root = path.join(this.stateDir, 'rewind-backups');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    privateDirectory(this.root);
  }
  filename(threadId) {
    if (!THREAD.test(threadId)) fail('检查点任务标识无效。');
    const root = path.join(this.stateDir, 'sessions');
    privateDirectory(root);
    return path.join(root, `${threadId}.jsonl`);
  }
  capture({ threadId, turnId }) {
    if (!TURN.test(turnId)) fail('检查点轮次标识无效。');
    const file = this.filename(threadId), stat = regular(file);
    return { version: 1, threadId, turnId, existed: Boolean(stat), bytes: stat?.size ?? 0, sha256: digest(file, stat?.size ?? 0) };
  }
  prepareRestore({ threadId, turnId, checkpoint }) {
    if (!TURN.test(turnId) || checkpoint?.version !== 1 || checkpoint.threadId !== threadId || checkpoint.turnId !== turnId || typeof checkpoint.existed !== 'boolean'
      || !Number.isSafeInteger(checkpoint.bytes) || checkpoint.bytes < 0 || checkpoint.bytes > MAX_BYTES
      || !/^[a-f0-9]{64}$/.test(checkpoint.sha256 ?? '') || !checkpoint.existed && checkpoint.bytes !== 0) fail('当前轮次没有可验证的会话检查点。');
    const file = this.filename(threadId), current = regular(file);
    if (digest(file, checkpoint.bytes) !== checkpoint.sha256) fail('会话检查点与当前历史不一致，已拒绝回退。');
    const op = path.join(this.root, randomUUID()); fs.mkdirSync(op, { mode: 0o700 });
    const currentSHA256 = digest(file), before = path.join(op, 'session-before-rewind.jsonl');
    if (current) {
      fs.copyFileSync(file, before, fs.constants.COPYFILE_EXCL); fs.chmodSync(before, 0o600);
      sync(before);
      if (!same(current, regular(file)) || digest(before) !== currentSHA256) fail('准备回退时会话已变化。');
    }
    const target = path.join(op, 'restore.jsonl');
    if (checkpoint.existed) {
      const data = fs.readFileSync(before).subarray(0, checkpoint.bytes);
      fs.writeFileSync(target, data, { mode: 0o600, flag: 'wx' });
      sync(target);
      if (digest(target) !== checkpoint.sha256) fail('检查点副本校验失败。');
    }
    const transaction = { version: 1, threadId, turnId, checkpoint, currentExisted: Boolean(current), currentSHA256, status: 'prepared' };
    writeJson(path.join(op, 'transaction.json'), transaction);
    return { id: path.basename(op), ...transaction };
  }
  restore(prepared) {
    const { op, record } = this.#transaction(prepared, 'prepared');
    const file = this.filename(record.threadId);
    if (record.status !== 'prepared' || record.currentExisted !== Boolean(regular(file)) || digest(file) !== record.currentSHA256) fail('回退期间会话已变化，未覆盖当前历史。');
    if (record.checkpoint.existed) {
      const target = path.join(op, 'restore.jsonl');
      if (digest(target) !== record.checkpoint.sha256) fail('检查点副本校验失败。');
      fs.renameSync(target, file);
    } else if (regular(file)) fs.renameSync(file, path.join(op, 'retired-session.jsonl'));
    sync(path.dirname(file)); sync(op);
    record.status = 'session-restored'; writeJson(path.join(op, 'transaction.json'), record);
    return { restored: true, backupId: prepared.id };
  }
  complete(prepared) {
    const { op, record } = this.#transaction(prepared, 'session-restored');
    const filename = path.join(op, 'transaction.json');
    record.status = 'complete'; writeJson(filename, record);
  }
  #transaction(prepared, status) {
    if (!TRANSACTION.test(prepared?.id ?? '')) fail('回退事务标识无效。');
    privateDirectory(this.stateDir); privateDirectory(this.root);
    const binding = transactionBinding(prepared), op = path.join(this.root, prepared.id);
    privateDirectory(op);
    const filename = path.join(op, 'transaction.json'), stat = regular(filename);
    if (!stat || stat.size > 16 * 1024) fail('回退事务文件无效或过大。');
    let record; const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!same(stat, fs.fstatSync(fd))) fail('回退事务文件已变化。');
      record = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (!same(stat, fs.fstatSync(fd)) || !same(stat, regular(filename))) fail('回退事务文件已变化。');
    } catch { fail('回退事务文件无法读取。'); } finally { fs.closeSync(fd); }
    if (!isDeepStrictEqual(binding, transactionBinding(record)) || record.status !== status) fail('回退事务身份或状态已变化。');
    return { op, record };
  }
}
