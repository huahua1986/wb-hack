import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createNativeOfficeService } = require('../src/native-office-service.cjs');
const rawNames = ['open_file', 'slide_get_info', 'slide_get_page_info', 'slide_get_text', 'slide_find_replace_text', 'save_file'];
const task = (cwd, threadId = `pi-thread-${randomUUID()}`) => ({ cwd, threadId, turnId: `pi-turn-${randomUUID()}` });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, { beforeCall = () => {}, stop = () => {}, names = [...rawNames, 'close_file'], leases = () => 0 } = {}) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-office-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'fixture.pptx');
  const stagingRoot = path.join(cwd, 'staging');
  fs.writeFileSync(file, 'original');
  let started = false;
  const calls = [], open = new Map();
  const documentService = {
    canEnsureEngineStart: () => true,
    pendingEmbeddedPreviewOpens: new Map(),
    contextManager: { getFilePreviewContexts: () => [] },
    documentLeaseRegistry: { getOpenLeasePhaseCounts: () => ({ opening: leases(), open: 0, releasing: 0, closing: 0 }) },
    engineSession: {
      async dispose() { calls.push({ stop: true }); started = false; },
      resetOnUnexpectedExit() {},
    },
    async ensureEngineStarted(source) {
      if (!started) { calls.push({ source }); await stop(); started = true; }
    },
    isEngineStarted: () => started,
    getEnginePort: () => started ? '39134' : undefined,
  };
  const service = createNativeOfficeService({ documentService, stagingRoot, async fetchImpl(url, options) {
    assert.match(url, /^http:\/\/127\.0\.0\.1:39134\/(health|mcp)$/);
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/health')) {
      calls.push({ health: true });
      if (!started) throw new Error('SDK has stopped', { cause: { code: 'ECONNREFUSED' } });
      return new Response('ok');
    }
    const request = JSON.parse(options.body);
    assert.equal(request.jsonrpc, '2.0');
    const reply = result => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'tools/list') { calls.push({ catalog: true }); return reply({ tools: names.map(name => ({ name })) }); }
    assert.equal(request.method, 'tools/call');
    const { name, arguments: args } = request.params;
    calls.push({ name, args });
    await beforeCall(name, args);
    const text = content => reply({ content: [{ type: 'text', text: content }] });
    if (name === 'get_pool_status') return reply({ open_editors: [...open.keys()], pool_size: open.size });
    if (name === 'open_file') {
      assert.deepEqual(args, { file_path: args.file_path, file_id: args.file_id, file_type: 'slide', wait: true, open_with_existing: false, allow_shared: false });
      assert.ok(args.file_path.startsWith(stagingRoot + path.sep));
      assert.notEqual(args.file_path, file);
      assert.equal(fs.readFileSync(args.file_path, 'utf8'), fs.readFileSync(file, 'utf8'));
      assert.match(args.file_id, /^pi-office-[a-f0-9-]{36}$/);
      open.set(args.file_id, args.file_path);
      return text(`open completed (slide), model ready for file_id=${args.file_id}`);
    }
    assert.ok(open.has(args.file_id), 'SDK handles must belong to a successful open');
    if (name === 'save_file') {
      assert.ok(args.file_path.startsWith(stagingRoot + path.sep));
      assert.notEqual(args.file_path, open.get(args.file_id));
      fs.writeFileSync(args.file_path, 'saved fixture');
      return text(`File saved to: ${args.file_path}`);
    }
    if (name === 'close_file') {
      assert.equal(args.force, true);
      open.delete(args.file_id);
      return text(`Editor closed for file_id=${args.file_id}`);
    }
    if (name === 'slide_get_info') return text(JSON.stringify({ file_id: args.file_id, file_path: open.get(args.file_id) }));
    return text('{"ok":true}');
  } });
  const invoke = (owner, rawName, args, signal) => service.call({ ...owner, rawName, arguments: args, signal });
  return { service, cwd, file, stagingRoot, calls, open, invoke };
}

