import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SessionCheckpoints } from '../src/session-checkpoints.mjs';

const MAX_BYTES = 256 * 1024 * 1024;
const prefix = '{"type":"session","id":"synthetic-session"}\n';
const tail = '{"type":"message","message":{"role":"user","content":"synthetic-turn"}}\n';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const unavailable = error => error.code === 'PI_CHECKPOINT_UNAVAILABLE';

function temporary(t, initial = prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-checkpoint-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const sessions = path.join(stateDir, 'sessions');
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  const threadId = `pi-thread-${randomUUID()}`;
  const turnId = `pi-turn-${randomUUID()}`;
  const filename = path.join(sessions, `${threadId}.jsonl`);
  if (initial !== null) fs.writeFileSync(filename, initial, { mode: 0o600 });
  const store = new SessionCheckpoints({ stateDir });
  return { root, stateDir, sessions, threadId, turnId, filename, store };
}

function prepared(t, initial = prefix) {
  const f = temporary(t, initial);
  const checkpoint = f.store.capture(f);
  fs.appendFileSync(f.filename, tail, { mode: 0o600 });
  const transaction = f.store.prepareRestore({ ...f, checkpoint });
  const operation = path.join(f.store.root, transaction.id);
  return { ...f, checkpoint, transaction, operation };
}

test('capture stores only an exact prefix descriptor and does not copy history per turn', t => {
  const f = temporary(t);
  const checkpoint = f.store.capture(f);
  assert.equal(checkpoint.version, 1);
  assert.equal(checkpoint.existed, true);
  assert.equal(checkpoint.bytes, Buffer.byteLength(prefix));
  assert.equal(checkpoint.sha256, sha256(prefix));
  assert.deepEqual(fs.readdirSync(f.store.root), []);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), prefix);
});

test('prepare retains full original history and restore installs only the captured prefix', t => {
  const f = prepared(t);
  const original = prefix + tail;
  assert.equal(fs.readFileSync(f.filename, 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(f.operation, 'session-before-rewind.jsonl'), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(f.operation, 'restore.jsonl'), 'utf8'), prefix);
  const result = f.store.restore(f.transaction);
  assert.equal(result.restored, true);
  assert.equal(result.backupId, f.transaction.id);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), prefix);
  assert.equal(fs.readFileSync(path.join(f.operation, 'session-before-rewind.jsonl'), 'utf8'), original);
  assert.equal(fs.statSync(f.filename).mode & 0o777, 0o600);
  f.store.complete(f.transaction);
  const record = JSON.parse(fs.readFileSync(path.join(f.operation, 'transaction.json')));
  assert.equal(record.status, 'complete');
  assert.throws(() => f.store.restore(f.transaction), unavailable);
  assert.throws(() => f.store.complete(f.transaction), unavailable);
});

test('first-turn missing history is restored as missing while retaining complete created history', t => {
  const f = prepared(t, null);
  assert.equal(f.checkpoint.existed, false);
  assert.equal(f.checkpoint.bytes, 0);
  assert.equal(f.checkpoint.sha256, sha256(''));
  f.store.restore(f.transaction);
  assert.equal(fs.existsSync(f.filename), false);
  assert.equal(fs.readFileSync(path.join(f.operation, 'session-before-rewind.jsonl'), 'utf8'), tail);
  assert.equal(fs.readFileSync(path.join(f.operation, 'retired-session.jsonl'), 'utf8'), tail);
  f.store.complete(f.transaction);
});

test('empty existing history remains an existing empty file after restore', t => {
  const f = prepared(t, '');
  assert.equal(f.checkpoint.existed, true);
  f.store.restore(f.transaction);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), '');
  f.store.complete(f.transaction);
});

test('prepared transactions survive store restart without creating or starting any Pi client', t => {
  const f = prepared(t);
  const checkpointCopy = JSON.parse(JSON.stringify(f.transaction));
  const restarted = new SessionCheckpoints({ stateDir: f.stateDir });
  restarted.restore(checkpointCopy);
  const restartedAgain = new SessionCheckpoints({ stateDir: f.stateDir });
  restartedAgain.complete(checkpointCopy);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), prefix);
});

