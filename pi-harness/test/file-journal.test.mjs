import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { FileJournal, FILE_JOURNAL_IGNORED } from '../src/file-journal.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const codeIs = code => error => error.code === `FILE_JOURNAL_${code}`;
function fixture(t, limits = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-file-journal-')));
  const cwd = path.join(root, 'work'), stateDir = path.join(root, 'state'); fs.mkdirSync(cwd, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cwd, stateDir, journal: new FileJournal({ stateDir, limits }) };
}
async function begin(journal, cwd, turnId = 'turn-1', threadId = 'thread-1') { return journal.beginTurn({ threadId, turnId, cwd }); }
async function before(journal, toolName, args, turnId = 'turn-1', threadId = 'thread-1') { return journal.beforeTool({ threadId, turnId, toolName, args }); }
async function finish(journal, turnId = 'turn-1', threadId = 'thread-1', status = 'completed') { return journal.finishTurn({ threadId, turnId, status }); }

test('records a newly written artifact without storing document bytes in the index', async t => {
  const { cwd, stateDir, journal } = fixture(t); await begin(journal, cwd);
  await before(journal, 'write', { path: 'report.txt' });
  fs.writeFileSync(path.join(cwd, 'report.txt'), 'PRIVATE-SYNTHETIC-REPORT');
  const result = await finish(journal);
  assert.equal(result.rollbackAvailable, true); assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].operation, 'created'); assert.equal(result.changes[0].before.kind, 'missing');
  const files = await journal.listArtifacts({ threadId: 'thread-1' });
  assert.equal(files.length, 1); assert.equal(files[0].mimeType, 'text/plain'); assert.equal(files[0].relativePath, 'report.txt');
  assert.equal(files[0].exists, true); assert.equal(files[0].status, 'available');
  assert.doesNotMatch(fs.readFileSync(path.join(stateDir, 'index.json'), 'utf8'), /PRIVATE-SYNTHETIC-REPORT/);
  for (const filename of [stateDir, path.join(stateDir, 'blobs'), path.join(stateDir, 'transactions')]) assert.equal(fs.statSync(filename).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(stateDir, 'index.json')).mode & 0o777, 0o600);
});

test('preserves before/after text and computes a bounded real unified diff', async t => {
  const { cwd, journal } = fixture(t); fs.writeFileSync(path.join(cwd, 'note.md'), 'before\nunchanged\n');
  await begin(journal, cwd); await before(journal, 'edit', { path: 'note.md' });
  fs.writeFileSync(path.join(cwd, 'note.md'), 'after\nunchanged\n');
  const result = await finish(journal), change = result.changes[0];
  assert.equal(change.operation, 'modified'); assert.equal(change.before.sha256, digest('before\nunchanged\n'));
  const detail = await journal.getChangeDetail({ threadId: 'thread-1', changeId: change.id });
  assert.equal(detail.diffAvailable, true); assert.equal(detail.beforeText, 'before\nunchanged\n'); assert.equal(detail.afterText, 'after\nunchanged\n');
  assert.match(detail.diff, /-before\n\+after/); assert.match(detail.diff, /before\/note.md/);
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) < 48 * 1024);
});

test('Bash baseline finds new, modified and deleted workspace files while excluding caches and its own journal', async t => {
  const { root, cwd } = fixture(t), stateDir = path.join(cwd, '.snapshots');
  const journal = new FileJournal({ stateDir });
  fs.mkdirSync(path.join(cwd, 'node_modules')); fs.mkdirSync(path.join(cwd, '.git'));
  fs.writeFileSync(path.join(cwd, 'node_modules/secret.txt'), 'must-not-capture'); fs.writeFileSync(path.join(cwd, '.git/config'), 'must-not-capture');
  fs.writeFileSync(path.join(cwd, 'edit.txt'), 'old'); fs.writeFileSync(path.join(cwd, 'remove.txt'), 'delete fixture');
  await begin(journal, cwd); await before(journal, 'bash', { command: 'synthetic only' });
  fs.writeFileSync(path.join(cwd, 'edit.txt'), 'new'); fs.unlinkSync(path.join(cwd, 'remove.txt'));
  fs.mkdirSync(path.join(cwd, 'out')); fs.writeFileSync(path.join(cwd, 'out/new.csv'), 'name,value\na,1');
  const value = await finish(journal);
  assert.equal(value.coverage.scope, 'workspace-and-explicit-tool-files'); assert.deepEqual(value.coverage.ignoredNames, FILE_JOURNAL_IGNORED);
  assert.deepEqual(value.changes.map(c => [c.relativePath, c.operation]), [['edit.txt', 'modified'], ['out/new.csv', 'created'], ['remove.txt', 'deleted']]);
  assert.equal(value.coverage.complete, true); assert.equal(value.rollbackAvailable, true);
  assert.equal(fs.existsSync(path.join(stateDir, 'blobs', digest('must-not-capture'))), false);
  assert.equal(root.startsWith('/'), true);
});

