import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { unifiedHunks, nativeChangeFile, nativeManifest, nativeDiffResources, nativeArtifacts, nativeFileTree } from '../src/file-resources.mjs';
import { FileJournal } from '../src/file-journal.mjs';
import { createNativeDiffReplay, findNativeDiffView } from './fixtures/native-diff-592.replay.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/p0-native-592.source.json', import.meta.url)));
const plain = value => JSON.parse(JSON.stringify(value));
function native() {
  const context = vm.createContext({
    console, URL, performance, Set, Map, WeakMap, Date, decodeURIComponent,
    // Inert native diagnostics and unrelated special-product branches. No implementation under test is mocked.
    mZ: { windowStartAt: 0, calls: 0, hits: 0 }, b9t: new WeakMap(), x9t: [], pZ: 'native-resource',
    il: () => {}, scheduleChangeArtifactsDiagFlush: () => {}, dl: value => value,
    isMcpAppOrArdotRawArtifact: () => false, isWbAppGenieMarkerRecord: () => false, _he: () => false,
    h8t: { artifacts: [], changes: [], files: [] },
    rejectedReason: result => result.status === 'rejected' ? String(result.reason) : undefined,
  });
  for (const slice of fixture.slices.filter(s => s.kind === 'constant-assignment')) vm.runInContext(slice.source, context);
  for (const slice of fixture.slices.filter(s => s.kind === 'FunctionDeclaration' && s.name !== 'useConversationRewind')) vm.runInContext(slice.source, context);
  vm.runInContext('globalThis.detailLoader={' + fixture.slices.find(s => s.name === 'loadChangeDetail').source + '}', context);
  return context;
}
const instant = '2026-10-27T04:05:06.000Z';
function change(operation, name, extra = {}) {
  return { id: 'change-' + name, path: '/workspace/' + name, name, operation, rolledBack: false, ...extra };
}
function file(name, extra = {}) {
  return { id: 'file-' + name, threadId: 'thread-a', turnId: 'turn-a', path: '/workspace/' + name,
    name: path.basename(name), exists: true, rolledBack: false, size: 42, mimeType: 'text/plain', createdAt: instant, updatedAt: instant, ...extra };
}

test('unified hunks preserve zero/default counts and native header semantics across multiple hunks', () => {
  const diff = '--- before/a.txt\n+++ after/a.txt\n@@ -0,0 +1,2 @@ section\n+first\n+second\n@@ -7 +9 @@\n-old\n+new\n\\ No newline at end of file\n';
  const hunks = unifiedHunks(diff);
  assert.equal(hunks.length, 2); assert.deepEqual([hunks[0].oldStart, hunks[0].oldLines, hunks[0].newStart, hunks[0].newLines], [0, 0, 1, 2]);
  assert.equal(hunks[0].header, 'section');
  assert.deepEqual([hunks[1].oldLines, hunks[1].newLines], [1, 1]);
  assert.deepEqual(hunks[1].lines, ['-old', '+new', '\\ No newline at end of file']);
  const text = native().hunkText('/workspace/a.txt', hunks);
  assert.match(text, /@@ -0,0 \+1,2 @@ section\n\+first\n\+second/);
  assert.doesNotMatch(text, /@@  section/);
});

test('create/modify/delete project into native actions, counts and parseable hunks', () => {
  const c = native();
  for (const [operation, diff, afterText, action, added, removed] of [
    ['created', '@@ -0,0 +1,2 @@\n+a\n+b\n', 'a\nb\n', 'create', 2, 0],
    ['modified', '@@ -1,2 +1,2 @@\n-old\n+new\n same\n', 'new\nsame\n', 'modify', 1, 1],
    ['deleted', '@@ -1 +0,0 @@\n-removed\n', '', 'delete', 0, 1],
  ]) {
    const projected = nativeChangeFile(change(operation, operation + '.txt'), { diffAvailable: true, diff, afterText });
    assert.equal(projected.action, action); assert.equal(projected.additions, added); assert.equal(projected.deletions, removed);
    assert.equal(projected.detailStatus, 'available'); assert.equal(projected.content, afterText);
    assert.equal(c.changeType(projected.action), operation);
    assert.match(c.hunkText(projected.filePath, projected.hunks), /@@ -\d+,\d+ \+\d+,\d+ @@/);
  }
});