test('changed prefix and truncated history fail before any restore transaction is written', t => {
  for (const replacement of ['x' + prefix.slice(1) + tail, prefix.slice(0, -1)]) {
    const f = temporary(t);
    const checkpoint = f.store.capture(f);
    fs.writeFileSync(f.filename, replacement);
    assert.throws(() => f.store.prepareRestore({ ...f, checkpoint }), unavailable);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), replacement);
    assert.deepEqual(fs.readdirSync(f.store.root), []);
  }
});

test('append or replacement after prepare is never overwritten by a stale transaction', t => {
  for (const replacement of [prefix + tail + tail, 'externally-replaced-history\n']) {
    const f = prepared(t);
    fs.writeFileSync(f.filename, replacement);
    assert.throws(() => f.store.restore(f.transaction), unavailable);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), replacement);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.operation, 'transaction.json'))).status, 'prepared');
  }
});

test('tampered restore prefix cannot replace current history', t => {
  const f = prepared(t);
  fs.writeFileSync(path.join(f.operation, 'restore.jsonl'), 'tampered-prefix');
  assert.throws(() => f.store.restore(f.transaction), unavailable);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), prefix + tail);
});

test('disk transaction fields remain bound to the server-owned prepared record', t => {
  for (const mutate of [
    r => { r.turnId = `pi-turn-${randomUUID()}`; },
    r => { r.threadId = `pi-thread-${randomUUID()}`; },
    r => { r.currentSHA256 = sha256('other-history'); },
    r => { r.checkpoint.sha256 = sha256('forged-prefix'); },
    r => { r.checkpoint.bytes = 1; },
    r => { r.checkpoint.version = 2; },
    r => { r.status = 'session-restored'; },
  ]) {
    const f = prepared(t);
    const file = path.join(f.operation, 'transaction.json');
    const record = JSON.parse(fs.readFileSync(file));
    mutate(record); fs.writeFileSync(file, JSON.stringify(record));
    assert.throws(() => f.store.restore(f.transaction), unavailable);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), prefix + tail);
  }
});

test('forged prepared fields and malformed transaction JSON fail closed', t => {
  const f = prepared(t);
  assert.throws(() => f.store.restore({ ...f.transaction, turnId: `pi-turn-${randomUUID()}` }), unavailable);
  fs.writeFileSync(path.join(f.operation, 'transaction.json'), '{broken');
  assert.throws(() => f.store.restore(f.transaction), unavailable);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), prefix + tail);
});

test('oversized history, descriptor and transaction metadata are rejected without reading huge payloads', t => {
  const f = temporary(t);
  fs.truncateSync(f.filename, MAX_BYTES + 1);
  assert.throws(() => f.store.capture(f), unavailable);
  fs.writeFileSync(f.filename, prefix);
  const checkpoint = f.store.capture(f);
  assert.throws(() => f.store.prepareRestore({ ...f, checkpoint: { ...checkpoint, bytes: MAX_BYTES + 1 } }), unavailable);
  assert.throws(() => f.store.prepareRestore({ ...f, checkpoint: { ...checkpoint, bytes: -1 } }), unavailable);
  assert.throws(() => f.store.prepareRestore({ ...f, checkpoint: { ...checkpoint, bytes: 1.5 } }), unavailable);
  const next = prepared(t);
  fs.writeFileSync(path.join(next.operation, 'transaction.json'), ' '.repeat(16 * 1024 + 1));
  assert.throws(() => next.store.restore(next.transaction), unavailable);
});

test('invalid thread, turn and transaction identifiers cannot escape their directories', t => {
  const f = temporary(t);
  const checkpoint = f.store.capture(f);
  for (const value of ['../outside', '/tmp/outside', '', 'pi-thread-../../outside', 'pi-turn-../../outside', null, 1]) {
    assert.throws(() => f.store.capture({ ...f, threadId: value }), unavailable);
    assert.throws(() => f.store.capture({ ...f, turnId: value }), unavailable);
    assert.throws(() => f.store.prepareRestore({ ...f, turnId: value, checkpoint }), unavailable);
  }
  const next = prepared(t);
  const outside = path.join(next.root, 'outside'); fs.mkdirSync(outside, { mode: 0o700 });
  const externalTransaction = path.join(outside, 'transaction.json');
  fs.writeFileSync(externalTransaction, JSON.stringify({ status: 'session-restored' }));
  const before = fs.readFileSync(externalTransaction, 'utf8');
  for (const id of ['../../outside', path.join(next.root, 'outside'), '', undefined, 'abc']) {
    assert.throws(() => next.store.restore({ ...next.transaction, id }), unavailable);
    assert.throws(() => next.store.complete({ ...next.transaction, id }), unavailable);
  }
  assert.equal(fs.readFileSync(externalTransaction, 'utf8'), before);
});