test('an explicit file outside cwd is tracked only when selected by a write/edit tool', async t => {
  const { root, cwd, journal } = fixture(t), outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'outside old'); fs.writeFileSync(path.join(root, 'unselected.txt'), 'do not capture');
  await begin(journal, cwd); await before(journal, 'edit', { path: outside }); fs.writeFileSync(outside, 'outside new');
  const value = await finish(journal); assert.equal(value.changes.length, 1); assert.equal(value.changes[0].path, outside);
  assert.equal(value.changes[0].relativePath, outside);
  assert.equal((await journal.rollbackTurn({ threadId: 'thread-1', turnId: 'turn-1' })).applied, true);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside old');
});

test('combining explicit edits and a later Bash scan keeps the original pre-turn baseline', async t => {
  const { cwd, journal } = fixture(t), filename = path.join(cwd, 'value.txt'); fs.writeFileSync(filename, 'start');
  await begin(journal, cwd); await before(journal, 'edit', { path: 'value.txt' }); fs.writeFileSync(filename, 'middle');
  await journal.afterTool({ threadId: 'thread-1', turnId: 'turn-1' });
  await before(journal, 'bash', { command: 'synthetic' }); fs.writeFileSync(filename, 'end');
  const value = await finish(journal); assert.equal(value.changes[0].before.sha256, digest('start')); assert.equal(value.changes[0].after.sha256, digest('end'));
  const rollback = await journal.rollbackTurn({ threadId: 'thread-1', turnId: 'turn-1' }); assert.equal(rollback.applied, true);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'start');
});