test('full native manifest exposes every file and detail reference; delete and reverted changes are not artifact cards', () => {
  const c = native(), created = change('created', 'new.txt'), edited = change('modified', 'edited.txt'), deleted = change('deleted', 'gone.txt');
  const manifest = { turnId: 'turn-a', threadId: 'thread-a', createdAt: instant, coverage: { complete: true }, rollbackAvailable: true,
    changes: [created, edited, deleted, change('modified', 'already-reverted.txt', { rolledBack: true })] };
  const details = new Map([
    [created.id, { diffAvailable: true, diff: '@@ -0,0 +1 @@\n+new\n', afterText: 'new\n' }],
    [edited.id, { diffAvailable: true, diff: '@@ -1 +1 @@\n-old\n+edited\n', afterText: 'edited\n' }],
    [deleted.id, { diffAvailable: true, diff: '@@ -1 +0,0 @@\n-gone\n', afterText: '' }],
  ]);
  const projected = nativeManifest(manifest, details);
  assert.equal(projected.createdAt, Date.parse(instant)); assert.equal(projected.requestId, 'turn-a'); assert.equal(projected.detailRef, 'turn-a');
  assert.equal(projected.files.length, 3); assert.deepEqual(projected.files.map(f => f.action), ['create', 'modify', 'delete']);
  const cards = c.toLegacyConversationChangeArtifacts([projected], 'native-thread');
  assert.equal(cards.length, 2); assert.deepEqual(plain(cards.map(a => a.fileChangeInfo.changeType)), ['created', 'modified']);
  assert.equal(cards[1].changeDetailRef, 'turn-a'); assert.equal(cards[1].changeRequestId, 'turn-a'); assert.equal(cards[1].changeDetailStatus, 'available');
  assert.match(cards[1].fileChangeInfo.diff, /-old\n\+edited/); assert.equal(cards[1].fileChangeInfo.cachedContent, 'edited\n');
});

test('binary and large text states remain explicit through the actual native change consumer', () => {
  const c = native();
  const changes = [change('created', 'report.xlsx'), change('modified', 'large.txt')];
  const details = new Map([[changes[0].id, { diffAvailable: false, binary: true, reason: 'binary-file' }],
    [changes[1].id, { diffAvailable: false, binary: false, reason: 'text-preview-limit' }]]);
  const manifest = nativeManifest({ threadId: 'thread-a', turnId: 'turn-a', createdAt: instant, coverage: { complete: true }, changes }, details);
  assert.equal(manifest.files[0].binary, true); assert.equal(manifest.files[0].hunks, undefined);
  const cards = c.toLegacyConversationChangeArtifacts([manifest], 'native-thread');
  assert.equal(cards[0].changeDetailStatus, 'diff-omitted-size'); assert.equal(cards[0].fileChangeInfo.diffStatus, 'binary-file');
  assert.equal(cards[1].changeDetailStatus, 'diff-omitted-size'); assert.equal(cards[1].fileChangeInfo.diffStatus, 'timeout');
  assert.equal(manifest.files[1].diffReason, 'text-preview-limit');
  assert.equal(cards[0].fileChangeInfo.diff, undefined); assert.equal(cards[1].fileChangeInfo.cachedContent, undefined);
});