test('checkpoint descriptors require a valid version, existence flag, size and digest', t => {
  const f = temporary(t);
  const checkpoint = f.store.capture(f);
  for (const invalid of [null, {}, { ...checkpoint, version: 2 }, { ...checkpoint, existed: 'true' },
    { ...checkpoint, sha256: 'bad' }, { ...checkpoint, sha256: 'A'.repeat(64) },
    { ...checkpoint, existed: false, bytes: 1 }]) {
    assert.throws(() => f.store.prepareRestore({ ...f, checkpoint: invalid }), unavailable);
  }
});

test('checkpoint descriptors are bound to the capturing thread and turn', t => {
  const f = temporary(t);
  const checkpoint = f.store.capture(f);
  assert.equal(checkpoint.threadId, f.threadId);
  assert.equal(checkpoint.turnId, f.turnId);
  for (const changed of [
    { ...checkpoint, threadId: `pi-thread-${randomUUID()}` },
    { ...checkpoint, turnId: `pi-turn-${randomUUID()}` },
  ]) assert.throws(() => f.store.prepareRestore({ ...f, checkpoint: changed }), unavailable);
  const anotherThread = `pi-thread-${randomUUID()}`;
  fs.writeFileSync(path.join(f.sessions, `${anotherThread}.jsonl`), prefix, { mode: 0o600 });
  assert.throws(() => f.store.prepareRestore({ ...f, threadId: anotherThread, checkpoint }), unavailable);
  assert.throws(() => f.store.prepareRestore({ ...f, turnId: `pi-turn-${randomUUID()}`, checkpoint }), unavailable);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), prefix);
});

test('UUID-shaped identifiers require canonical hexadecimal groups', t => {
  const f = temporary(t);
  for (const suffix of ['-'.repeat(36), 'a'.repeat(36), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa-']) {
    assert.throws(() => f.store.capture({ ...f, threadId: 'pi-thread-' + suffix }), unavailable);
    assert.throws(() => f.store.capture({ ...f, turnId: 'pi-turn-' + suffix }), unavailable);
  }
  const next = prepared(t);
  for (const id of ['-'.repeat(36), 'a'.repeat(36)]) {
    assert.throws(() => next.store.restore({ ...next.transaction, id }), unavailable);
    assert.throws(() => next.store.complete({ ...next.transaction, id }), unavailable);
  }
});

test('only the named session is modified and sibling files or other thread histories stay intact', t => {
  const f = prepared(t);
  const other = path.join(f.sessions, `pi-thread-${randomUUID()}.jsonl`);
  const sibling = path.join(f.stateDir, 'threads.json');
  fs.writeFileSync(other, 'other-thread-history\n', { mode: 0o600 });
  fs.writeFileSync(sibling, '{"fixture":"host-state"}', { mode: 0o600 });
  f.store.restore(f.transaction); f.store.complete(f.transaction);
  assert.equal(fs.readFileSync(other, 'utf8'), 'other-thread-history\n');
  assert.equal(fs.readFileSync(sibling, 'utf8'), '{"fixture":"host-state"}');
});

test('state, sessions and backup directories reject symlinks and nonprivate modes', t => {
  const f = temporary(t);
  const alias = path.join(f.root, 'state-alias'); fs.symlinkSync(f.stateDir, alias);
  assert.throws(() => new SessionCheckpoints({ stateDir: alias }), unavailable);
  fs.chmodSync(f.stateDir, 0o755);
  assert.throws(() => new SessionCheckpoints({ stateDir: f.stateDir }), unavailable);
  fs.chmodSync(f.stateDir, 0o700);
  fs.chmodSync(f.sessions, 0o755);
  assert.throws(() => f.store.capture(f), unavailable);
  fs.chmodSync(f.sessions, 0o700);
  fs.chmodSync(f.store.root, 0o777);
  assert.throws(() => new SessionCheckpoints({ stateDir: f.stateDir }), unavailable);
});

test('session file and sessions-directory symlinks never read or overwrite an external file', t => {
  const f = temporary(t);
  const external = path.join(f.root, 'external.jsonl'); fs.writeFileSync(external, 'outside-history\n');
  fs.unlinkSync(f.filename); fs.symlinkSync(external, f.filename);
  assert.throws(() => f.store.capture(f), unavailable);
  fs.unlinkSync(f.filename);
  fs.renameSync(f.sessions, path.join(f.root, 'real-sessions'));
  fs.symlinkSync(path.join(f.root, 'real-sessions'), f.sessions);
  assert.throws(() => f.store.capture(f), unavailable);
  assert.equal(fs.readFileSync(external, 'utf8'), 'outside-history\n');
});

test('backup root symlinks are rejected before transaction files are written', t => {
  const f = temporary(t);
  const external = path.join(f.root, 'external-backups'); fs.mkdirSync(external, { mode: 0o700 });
  fs.rmdirSync(f.store.root); fs.symlinkSync(external, f.store.root);
  assert.throws(() => new SessionCheckpoints({ stateDir: f.stateDir }), unavailable);
  assert.deepEqual(fs.readdirSync(external), []);
});

test('operation and transaction symlinks are rejected by both restore and complete', t => {
  for (const target of ['operation', 'transaction']) {
    const f = prepared(t);
    const moved = path.join(f.root, `moved-${target}`);
    if (target === 'operation') {
      fs.renameSync(f.operation, moved); fs.symlinkSync(moved, f.operation);
    } else {
      const txn = path.join(f.operation, 'transaction.json');
      fs.renameSync(txn, moved); fs.symlinkSync(moved, txn);
    }
    assert.throws(() => f.store.restore(f.transaction), unavailable);
    assert.throws(() => f.store.complete(f.transaction), unavailable);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), prefix + tail);
  }
});