test('lists Office entry points without starting the SDK and supports a fresh same-turn reopen', async t => {
  const { service, cwd, file, stagingRoot, calls, open, invoke } = fixture(t);
  const owner = task(cwd);
  const tools = await service.list();
  assert.deepEqual(tools.map(tool => tool.rawName), [...rawNames, 'create_slide', 'create_doc', 'create_sheet', 'create_mind',
    'get_pool_status', 'close_file', 'shutdown', 'office_catalog', 'office_read', 'office_edit']);
  assert.deepEqual(tools.find(tool => tool.rawName === 'open_file').inputSchema.required, ['file_path']);
  assert.deepEqual(calls, []);
  const first = await invoke(owner, 'open_file', { file_path: 'fixture.pptx' });
  const fileId = first.structuredContent.file_id;
  assert.equal(first.structuredContent.file_path, file);
  assert.deepEqual(calls.slice(0, 3), [{ source: 'pi-office' }, { health: true }, { catalog: true }]);
  assert.equal((await invoke(owner, 'slide_get_info', { file_id: fileId })).structuredContent.file_path, file);
  await invoke(owner, 'slide_find_replace_text', { file_id: fileId, page_index: 0, search: 'original', replace: 'new' });
  await assert.rejects(invoke(owner, 'open_file', { file_path: file }), { code: 'NATIVE_OFFICE_UNSAVED_CHANGES' });
  await invoke(owner, 'save_file', { file_id: fileId, file_path: file });
  assert.equal(fs.readFileSync(file, 'utf8'), 'saved fixture');
  const reopened = await invoke(owner, 'open_file', { file_path: file });
  assert.notEqual(reopened.structuredContent.file_id, fileId);
  assert.equal(open.size, 1);
  await service.release(owner);
  assert.equal(open.size, 0);
  assert.deepEqual(fs.readdirSync(stagingRoot), []);
  await assert.rejects(invoke(owner, 'open_file', { file_path: file }), { code: 'NATIVE_OFFICE_CANCELLED' });
});

test('save as creates a new target while preserving the opened original', async t => {
  const { service, cwd, file, invoke } = fixture(t);
  const owner = task(cwd);
  const { structuredContent: { file_id } } = await invoke(owner, 'open_file', { file_path: file });
  await invoke(owner, 'save_file', { file_id, file_path: 'copy.pptx' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(cwd, 'copy.pptx'), 'utf8'), 'saved fixture');
  await assert.rejects(invoke(owner, 'save_file', { file_id, file_path: file }), { code: 'NATIVE_OFFICE_FILE_NOT_ALLOWED' });
  await service.release(owner);
});

test('checks the original again after staging and leaves external edits intact', async t => {
  const saving = deferred(), unblock = deferred();
  const { service, cwd, file, stagingRoot, invoke } = fixture(t, { async beforeCall(name) {
    if (name === 'save_file') { saving.resolve(); await unblock.promise; }
  } });
  const owner = task(cwd);
  const { structuredContent: { file_id } } = await invoke(owner, 'open_file', { file_path: file });
  const request = invoke(owner, 'save_file', { file_id, file_path: file });
  await saving.promise;
  fs.writeFileSync(file, 'external writer');
  unblock.resolve();
  await assert.rejects(request, { code: 'NATIVE_OFFICE_FILE_CHANGED', mayHaveExecuted: false });
  assert.equal(fs.readFileSync(file, 'utf8'), 'external writer');
  await service.release(owner);
  assert.deepEqual(fs.readdirSync(stagingRoot), []);
});