test('artifact metadata reaches native document/spreadsheet/presentation/PDF/code classification and local path index', () => {
  const c = native(), expected = [['docx', 'document'], ['xlsx', 'spreadsheet'], ['pptx', 'presentation'], ['pdf', 'document'], ['txt', 'code']];
  const raw = nativeArtifacts([...expected.map(([ext]) => file('季度 报告.' + ext)),
    file('gone.txt', { exists: false }), file('reverted.txt', { rolledBack: true })]);
  assert.equal(raw.length, 5);
  const index = c.buildArtifactPathIndex(raw);
  for (let i = 0; i < raw.length; i++) {
    assert.equal(raw[i].type, 'file'); assert.equal(raw[i].kind, 'media'); assert.equal(path.isAbsolute(raw[i].uri), true); assert.equal(raw[i].uri, raw[i].filePath);
    assert.equal(raw[i].conversationId, 'thread-a'); assert.equal(raw[i].requestId, 'turn-a');
    assert.equal(index.get(raw[i].filePath.toLowerCase()), raw[i]);
    const card = c.toConversationArtifactItem(raw[i], 'native-thread');
    assert.equal(card.type, 'media-artifact'); assert.equal(card.contentType, expected[i][1]); assert.equal(card.url, raw[i].filePath);
    assert.equal(card.requestId, 'turn-a'); assert.equal(card.sessionId, 'thread-a');
  }
});

test('artifact identity stays stable across turns in one thread and distinct across threads sharing a project', () => {
  const first = nativeArtifacts([file('shared.txt')])[0];
  const sameThread = nativeArtifacts([file('shared.txt', { turnId: 'turn-b' })])[0];
  const otherThread = nativeArtifacts([file('shared.txt', { threadId: 'thread-b' })])[0];
  assert.equal(first.id, sameThread.id); assert.notEqual(first.id, otherThread.id);
  const external = nativeArtifacts([file('shared.txt', { currentChanged: true })])[0]; assert.equal(external.externalChangeDetected, true);
});

test('nested files and explicit outside files form a native-expandable tree without path leakage or duplicate directories', () => {
  const c = native(), cwd = '/workspace', files = [file('root.txt'), file('out/a.txt'), file('out/nested/b.pdf'), file('out/c.txt'),
    file('elsewhere.txt', { path: '/explicit/elsewhere.txt' }), file('deleted.txt', { exists: false }), file('rolled-back.txt', { rolledBack: true })];
  const tree = nativeFileTree(files, cwd); assert.equal(tree.length, 2); assert.equal(tree[0].path, cwd); assert.equal(tree[0].type, 'directory');
  assert.equal(tree[0].children.filter(n => n.name === 'out').length, 1); assert.equal(tree[1].path, '/explicit/elsewhere.txt');
  const expandedPaths = new Set(['/workspace', '/workspace/out', '/workspace/out/nested']);
  const nativeTree = c.toLegacyConversationFileTreeWithContext(tree, { expandedPaths, lookupPrevious: () => undefined, maxInlineChildren: 100 });
  assert.equal(nativeTree[0].type, 'dir'); assert.equal(nativeTree[0].isLoaded, true);
  const out = nativeTree[0].children.find(n => n.name === 'out'); assert.equal(out.type, 'dir'); assert.equal(out.isLoaded, true);
  assert.deepEqual(plain(out.children.map(n => n.name)), ['a.txt', 'nested', 'c.txt']);
  assert.equal(out.children[1].children[0].path, '/workspace/out/nested/b.pdf'); assert.equal(out.children[1].children[0].type, 'file');
});

test('actual lazy detail loader receives a full manifest rather than a single file entry', async () => {
  const c = native(), seen = [];
  const detail = nativeManifest({ threadId: 'thread-a', turnId: 'turn-a', createdAt: instant,
    changes: [change('created', 'a.txt'), change('created', 'b.txt')], coverage: { complete: true } });
  assert.ok(detail.files.every(file => file.detailStatus === 'content-omitted-size'), 'A metadata-only summary must request content rather than falsely declaring a Diff omitted');
  const host = { getConversation: () => ({ changeDetail: async params => { seen.push(plain(params)); return detail; } }),
    resourcesStore: { getState: () => ({ setChangeDetail: (id, value) => seen.push({ id, fileCount: value.files.length }) }) } };
  const result = await c.detailLoader.loadChangeDetail.call(host, 'turn-a', 'turn-a');
  assert.equal(result, true); assert.deepEqual(seen, [{ requestId: 'turn-a', detailRef: 'turn-a' }, { id: 'turn-a', fileCount: 2 }]);
});