test('restore target symlink is rejected without touching the linked file', t => {
  const f = prepared(t), target = path.join(f.operation, 'restore.jsonl');
  const external = path.join(f.root, 'external-prefix'); fs.writeFileSync(external, prefix);
  fs.unlinkSync(target); fs.symlinkSync(external, target);
  assert.throws(() => f.store.restore(f.transaction), unavailable);
  assert.equal(fs.readFileSync(external, 'utf8'), prefix);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), prefix + tail);
});

test('hardlinked sessions and restore targets cannot alias files outside the owned session path', t => {
  const f = temporary(t);
  const external = path.join(f.root, 'external-history');
  fs.writeFileSync(external, prefix, { mode: 0o600 });
  fs.unlinkSync(f.filename); fs.linkSync(external, f.filename);
  assert.throws(() => f.store.capture(f), unavailable);
  assert.equal(fs.readFileSync(external, 'utf8'), prefix);

  const next = prepared(t);
  const externalPrefix = path.join(next.root, 'external-prefix');
  fs.writeFileSync(externalPrefix, prefix, { mode: 0o600 });
  const target = path.join(next.operation, 'restore.jsonl');
  fs.unlinkSync(target); fs.linkSync(externalPrefix, target);
  assert.throws(() => next.store.restore(next.transaction), unavailable);
  assert.equal(fs.readFileSync(next.filename, 'utf8'), prefix + tail);
  assert.equal(fs.readFileSync(externalPrefix, 'utf8'), prefix);
});

test('hardlinked transaction metadata is rejected rather than trusted through an alias', t => {
  const f = prepared(t);
  const transactionFile = path.join(f.operation, 'transaction.json');
  const alias = path.join(f.root, 'external-transaction.json');
  fs.linkSync(transactionFile, alias);
  assert.throws(() => f.store.restore(f.transaction), unavailable);
  assert.throws(() => f.store.complete(f.transaction), unavailable);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), prefix + tail);
});

test('backup directories and every persisted file remain private', t => {
  const f = prepared(t);
  assert.equal(fs.statSync(f.store.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.operation).mode & 0o777, 0o700);
  for (const name of ['session-before-rewind.jsonl', 'restore.jsonl', 'transaction.json']) {
    assert.equal(fs.statSync(path.join(f.operation, name)).mode & 0o777, 0o600);
  }
});
