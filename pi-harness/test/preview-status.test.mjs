import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PiHostRuntime } from '../src/host-runtime.mjs';

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync('/private/tmp/pi-preview-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let modelRefreshes = 0;
  const runtime = new PiHostRuntime({ id: 'pi', subscribe: () => () => {}, snapshot: () => ({}),
    refreshOfficialModels: async () => { modelRefreshes++; }, close: async () => {} }, { stateDir: root });
  t.after(() => runtime.close());
  return { root, runtime, filename: path.join(root, 'preview-status.json'), refreshes: () => modelRefreshes };
}
test('preview telemetry persists bounded reason counters privately without model traffic or document data', async t => {
  const { runtime, filename, refreshes } = setup(t);
  await runtime.dispatch('runtime.preview.note', { reason: 'event-sent' });
  await runtime.dispatch('runtime.preview.note', { reason: 'mounted' });
  await runtime.dispatch('runtime.preview.note', { reason: 'event-sent' });
  const report = JSON.parse(fs.readFileSync(filename));
  assert.deepEqual(Object.keys(report).sort(), ['counters', 'updatedAt', 'version']);
  assert.deepEqual(report.counters, { 'event-sent': 2, mounted: 1 });
  assert.equal(fs.statSync(filename).mode & 0o077, 0); assert.equal(refreshes(), 0);
  for (const input of [{ reason: 'not-allowed' }, { reason: 'mounted', content: 'DO_NOT_STORE' }, { reason: 'mounted', filePath: '/private/data' }, { reason: { secret: 'DO_NOT_STORE' } }]) {
    await assert.rejects(runtime.dispatch('runtime.preview.note', input), /Invalid preview diagnostic/);
  }
  assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /DO_NOT_STORE|private\/data|filePath/);
  const guarded = ['event', 'nonlocal-skipped', 'extension-skipped', 'session-skipped', 'content-skipped', 'reader-skipped', 'probe-skipped', 'url-skipped', 'ref-skipped'];
  for (const reason of guarded) await runtime.dispatch('runtime.preview.note', { reason });
  const counters = JSON.parse(fs.readFileSync(filename)).counters;
  for (const reason of guarded) assert.equal(counters[reason], 1);
});
test('preview telemetry refuses symlink or hardlink targets and leaves external data untouched', async t => {
  const { root, runtime, filename } = setup(t);
  const external = path.join(root, 'external.txt'); fs.writeFileSync(external, 'unchanged');
  fs.symlinkSync(external, filename);
  await assert.rejects(runtime.dispatch('runtime.preview.note', { reason: 'mounted' }), /Invalid preview diagnostic file/);
  assert.equal(fs.readFileSync(external, 'utf8'), 'unchanged');
  fs.unlinkSync(filename); fs.linkSync(external, filename);
  await assert.rejects(runtime.dispatch('runtime.preview.note', { reason: 'mounted' }), /Invalid preview diagnostic file/);
  assert.equal(fs.readFileSync(external, 'utf8'), 'unchanged');
});
test('preview telemetry refuses a non-private parent directory', async t => {
  const { root, runtime, filename } = setup(t); fs.chmodSync(root, 0o755);
  await assert.rejects(runtime.dispatch('runtime.preview.note', { reason: 'mounted' }), /Invalid private diagnostic directory/);
  assert.equal(fs.existsSync(filename), false); fs.chmodSync(root, 0o700);
});