test('journal output loads through the original resources loader and produces native usable diffs after restart', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-file-resources-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'work'), stateDir = path.join(root, 'state'); fs.mkdirSync(cwd, { mode: 0o700 }); fs.writeFileSync(path.join(cwd, 'edited.txt'), 'old\n');
  const journal = new FileJournal({ stateDir }); await journal.beginTurn({ threadId: 'thread-a', turnId: 'turn-a', cwd });
  await journal.beforeTool({ threadId: 'thread-a', turnId: 'turn-a', toolName: 'bash', args: {} });
  fs.writeFileSync(path.join(cwd, 'edited.txt'), 'new\n'); fs.mkdirSync(path.join(cwd, 'out')); fs.writeFileSync(path.join(cwd, 'out/created.md'), 'document\n');
  await journal.finishTurn({ threadId: 'thread-a', turnId: 'turn-a' });
  const restored = new FileJournal({ stateDir }), files = await restored.listFiles({ threadId: 'thread-a' }), manifests = await restored.listManifests({ threadId: 'thread-a' });
  const details = new Map(); for (const change of manifests[0].changes) details.set(change.id, await restored.getChangeDetail({ threadId: 'thread-a', changeId: change.id }));
  const projectedManifests = manifests.map(m => nativeManifest(m, details)), artifacts = nativeArtifacts(files), tree = nativeFileTree(files, cwd), c = native();
  const result = await c.loadConversationResources(async () => ({ info: { transport: 'local' }, artifacts: async () => artifacts,
    files: async () => tree, changeManifests: async () => projectedManifests }));
  assert.equal(result.artifacts.length, 2); assert.equal(result.changes[0].files.length, 2); assert.equal(result.files[0].path, cwd);
  const diffCards = c.toLegacyConversationChangeArtifacts(result.changes, 'native-thread');
  assert.equal(diffCards.length, 2); assert.ok(diffCards.some(card => /-old\n\+new/.test(card.fileChangeInfo.diff)));
  assert.ok(result.artifacts.every(a => c.toConversationArtifactItem(a, 'native-thread').url.startsWith(cwd)));
});

function frozenHistory(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) frozenHistory(child); }
  return value;
}
function diffHistory(names = ['report.md']) {
  const changes = (turnId, operation, at) => names.map((name, index) => change(operation, name, {
    id: `${turnId}-${name}`, turnId, threadId: 'thread-a', path: '/synthetic/work/' + name,
    updatedAt: `2026-10-28T01:0${at + index}:00.000Z`,
  }));
  return [{ turnId: 'turn-a', threadId: 'thread-a', createdAt: '2026-10-28T01:00:00.000Z', changes: changes('turn-a', 'created', 0), coverage: { complete: true } },
    { turnId: 'turn-b', threadId: 'thread-a', createdAt: '2026-10-28T01:01:00.000Z', changes: changes('turn-b', 'modified', 2), coverage: { complete: true } }];
}
function modifiedDetail(first = '# report\nFIRST\n', second = '# report\nSECOND\n') {
  return { diffAvailable: true, binary: false, beforeText: first, afterText: second,
    diff: `--- before/report.md\n+++ after/report.md\n@@ -1,2 +1,2 @@\n # report\n-${first.split('\n')[1]}\n+${second.split('\n')[1]}\n` };
}
function readyCreateDetail(content = '# report\nFIRST\n') {
  return { diffAvailable: true, afterText: content, beforeText: '', diff: `@@ -0,0 +1,2 @@\n+${content.split('\n')[0]}\n+${content.split('\n')[1]}\n` };
}