test('new binary documents appear as artifacts and can be safely removed by undo', async t => {
  const { cwd, journal } = fixture(t), bytes = Buffer.from([0x50, 0x4b, 0, 1, 2, 3, 255]);
  await begin(journal, cwd); await before(journal, 'write', { path: 'report.xlsx' }); fs.writeFileSync(path.join(cwd, 'report.xlsx'), bytes);
  const value = await finish(journal), detail = await journal.getChangeDetail({ threadId: 'thread-1', changeId: value.changes[0].id });
  assert.equal(detail.binary, true); assert.equal(detail.diffAvailable, false); assert.equal(detail.reason, 'binary-file');
  assert.equal((await journal.listArtifacts({ threadId: 'thread-1' }))[0].mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal((await journal.rollbackTurn({ threadId: 'thread-1', turnId: 'turn-1' })).applied, true);
  assert.equal(fs.existsSync(path.join(cwd, 'report.xlsx')), false); assert.deepEqual(await journal.listArtifacts({ threadId: 'thread-1' }), []);
});

test('restores modified and deleted bytes, removes created files, and preserves prior file mode', async t => {
  const { cwd, journal } = fixture(t); fs.writeFileSync(path.join(cwd, 'modified.txt'), 'before', { mode: 0o640 });
  fs.writeFileSync(path.join(cwd, 'deleted.bin'), Buffer.from([1, 0, 2, 255]));
  await begin(journal, cwd); await before(journal, 'bash', {});
  fs.writeFileSync(path.join(cwd, 'modified.txt'), 'after'); fs.chmodSync(path.join(cwd, 'modified.txt'), 0o600);
  fs.unlinkSync(path.join(cwd, 'deleted.bin')); fs.writeFileSync(path.join(cwd, 'created.txt'), 'new'); await finish(journal);
  const prepared = await journal.prepareRollback({ threadId: 'thread-1', turnId: 'turn-1' }); assert.equal(prepared.available, true);
  assert.deepEqual(await journal.validateRollback({ threadId: 'thread-1', token: prepared.token }), { valid: true });
  const result = await journal.rollbackTurn({ threadId: 'thread-1', token: prepared.token }); assert.equal(result.applied, true);
  assert.equal(fs.readFileSync(path.join(cwd, 'modified.txt'), 'utf8'), 'before'); assert.equal(fs.statSync(path.join(cwd, 'modified.txt')).mode & 0o777, 0o640);
  assert.deepEqual(fs.readFileSync(path.join(cwd, 'deleted.bin')), Buffer.from([1, 0, 2, 255])); assert.equal(fs.existsSync(path.join(cwd, 'created.txt')), false);
  assert.equal((await journal.listManifests({ threadId: 'thread-1' }))[0].rolledBackAt !== null, true);
});

test('multi-turn rollback combines earliest before and latest after in journal order', async t => {
  const { cwd, journal } = fixture(t), file = path.join(cwd, 'file.txt'); fs.writeFileSync(file, 'zero');
  await begin(journal, cwd, 'turn-1'); await before(journal, 'edit', { path: 'file.txt' }, 'turn-1'); fs.writeFileSync(file, 'one'); await finish(journal, 'turn-1');
  await begin(journal, cwd, 'turn-2'); await before(journal, 'edit', { path: 'file.txt' }, 'turn-2'); fs.writeFileSync(file, 'two'); await finish(journal, 'turn-2');
  const plan = await journal.prepareRollback({ threadId: 'thread-1', turnIds: ['turn-2', 'turn-1'] });
  assert.equal(plan.available, true); assert.deepEqual(plan.turnIds, ['turn-1', 'turn-2']); assert.equal(plan.changes.length, 1);
  const result = await journal.rollbackTurn({ threadId: 'thread-1', token: plan.token }); assert.equal(result.applied, true); assert.equal(fs.readFileSync(file, 'utf8'), 'zero');
});

test('successive undos recognize this journal own restored identity, including after restart', async t => {
  const { cwd, stateDir, journal } = fixture(t), file = path.join(cwd, 'file.txt'); fs.writeFileSync(file, 'zero');
  await begin(journal, cwd, 'turn-1'); await before(journal, 'edit', { path: 'file.txt' }, 'turn-1'); fs.writeFileSync(file, 'one'); await finish(journal, 'turn-1');
  await begin(journal, cwd, 'turn-2'); await before(journal, 'edit', { path: 'file.txt' }, 'turn-2'); fs.writeFileSync(file, 'two'); await finish(journal, 'turn-2');
  assert.equal((await journal.rollbackTurn({ threadId: 'thread-1', turnId: 'turn-2' })).applied, true); assert.equal(fs.readFileSync(file, 'utf8'), 'one');
  const restored = new FileJournal({ stateDir });
  assert.equal((await restored.listFiles({ threadId: 'thread-1' }))[0].currentChanged, false);
  assert.equal((await restored.rollbackTurn({ threadId: 'thread-1', turnId: 'turn-1' })).applied, true); assert.equal(fs.readFileSync(file, 'utf8'), 'zero');
});

test('refuses external edits even when content is later rewritten to identical bytes', async t => {
  const { cwd, journal } = fixture(t), file = path.join(cwd, 'file.txt'); fs.writeFileSync(file, 'old');
  await begin(journal, cwd); await before(journal, 'edit', { path: 'file.txt' }); fs.writeFileSync(file, 'new'); await finish(journal);
  const plan = await journal.prepareRollback({ threadId: 'thread-1', turnId: 'turn-1' }); assert.equal(plan.available, true);
  fs.writeFileSync(file, 'externally changed');
  const rejected = await journal.rollbackTurn({ threadId: 'thread-1', token: plan.token }); assert.equal(rejected.applied, false); assert.equal(rejected.reason, 'files-changed');
  assert.equal(fs.readFileSync(file, 'utf8'), 'externally changed');
  fs.writeFileSync(file, 'new');
  const again = await journal.prepareRollback({ threadId: 'thread-1', turnId: 'turn-1' }); assert.equal(again.available, false); assert.equal(again.reason, 'files-changed');
});

test('refuses undo of an older turn overwritten by a different active or completed thread', async t => {
  const { cwd, journal } = fixture(t), file = path.join(cwd, 'shared.txt'); fs.writeFileSync(file, 'base');
  await begin(journal, cwd); await before(journal, 'edit', { path: 'shared.txt' }); fs.writeFileSync(file, 'first'); await finish(journal);
  await begin(journal, cwd, 'other-turn', 'other-thread');
  assert.equal((await journal.prepareRollback({ threadId: 'thread-1', turnId: 'turn-1' })).reason, 'workspace-busy');
  await before(journal, 'edit', { path: 'shared.txt' }, 'other-turn', 'other-thread'); fs.writeFileSync(file, 'other'); await finish(journal, 'other-turn', 'other-thread');
  assert.equal((await journal.prepareRollback({ threadId: 'thread-1', turnId: 'turn-1' })).reason, 'files-changed');
  assert.equal(fs.readFileSync(file, 'utf8'), 'other');
});

test('prepared token binds the thread and journal revision, and preparation does not modify user files', async t => {
  const { cwd, journal } = fixture(t), file = path.join(cwd, 'a.txt');
  await begin(journal, cwd); await before(journal, 'write', { path: 'a.txt' }); fs.writeFileSync(file, 'a'); await finish(journal);
  const plan = await journal.prepareRollback({ threadId: 'thread-1', turnId: 'turn-1' }); assert.equal(plan.available, true); assert.equal(fs.readFileSync(file, 'utf8'), 'a');
  assert.equal((await journal.validateRollback({ threadId: 'another-thread', token: plan.token })).valid, false);
  await begin(journal, cwd, 'turn-2');
  assert.equal((await journal.validateRollback({ threadId: 'thread-1', token: plan.token })).reason, 'journal-changed');
});

test('refuses symlinks, hardlinks and traversal for explicit tool files without reading target contents', async t => {
  const { root, cwd, stateDir, journal } = fixture(t), outside = path.join(root, 'outside.txt'); fs.writeFileSync(outside, 'NEVER-CAPTURE-SYMLINK-TARGET');
  fs.symlinkSync(outside, path.join(cwd, 'link.txt')); fs.linkSync(outside, path.join(cwd, 'hard.txt'));
  fs.mkdirSync(path.join(root, 'outside-dir')); fs.symlinkSync(path.join(root, 'outside-dir'), path.join(cwd, 'link-dir'));
  await begin(journal, cwd);
  for (const name of ['link.txt', 'hard.txt', 'link-dir/file.txt']) await assert.rejects(before(journal, 'write', { path: name }), codeIs('UNSAFE_PATH'));
  for (const name of ['../outside.txt', 'a/../outside.txt', 'bad\u0000.txt']) await assert.rejects(before(journal, 'write', { path: name }), codeIs('PATH_INVALID'));
  await assert.rejects(before(journal, 'write', { path: path.join(stateDir, 'index.json') }), codeIs('UNSAFE_PATH'));
  assert.equal(fs.existsSync(path.join(stateDir, 'blobs', digest('NEVER-CAPTURE-SYMLINK-TARGET'))), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'NEVER-CAPTURE-SYMLINK-TARGET');
});

test('Bash scanning skips symbolic-link trees and reports incomplete coverage', async t => {
  const { root, cwd, stateDir, journal } = fixture(t), outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sensitive.txt'), 'NEVER-CAPTURE-LINKED-DIRECTORY'); fs.symlinkSync(outside, path.join(cwd, 'link'));
  await begin(journal, cwd); await before(journal, 'bash', {}); fs.writeFileSync(path.join(cwd, 'out.txt'), 'new'); const value = await finish(journal);
  assert.equal(value.coverage.complete, false); assert.ok(value.coverage.reasons.includes('unsafe-path-skipped'));
  assert.equal(value.rollbackAvailable, false); assert.equal((await journal.checkpointRead({ threadId: 'thread-1', turnId: 'turn-1' })).reason, 'snapshot-incomplete');
  assert.equal(fs.existsSync(path.join(stateDir, 'blobs', digest('NEVER-CAPTURE-LINKED-DIRECTORY'))), false);
});

test('file and aggregate snapshot limits are visible and prohibit incomplete turn rollback', async t => {
  const { cwd, journal } = fixture(t, { maxFileBytes: 8, maxSnapshotBytes: 10 });
  fs.writeFileSync(path.join(cwd, 'large.txt'), '123456789'); fs.writeFileSync(path.join(cwd, 'small.txt'), '1234567');
  await begin(journal, cwd); await before(journal, 'bash', {});
  fs.writeFileSync(path.join(cwd, 'large.txt'), '987654321'); fs.writeFileSync(path.join(cwd, 'small.txt'), '7654321');
  const value = await finish(journal); assert.equal(value.coverage.complete, false);
  assert.ok(value.coverage.reasons.includes('file-byte-limit')); assert.ok(value.coverage.reasons.includes('snapshot-byte-limit'));
  assert.equal((await journal.prepareRollback({ threadId: 'thread-1', turnId: 'turn-1' })).available, false);
  const detail = await journal.getChangeDetail({ threadId: 'thread-1', changeId: value.changes[0].id }); assert.equal(detail.reason, 'snapshot-unavailable');
});

test('bounded scans do not claim unknown files were newly created', async t => {
  const { cwd, journal } = fixture(t, { maxFiles: 1 });
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a'); fs.writeFileSync(path.join(cwd, 'b.txt'), 'b');
  await begin(journal, cwd); await before(journal, 'bash', {}); fs.writeFileSync(path.join(cwd, 'b.txt'), 'updated b');
  const value = await finish(journal); assert.equal(value.coverage.complete, false); assert.ok(value.coverage.reasons.includes('scan-file-limit'));
  assert.ok(value.changes.every(c => c.operation !== 'created')); assert.equal(value.rollbackAvailable, false);
});

test('cancellation interrupts scans, while finish can still record changes of an already executed cancelled turn', async t => {
  const { cwd, journal } = fixture(t); for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(cwd, `${i}.txt`), 'fixture');
  await begin(journal, cwd); const controller = new AbortController();
  const scanning = journal.beforeTool({ threadId: 'thread-1', turnId: 'turn-1', toolName: 'bash', signal: controller.signal });
  setImmediate(() => controller.abort()); await assert.rejects(scanning, codeIs('CANCELLED'));
  await finish(journal, 'turn-1', 'thread-1', 'cancelled');
  await begin(journal, cwd, 'turn-2'); await before(journal, 'write', { path: 'cancelled.txt' }, 'turn-2'); fs.writeFileSync(path.join(cwd, 'cancelled.txt'), 'already written');
  const ended = await finish(journal, 'turn-2', 'thread-1', 'cancelled'); assert.equal(ended.status, 'cancelled'); assert.equal(ended.changes[0].operation, 'created');
});

