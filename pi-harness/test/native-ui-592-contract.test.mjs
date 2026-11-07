import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { inspectAsar } from '../package-dmg/asar.mjs';
import { sha256File } from '../package-dmg/build.mjs';
import { ORIGINAL_592_ASAR_SHA256 } from '../package-dmg/patches.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/native-ui-592-contract.source.json', import.meta.url)));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const slice = name => fixture.slices.find(value => value.name === name);
const callable = (name, context = {}) => vm.runInNewContext(
  slice(name).kind === 'method' ? `({${slice(name).source}}).${name}` : `(${slice(name).source})`, context,
);

test('5.9.2 native UI fixture retains exact shipped hashes and separate lineage', () => {
  assert.equal(fixture.workbuddyVersion, '5.9.2'); assert.equal(fixture.artifactSHA256, ORIGINAL_592_ASAR_SHA256);
  assert.equal(fixture.members.filter(value => value.byteIdentical).length, 3);
  for (const value of fixture.slices) {
    assert.equal(Buffer.byteLength(value.source), value.bytes, value.name);
    assert.equal(hash(value.source), value.sha256, value.name);
    assert.equal(value.range.end - value.range.start, value.bytes);
    assert.doesNotThrow(() => new vm.Script(value.kind === 'method' ? `({${value.source}})` : value.kind === 'function' ? `(${value.source})` : value.source));
  }
});

test('native request update still delivers request, message, chunk and typed patches as separate arguments', () => {
  const calls = [], patches = [{ type: 'replace', path: ['content'], value: 'Pi result' }], chunk = { type: 'assistant' };
  const emit = callable('emitRequestUpdate', { annotateUnclassifiedNetworkRetry: value => value });
  emit.call({ requestUpdateHandlers: new Set([(...args) => calls.push(args)]) }, 'request', 'message', chunk, patches);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], ['request', 'message', chunk, patches]);
});

test('native 5.9.2 sandbox sync preserves local-only checks, awaits config changes and propagates returned errors', async () => {
  const sync = callable('syncSandboxModeBeforeStart'), changes = [];
  const owner = { resolveSandboxMode: () => false };
  const conversation = { info: { transport: 'local' }, configManager: { useSandboxCLI: true, async setSandboxMode(value) { changes.push(value); } } };
  await sync.call(owner, conversation); assert.deepEqual(changes, [false]);
  await sync.call(owner, { ...conversation, info: { transport: 'cloud' } }); assert.equal(changes.length, 1);
  await sync.call(owner, { ...conversation, configManager: { useSandboxCLI: false } }); assert.equal(changes.length, 1);
  await assert.rejects(sync.call(owner, { ...conversation, configManager: { useSandboxCLI: true, async setSandboxMode() { return { message: 'sandbox rejected' }; } } }), /sandbox rejected/);
});

test('native list filters retain pagination and add local origins only when requested', () => {
  const withOrigin = callable('withLocalListOrigin');
  const query = { page: 2, size: 25, view: 'active', conversationOrigin: 'project' };
  const local = withOrigin(query, true);
  assert.equal(local.page, 2); assert.equal(local.size, 25); assert.equal(local.view, 'active');
  assert.deepEqual(Array.from(local.conversationOrigin), ['project', 'local']);
  assert.equal(withOrigin(query, false), query);
  const cloud = { ...query, transport: 'cloud' }; assert.equal(withOrigin(cloud, true), cloud);
  const calls = [], fetch = callable('fetchListForSpace', {
    stripTraceId: ({ traceId: _traceId, ...query }) => query,
    emptyConversationList: query => ({ items: [], ...query }),
  });
  const main = { list: value => calls.push(['project', value]) }, localService = { local: { list: value => calls.push(['local', value]) } };
  fetch(main, localService, 'local', { ...query, traceId: 'trace' });
  assert.deepEqual(calls[0], ['local', { ...query, space: 'local' }]);
  fetch(main, localService, 'project', query); assert.equal(calls[1][0], 'project');
});

const installed = process.env.WORKBUDDY_TEST_SOURCE_ASAR_592 ?? process.env.WORKBUDDY_TEST_SOURCE_ASAR ?? '/Applications/WorkBuddy.app/Contents/Resources/app.asar';
const hasOriginal592 = fs.existsSync(installed) && JSON.parse(inspectAsar(installed).read('package.json')).version === '5.9.2';
test('selected pinned 5.9.2 bytes match every fixture range and complete native SDK member', {
  skip: hasOriginal592 ? false : 'The pinned WorkBuddy 5.9.2 ASAR is unavailable',
}, () => {
  assert.equal(sha256File(installed), fixture.artifactSHA256);
  const archive = inspectAsar(installed);
  for (const member of fixture.members) assert.equal(hash(archive.read(member.member)), member.sha256, member.member);
  for (const value of fixture.slices) assert.equal(archive.read(value.member).subarray(value.range.start, value.range.end).toString('utf8'), value.source, value.name);
});