test('latest summary carries the true modify patch through native prefer and the complete native Diff viewer', async () => {
  const history = frozenHistory(diffHistory()), original = JSON.stringify(history), reads = [];
  const resources = await nativeDiffResources([...history].reverse(), async selected => { reads.push(selected.id); return modifiedDetail(); });
  assert.deepEqual(reads, ['turn-b-report.md']); assert.deepEqual(resources.diffOmissions, []);
  assert.deepEqual(resources.manifests.map(m => m.requestId), ['turn-a', 'turn-b']);
  assert.equal(resources.manifests[0].files[0].detailStatus, 'content-omitted-size');
  assert.equal(resources.manifests[1].files[0].detailStatus, 'available');
  const replay = createNativeDiffReplay(), artifact = replay.project(resources.manifests, 'native-thread')[0];
  assert.equal(artifact.fileChangeInfo.changeType, 'modified'); assert.equal(artifact.changeRequestId, 'turn-b');
  let fileReads = 0;
  const tree = await replay.view(artifact, { readFile: async () => { fileReads++; return '# report\nSECOND\n'; } });
  const editor = findNativeDiffView(tree); assert.ok(editor, 'The original viewer must render its real Diff editor');
  assert.equal(editor.props.original, '# report\nFIRST\n'); assert.equal(editor.props.modified, '# report\nSECOND\n');
  assert.match(editor.props.unifiedDiff, /-FIRST\n\+SECOND/); assert.equal(fileReads, 0, 'Exact inline sides must not trigger a read of potentially newer on-disk contents');
  assert.equal(JSON.stringify(history), original, 'Summary projection must not rewrite history or change objects');
});

test('latest binary, missing snapshots and empty text patches remove that path complete line-Diff history', async () => {
  for (const [detail, reason] of [
    [{ diffAvailable: false, binary: true, reason: 'binary-file' }, 'binary-file'],
    [{ diffAvailable: false, reason: 'snapshot-unavailable' }, 'snapshot-unavailable'],
    [{ diffAvailable: true, diff: '', afterText: '# report\nSECOND\n' }, 'no-text-diff'],
  ]) {
    const history = frozenHistory(diffHistory()), original = JSON.stringify(history), selected = [];
    const resources = await nativeDiffResources(history, async change => { selected.push(change.id); return detail; });
    assert.deepEqual(selected, ['turn-b-report.md']); assert.deepEqual(resources.manifests, []);
    assert.deepEqual(resources.diffOmissions, [{ filePath: '/synthetic/work/report.md', requestId: 'turn-b', reason }]);
    assert.deepEqual(createNativeDiffReplay().project(resources.manifests), []);
    const ordinary = nativeArtifacts([file('report.md', { path: '/synthetic/work/report.md' })]);
    assert.equal(ordinary.length, 1); assert.equal(ordinary[0].filePath, '/synthetic/work/report.md');
    assert.equal(JSON.stringify(history), original, 'An omitted line preview must not delete the journal history');
  }
});

test('per-file oversize uses the native placeholder and never inherits the older creation or reads current contents', async () => {
  const history = frozenHistory(diffHistory()), resources = await nativeDiffResources(history, async () => ({ diffAvailable: false, reason: 'text-preview-limit' }));
  assert.equal(resources.manifests.length, 2); assert.equal(resources.manifests[1].files[0].diffStatus, 'timeout');
  assert.equal(resources.manifests[1].files[0].diffReason, 'text-preview-limit');
  assert.deepEqual(resources.diffOmissions, [{ filePath: '/synthetic/work/report.md', requestId: 'turn-b', reason: 'text-preview-limit' }]);
  const oldReady = nativeManifest(history[0], new Map([[history[0].changes[0].id, readyCreateDetail()]]));
  const replay = createNativeDiffReplay(), artifact = replay.project([oldReady, resources.manifests[1]], 'native-thread')[0];
  assert.equal(artifact.fileChangeInfo.changeType, 'modified'); assert.equal(artifact.fileChangeInfo.diffStatus, 'timeout');
  assert.equal(artifact.fileChangeInfo.diff, undefined); assert.equal(artifact.fileChangeInfo.cachedContent, undefined);
  let reads = 0; const tree = await replay.view(artifact, { readFile: async () => { reads++; return '# report\nSECOND\n'; } });
  assert.ok(findNativeDiffView(tree, 'NativeOversizePlaceholder')); assert.equal(findNativeDiffView(tree), undefined); assert.equal(reads, 0);
});