test('serializes capture and terminal finish and ignores late after-tool refreshes', async t => {
  const { cwd, journal } = fixture(t), file = path.join(cwd, 'file.txt');
  await begin(journal, cwd); await before(journal, 'write', { path: 'file.txt' }); fs.writeFileSync(file, 'first');
  const first = journal.afterTool({ threadId: 'thread-1', turnId: 'turn-1' }), ended = finish(journal);
  await Promise.all([first, ended]); fs.writeFileSync(file, 'external-later');
  const late = await journal.afterTool({ threadId: 'thread-1', turnId: 'turn-1' }); assert.equal(late.changes[0].after.sha256, digest('first'));
  assert.equal((await journal.listFiles({ threadId: 'thread-1' }))[0].status, 'changed');
});

test('restores persisted artifacts and recovers interrupted captures without replaying tools', async t => {
  const { cwd, stateDir, journal } = fixture(t), file = path.join(cwd, 'file.txt');
  await begin(journal, cwd); await before(journal, 'write', { path: 'file.txt' }); fs.writeFileSync(file, 'written before crash');
  const reloaded = new FileJournal({ stateDir }); assert.equal((await reloaded.listManifests({ threadId: 'thread-1' }))[0].status, 'running');
  const recovered = await reloaded.recoverInterruptedTurns(); assert.equal(recovered[0].status, 'interrupted'); assert.equal(recovered[0].changes[0].after.sha256, digest('written before crash'));
  assert.equal((await new FileJournal({ stateDir }).listArtifacts({ threadId: 'thread-1' }))[0].exists, true);
});