test('rejects unlisted tools, extra arguments, linked paths, foreign handles and stale or redirected saves', async t => {
  const { service, cwd, file, calls, invoke } = fixture(t);
  const owner = task(cwd), other = task(cwd), next = task(cwd, owner.threadId);
  const symlink = path.join(cwd, 'alias.pptx'), hardlink = path.join(cwd, 'copy.pptx');
  fs.symlinkSync(file, symlink);
  await assert.rejects(invoke(owner, 'open_file', { file_path: symlink }), { code: 'NATIVE_OFFICE_FILE_NOT_ALLOWED' });
  fs.linkSync(file, hardlink);
  await assert.rejects(invoke(owner, 'open_file', { file_path: hardlink }), { code: 'NATIVE_OFFICE_FILE_NOT_ALLOWED' });
  fs.unlinkSync(hardlink);
  await assert.rejects(invoke(owner, 'open_file', { file_path: '../outside.pptx' }), { code: 'NATIVE_OFFICE_FILE_NOT_ALLOWED' });
  await assert.rejects(invoke(owner, 'open_file', { file_path: file, file_id: 'preview' }), { code: 'NATIVE_OFFICE_INVALID_ARGUMENTS' });
  await assert.rejects(invoke(owner, 'shutdown', { force: true }), { code: 'NATIVE_OFFICE_INVALID_ARGUMENTS' });
  assert.deepEqual(calls, []);
  const { structuredContent: { file_id } } = await invoke(owner, 'open_file', { file_path: file });
  await assert.rejects(invoke(other, 'slide_get_info', { file_id }), { code: 'NATIVE_OFFICE_FILE_NOT_OPEN' });
  await assert.rejects(invoke(next, 'slide_get_info', { file_id }), { code: 'NATIVE_OFFICE_FILE_NOT_OPEN' });
  await assert.rejects(invoke(other, 'open_file', { file_path: file }), { code: 'NATIVE_OFFICE_FILE_BUSY' });
  fs.writeFileSync(hardlink, 'independent file');
  await assert.rejects(invoke(owner, 'save_file', { file_id, file_path: hardlink }), { code: 'NATIVE_OFFICE_FILE_NOT_ALLOWED' });
  fs.appendFileSync(file, 'changed externally');
  await assert.rejects(invoke(owner, 'save_file', { file_id, file_path: file }), { code: 'NATIVE_OFFICE_FILE_CHANGED' });
  assert.ok(!calls.some(call => call.name === 'save_file'));
  await service.release(owner);
  await invoke(other, 'open_file', { file_path: file });
  await service.release(other);
});

test('Office shutdown uses the host lifecycle after checking open files and permits a fresh lazy startup', async t => {
  let opening = 0;
  const { service, cwd, file, calls, invoke } = fixture(t, { leases: () => opening });
  const owner = task(cwd);
  await invoke(owner, 'shutdown', {});
  assert.deepEqual(calls, []);
  const first = await invoke(owner, 'open_file', { file_path: file });
  await assert.rejects(invoke(task(cwd), 'shutdown', {}), { code: 'NATIVE_OFFICE_SHUTDOWN_BUSY' });
  assert.equal(calls.filter(call => call.stop).length, 0);
  await invoke(owner, 'close_file', { file_id: first.structuredContent.file_id });
  opening = 1;
  await assert.rejects(invoke(owner, 'shutdown', {}), { code: 'NATIVE_OFFICE_SHUTDOWN_BUSY' });
  assert.equal(calls.filter(call => call.stop).length, 0);
  opening = 0;
  await invoke(owner, 'shutdown', {});
  assert.equal(calls.filter(call => call.stop).length, 1);
  assert.equal(calls.filter(call => call.name === 'get_pool_status').length, 2);
  await invoke(owner, 'open_file', { file_path: file });
  assert.equal(calls.filter(call => call.source === 'pi-office').length, 2);
  await service.release(owner);
});

test('release closes a late open without granting a handle to a released turn', async t => {
  const entering = deferred(), unblock = deferred();
  const { service, cwd, file, open, calls, invoke } = fixture(t, { async beforeCall(name) {
    if (name === 'open_file') { entering.resolve(); await unblock.promise; }
  } });
  const owner = task(cwd);
  const opening = invoke(owner, 'open_file', { file_path: file });
  await entering.promise;
  const release = service.release(owner);
  unblock.resolve();
  await assert.rejects(opening, { code: 'NATIVE_OFFICE_CANCELLED', mayHaveExecuted: true });
  assert.deepEqual(await release, { released: true });
  assert.equal(open.size, 0);
  assert.equal(calls.filter(call => call.name === 'close_file').length, 1);
  await assert.rejects(invoke(owner, 'open_file', { file_path: file }), { code: 'NATIVE_OFFICE_CANCELLED' });
});

test('cold-start cancellation never dispatches a tool and a missing SDK method fails closed', async t => {
  const starting = deferred();
  const { service, cwd, file, calls, invoke } = fixture(t, { stop: () => starting.promise, names: ['open_file'] });
  const owner = task(cwd);
  const abort = new AbortController();
  const request = invoke(owner, 'open_file', { file_path: file }, abort.signal);
  abort.abort();
  await assert.rejects(request, { code: 'NATIVE_OFFICE_CANCELLED', mayHaveExecuted: false });
  starting.resolve();
  await assert.rejects(invoke(owner, 'open_file', { file_path: file }), { code: 'NATIVE_OFFICE_TOOL_UNAVAILABLE' });
  assert.ok(!calls.some(call => call.name));
  await service.release(owner);
});