test('global byte and time budgets omit the full path instead of mislabeling a tiny file oversized', async () => {
  for (const [options, expectedReads] of [[{ maxBytes: 1 }, 1], [{ maxMs: 1, now: (() => { let n = 0; return () => n++ ? 2 : 0; })() }, 0]]) {
    const history = frozenHistory(diffHistory()), original = JSON.stringify(history); let reads = 0;
    const resources = await nativeDiffResources(history, async () => { reads++; return modifiedDetail(); }, options);
    assert.equal(reads, expectedReads); assert.deepEqual(resources.manifests, []);
    assert.deepEqual(resources.diffOmissions, [{ filePath: '/synthetic/work/report.md', requestId: 'turn-b', reason: 'preview-budget' }]);
    assert.deepEqual(createNativeDiffReplay().project(resources.manifests), []); assert.equal(JSON.stringify(history), original);
  }
});

test('file budget reads the newest changed path first and never resurrects unread paths older patches', async () => {
  const history = frozenHistory(diffHistory(['a.md', 'b.md'])), read = [];
  const resources = await nativeDiffResources(history, async change => { read.push(change.id); return modifiedDetail('# report\nFIRST_B\n', '# report\nSECOND_B\n'); }, { maxFiles: 1 });
  assert.deepEqual(read, ['turn-b-b.md']);
  assert.ok(resources.manifests.every(manifest => manifest.files.every(file => file.filePath === '/synthetic/work/b.md')));
  assert.deepEqual(resources.diffOmissions, [{ filePath: '/synthetic/work/a.md', requestId: 'turn-b', reason: 'preview-budget' }]);
  const replay = createNativeDiffReplay(), artifacts = replay.project(resources.manifests, 'native-thread'); assert.equal(artifacts.length, 1);
  const editor = findNativeDiffView(await replay.view(artifacts[0], { currentText: '# report\nSECOND_B\n' }));
  assert.equal(editor.props.original, '# report\nFIRST_B\n'); assert.equal(editor.props.modified, '# report\nSECOND_B\n');
});

test('multiple latest file patches stay isolated and history inputs remain unchanged', async () => {
  const history = frozenHistory(diffHistory(['a.md', 'b.md'])), original = JSON.stringify(history), reads = [];
  const resources = await nativeDiffResources(history, async change => {
    reads.push(change.id); const tag = change.name === 'a.md' ? 'A' : 'B';
    return modifiedDetail(`# report\nFIRST_${tag}\n`, `# report\nSECOND_${tag}\n`);
  });
  assert.deepEqual(reads, ['turn-b-b.md', 'turn-b-a.md']); assert.equal(resources.manifests.length, 2); assert.deepEqual(resources.diffOmissions, []);
  const replay = createNativeDiffReplay(), artifacts = replay.project(resources.manifests, 'native-thread'); assert.equal(artifacts.length, 2);
  let fileReads = 0;
  for (const artifact of artifacts) {
    const tag = artifact.uri.endsWith('/a.md') ? 'A' : 'B';
    const editor = findNativeDiffView(await replay.view(artifact, { readFile: async () => { fileReads++; return 'MUST-NOT-BE-USED'; } }));
    assert.equal(editor.props.original, `# report\nFIRST_${tag}\n`); assert.equal(editor.props.modified, `# report\nSECOND_${tag}\n`);
    assert.equal(artifact.changeRequestId, 'turn-b');
  }
  assert.equal(fileReads, 0); assert.equal(JSON.stringify(history), original);
});

test('inline preview budgets reject expansion and invalid bounds before reading any detail', async () => {
  let reads = 0; const history = frozenHistory(diffHistory());
  for (const options of [{ maxBytes: 256 * 1024 + 1 }, { maxFiles: 65 }, { maxMs: 1001 }, { maxBytes: 0 }, { maxFiles: -1 }, { maxMs: 1.5 }]) {
    await assert.rejects(nativeDiffResources(history, async () => { reads++; return modifiedDetail(); }, options), TypeError);
  }
  assert.equal(reads, 0);
});