test('partially selected safe files can be undone without hiding incomplete coverage or unrelated files', async t => {
  const { cwd, journal } = fixture(t, { maxFileBytes: 8 }), selected = path.join(cwd, 'safe.txt');
  fs.writeFileSync(path.join(cwd, 'large.txt'), '123456789');
  await begin(journal, cwd); await before(journal, 'bash', {}); fs.writeFileSync(selected, 'new'); await finish(journal);
  const plan = await journal.prepareRollback({ threadId: 'thread-1', turnId: 'turn-1', paths: [selected] }); assert.equal(plan.available, true); assert.equal(plan.coverage[0].complete, false);
  assert.equal((await journal.rollbackTurn({ threadId: 'thread-1', token: plan.token })).applied, true); assert.equal(fs.existsSync(selected), false);
  assert.equal(fs.readFileSync(path.join(cwd, 'large.txt'), 'utf8'), '123456789');
});

test('never overwrites a file created concurrently during restore, preserves backup and blocks subsequent writes across restart', async t => {
  const { cwd, stateDir, journal } = fixture(t), file = path.join(cwd, 'race.txt'); fs.writeFileSync(file, 'before');
  await begin(journal, cwd); await before(journal, 'edit', { path: 'race.txt' }); fs.writeFileSync(file, 'after'); await finish(journal);
  const original = fs.linkSync;
  fs.linkSync = (source, destination, ...args) => { if (destination === file) fs.writeFileSync(file, 'external concurrent file'); return original(source, destination, ...args); };
  try { await assert.rejects(journal.rollbackTurn({ threadId: 'thread-1', turnId: 'turn-1' }), codeIs('RECOVERY_REQUIRED')); }
  finally { fs.linkSync = original; }
  assert.equal(fs.readFileSync(file, 'utf8'), 'external concurrent file');
  const backup = fs.readdirSync(cwd).find(n => n.endsWith('.backup')); assert.ok(backup); assert.equal(fs.readFileSync(path.join(cwd, backup), 'utf8'), 'after');
  assert.equal((await journal.getRecoveryStatus()).blocked, true);
  const restarted = new FileJournal({ stateDir }); assert.equal((await restarted.getRecoveryStatus()).blocked, true);
  await assert.rejects(begin(restarted, cwd, 'turn-next'), codeIs('RECOVERY_REQUIRED'));
  assert.equal((await restarted.listChanges({ threadId: 'thread-1' })).length, 1);
});

test('metadata persistence failure after a restore requires explicit recovery instead of replaying or overwriting', async t => {
  const { cwd, stateDir, journal } = fixture(t), file = path.join(cwd, 'write.txt'); fs.writeFileSync(file, 'before');
  await begin(journal, cwd); await before(journal, 'edit', { path: 'write.txt' }); fs.writeFileSync(file, 'after'); await finish(journal);
  const original = fs.renameSync;
  fs.renameSync = (from, to, ...args) => { if (to === path.join(stateDir, 'index.json')) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' }); return original(from, to, ...args); };
  try { await assert.rejects(journal.rollbackTurn({ threadId: 'thread-1', turnId: 'turn-1' }), codeIs('RECOVERY_REQUIRED')); }
  finally { fs.renameSync = original; }
  assert.equal(fs.readFileSync(file, 'utf8'), 'before'); assert.equal((await journal.getRecoveryStatus()).blocked, true);
  assert.equal((await new FileJournal({ stateDir }).getRecoveryStatus()).blocked, true);
});

test('parent-directory replacement during restore never writes through the new symlink', async t => {
  const { root, cwd, journal } = fixture(t), parent = path.join(cwd, 'sub'), moved = path.join(cwd, 'sub-old'), outside = path.join(root, 'outside');
  fs.mkdirSync(parent); fs.mkdirSync(outside); const file = path.join(parent, 'file.txt'); fs.writeFileSync(file, 'before');
  await begin(journal, cwd); await before(journal, 'edit', { path: 'sub/file.txt' }); fs.writeFileSync(file, 'after'); await finish(journal);
  const original = fs.renameSync; let changed = false;
  fs.renameSync = (from, to, ...args) => {
    const result = original(from, to, ...args);
    if (!changed && from === file) { changed = true; original(parent, moved); fs.symlinkSync(outside, parent); }
    return result;
  };
  try { await assert.rejects(journal.rollbackTurn({ threadId: 'thread-1', turnId: 'turn-1' }), codeIs('RECOVERY_REQUIRED')); }
  finally { fs.renameSync = original; }
  assert.deepEqual(fs.readdirSync(outside), []); assert.equal((await journal.getRecoveryStatus()).blocked, true);
  assert.ok(fs.readdirSync(moved).some(n => n.endsWith('.backup')));
});

test('corrupted snapshots are rejected before any rollback mutation', async t => {
  const { cwd, stateDir, journal } = fixture(t), file = path.join(cwd, 'file.txt'); fs.writeFileSync(file, 'before');
  await begin(journal, cwd); await before(journal, 'edit', { path: 'file.txt' }); fs.writeFileSync(file, 'after'); await finish(journal);
  fs.writeFileSync(path.join(stateDir, 'blobs', digest('before')), 'corrupt');
  await assert.rejects(journal.prepareRollback({ threadId: 'thread-1', turnId: 'turn-1' }), codeIs('STATE_INVALID'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'after');
});

test('oversized text detail is reported instead of silently truncating a diff', async t => {
  const { cwd, journal } = fixture(t), file = path.join(cwd, 'large.txt'); fs.writeFileSync(file, 'a'.repeat(5000));
  await begin(journal, cwd); await before(journal, 'edit', { path: 'large.txt' }); fs.writeFileSync(file, 'b'.repeat(5000));
  const value = await finish(journal), detail = await journal.getChangeDetail({ threadId: 'thread-1', changeId: value.changes[0].id, maxBytes: 1024 });
  assert.equal(detail.diffAvailable, false); assert.equal(detail.reason, 'text-preview-limit'); assert.equal(detail.diff, undefined);
});

test('global snapshot storage cap survives restart and preserves existing snapshots', async t => {
  const { cwd, stateDir, journal } = fixture(t, { maxStoredBytes: 10 });
  await begin(journal, cwd); await before(journal, 'write', { path: 'first.txt' }); fs.writeFileSync(path.join(cwd, 'first.txt'), '12345678'); await finish(journal);
  const restarted = new FileJournal({ stateDir, limits: { maxStoredBytes: 10 } });
  await begin(restarted, cwd, 'turn-2'); await before(restarted, 'write', { path: 'second.txt' }, 'turn-2'); fs.writeFileSync(path.join(cwd, 'second.txt'), 'abcdefgh');
  const value = await finish(restarted, 'turn-2'); assert.ok(value.coverage.reasons.includes('journal-storage-limit')); assert.equal(value.rollbackAvailable, false);
  assert.ok(fs.existsSync(path.join(stateDir, 'blobs', digest('12345678')))); assert.equal(fs.existsSync(path.join(stateDir, 'blobs', digest('abcdefgh'))), false);
});

test('scan time budget becomes explicit incomplete coverage without pretending to have a full baseline', async t => {
  const { cwd, journal } = fixture(t, { maxScanMs: 1 }); fs.writeFileSync(path.join(cwd, 'existing.txt'), 'old');
  await begin(journal, cwd);
  const original = Date.now; let clock = 1000; Date.now = () => clock += 5;
  try { const value = await before(journal, 'bash', {}); assert.equal(value.coverage.complete, false); assert.ok(value.coverage.reasons.includes('scan-time-limit')); }
  finally { Date.now = original; }
  fs.writeFileSync(path.join(cwd, 'existing.txt'), 'new');
  const ended = await finish(journal); assert.equal(ended.rollbackAvailable, false);
  assert.ok(ended.changes.every(c => c.operation !== 'created'));
});

test('explicit file tool rejects malformed parameters before any file read or write', async t => {
  const { cwd, journal } = fixture(t); await begin(journal, cwd);
  for (const args of [null, [], 'file.txt']) await assert.rejects(before(journal, 'write', args), codeIs('INVALID'));
  await assert.rejects(before(journal, 'edit', { path: 'a.txt', file_path: 'b.txt' }), codeIs('PATH_INVALID'));
  assert.deepEqual(fs.readdirSync(cwd), []);
});

for (const [label, firstName, aliasName] of [
  ['case', 'Report.txt', 'report.txt'],
  ['Unicode normalization', 'Café.txt', 'Cafe\u0301.txt'],
]) {
  test(`real filesystem ${label} aliases never receive destructive independent rollback entries`, async t => {
    const { cwd, stateDir, journal } = fixture(t);
    const firstPath = path.join(cwd, firstName), aliasPath = path.join(cwd, aliasName);
    await begin(journal, cwd); await before(journal, 'write', { path: firstName }); fs.writeFileSync(firstPath, 'FIRST');
    await journal.afterTool({ threadId: 'thread-1', turnId: 'turn-1' });
    const physicalAlias = fs.existsSync(aliasPath) && fs.statSync(aliasPath).ino === fs.statSync(firstPath).ino;
    await before(journal, 'write', { path: aliasName }); fs.writeFileSync(aliasPath, 'SECOND');
    const completed = await finish(journal);
    assert.ok(completed.changes.some(change => change.path === firstPath));
    assert.ok(completed.changes.some(change => change.path === aliasPath));
    const preview = await journal.prepareRollback({ threadId: 'thread-1', turnId: 'turn-1' });
    if (physicalAlias || process.platform === 'darwin') {
      assert.equal(preview.available, false); assert.equal(preview.reason, 'ambiguous-file-alias');
      assert.ok(preview.coverage.every(item => item.complete === false && item.reasons.includes('ambiguous-file-alias')));
      assert.equal((await journal.checkpointRead({ threadId: 'thread-1', turnId: 'turn-1' })).reason, 'ambiguous-file-alias');
      const rejected = await journal.rollbackTurn({ threadId: 'thread-1', turnId: 'turn-1' });
      assert.equal(rejected.applied, false); assert.equal(rejected.reason, 'ambiguous-file-alias');
      assert.equal(fs.readFileSync(aliasPath, 'utf8'), 'SECOND'); assert.equal(fs.readFileSync(firstPath, 'utf8'), physicalAlias ? 'SECOND' : 'FIRST');
      assert.deepEqual(fs.readdirSync(path.join(stateDir, 'transactions')), [], 'No destructive transaction may be started');
      const restarted = new FileJournal({ stateDir });
      assert.equal((await restarted.prepareRollback({ threadId: 'thread-1', turnId: 'turn-1' })).reason, 'ambiguous-file-alias');
    } else {
      // A genuinely case-sensitive/non-normalizing non-Darwin volume has two
      // independent files. The ordinary plan remains valid and removes both.
      assert.equal(preview.available, true);
      assert.equal((await journal.rollbackTurn({ threadId: 'thread-1', token: preview.token })).applied, true);
      assert.equal(fs.existsSync(firstPath), false); assert.equal(fs.existsSync(aliasPath), false);
    }
  });
}

test('different paths sharing a captured inode are refused on every platform', async t => {
  const { cwd, stateDir, journal } = fixture(t), beforePath = path.join(cwd, 'before.txt'), afterPath = path.join(cwd, 'after.txt');
  fs.writeFileSync(beforePath, 'SAME-INODE'); const inode = fs.statSync(beforePath).ino;
  await begin(journal, cwd); await before(journal, 'bash', {}); fs.renameSync(beforePath, afterPath);
  assert.equal(fs.statSync(afterPath).ino, inode);
  const completed = await finish(journal); assert.deepEqual(completed.changes.map(change => change.operation).sort(), ['created', 'deleted']);
  const plan = await journal.prepareRollback({ threadId: 'thread-1', turnId: 'turn-1' });
  assert.equal(plan.available, false); assert.equal(plan.reason, 'ambiguous-file-alias');
  assert.deepEqual(new Set(plan.conflicts.map(item => item.path)), new Set([beforePath, afterPath]));
  const result = await journal.rollbackTurn({ threadId: 'thread-1', turnId: 'turn-1' }); assert.equal(result.applied, false);
  assert.equal(fs.existsSync(beforePath), false); assert.equal(fs.readFileSync(afterPath, 'utf8'), 'SAME-INODE');
  assert.deepEqual(fs.readdirSync(path.join(stateDir, 'transactions')), []);
});

test('an unchanged spelling cannot hide a different alias baseline in the same turn', async t => {
  const { cwd, journal } = fixture(t), upper = path.join(cwd, 'Ledger.txt'), lower = path.join(cwd, 'ledger.txt');
  fs.writeFileSync(upper, 'ORIGINAL');
  const physicalAlias = fs.existsSync(lower) && fs.statSync(lower).ino === fs.statSync(upper).ino;
  if (!physicalAlias) { t.skip('Requires the real filesystem to alias these spellings'); return; }
  await begin(journal, cwd); await before(journal, 'edit', { path: 'Ledger.txt' }); fs.writeFileSync(upper, 'FIRST');
  await before(journal, 'edit', { path: 'ledger.txt' }); fs.writeFileSync(lower, 'ORIGINAL');
  const completed = await finish(journal); assert.equal(completed.changes.length, 1); assert.equal(completed.changes[0].path, lower);
  const plan = await journal.prepareRollback({ threadId: 'thread-1', turnId: 'turn-1' }); assert.equal(plan.reason, 'ambiguous-file-alias');
  assert.equal((await journal.rollbackTurn({ threadId: 'thread-1', turnId: 'turn-1' })).applied, false);
  assert.equal(fs.readFileSync(upper, 'utf8'), 'ORIGINAL');
});
