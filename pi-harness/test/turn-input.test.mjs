import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, promises as fs, readFileSync, realpathSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

import { DEFAULT_TURN_INPUT_LIMITS, prepareTurnInput, TurnInputError } from '../src/turn-input.mjs';
import { createNativeInputReplay } from './fixtures/native-input-592.replay.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/turn-input-native-591.source.json', import.meta.url), 'utf8'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1AAAAAASUVORK5CYII=', 'base64');
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function workspace() {
  const path = realpathSync(mkdtempSync('/private/tmp/pi-turn-input-'));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function file(root, name, content) {
  const path = join(root, name);
  writeFileSync(path, content);
  return path;
}
function nativeFunctions() {
  const constants = { DISPLAY_AS_CONTEXT: 'displayAsContext', DISPLAY_AS_PHRASE: 'displayAsPhrase', DISPLAY_TEXT: 'displayText' };
  const context = vm.createContext({
    ca: constants, ys: constants, ri: { ICON: 'icon' }, bs: { ICON: 'icon' }, hi: { at: '@' },
    bi: { BLOCK_ID: 'blockId', BLOCK_STATUS: 'blockStatus' }, xs: { BLOCK_ID: 'blockId', BLOCK_STATUS: 'blockStatus' },
    Hln: 'tencentDocsSelection', Bln: 'tdoc-selection://',
    createBlockId$1: () => 'fixture-block-id',
    mimeFromFilename: name => name.endsWith('.png') ? 'image/png' : 'text/plain',
    isPromptImageAttachment: file => file.type.startsWith('image/') && file.type !== 'image/svg+xml',
    URL,
    safeDecodeUri$1: value => value,
    getDocumentSelectionDisplayText: selection => selection.text,
    extractOnlineDocumentFileId: value => value.startsWith('tdoc://') ? value.slice(7) : undefined,
    formatDocumentSelectionContextText: text => text,
    getExtFromName: name => name.split('.').pop(), getFileType: () => 'document',
    Zr: (name, uri, options) => ({ type: 'resource_link', name, uri, title: options.title, _meta: options.meta }),
  });
  for (const slice of fixture.slices) vm.runInContext(slice.source, context);
  return context;
}
const native = nativeFunctions();
const native592Input = createNativeInputReplay();
function nativeFile(path, mimeType = 'text/plain') {
  const name = path.split('/').pop();
  return native.createAttachmentBlock({ name, type: mimeType, size: readFileSync(path).length }, pathToFileURL(path).href,
    name, 'fixture-id', 'completed', 'local', path, undefined);
}
async function expectCode(promise, code) {
  await assert.rejects(promise, error => error instanceof TurnInputError && error.code === code);
}

test('native constructor fixtures have exact current 5.9.1 provenance and valid slice hashes', () => {
  assert.equal(fixture.artifactSha256, '1fc0a56ddec5437d4dc55a55ba1c028b291ab29cb17306500827015987424233');
  assert.equal(fixture.constants.BLOCK_STATUS, 'blockStatus');
  assert.equal(fixture.slices.length, 9);
  for (const slice of fixture.slices) {
    assert.equal(createHash('sha256').update(slice.source).digest('hex'), slice.sha256);
    assert.equal(Buffer.byteLength(slice.source), slice.byteEnd - slice.byteStart);
    assert.ok(slice.member.startsWith('renderer/assets/'));
  }
});

test('the exact native Home scene is user context rather than a file and never opens its metadata paths', async () => {
  const root = workspace(), prompt = 'Synthetic scene classification only; do not contact any business service.';
  const blocks = native592Input.homeBlocks([{ type: 'text', text: prompt }]);
  assert.equal(blocks[0].uri, 'scene://122844'); assert.equal(blocks[0]._meta.sceneId, '122844');
  blocks[0]._meta.filePath = join(root, 'must-not-be-opened.txt');
  blocks[0]._meta.path = join(root, 'must-not-be-opened-either.txt');
  const previous = { open: fs.open, realpath: fs.realpath, lstat: fs.lstat }; let reads = 0;
  for (const key of Object.keys(previous)) fs[key] = () => { reads++; throw Error('A scene is not a selected local file'); };
  let result;
  try { result = await prepareTurnInput({ promptContentBlocks: blocks, cwd: root }); }
  finally { Object.assign(fs, previous); }
  assert.equal(reads, 0); assert.deepEqual(result.scenes, [{ id: '122844', name: '企业微信' }]);
  assert.deepEqual(result.attachments, []); assert.deepEqual(result.images, []);
  assert.ok(result.message.includes(prompt)); assert.ok(result.message.includes('企业微信')); assert.ok(result.message.includes('122844'));
  assert.match(result.message, /不改变已授权工具/); assert.doesNotMatch(result.message, /scene:\/\/|must-not-be-opened|<svg/);
  assert.ok(result.summary.includes('[场景：企业微信]')); assert.ok(!result.summary.includes('[附件：'));
});

test('a repeated native scene is deduplicated without consuming an attachment slot and scene-only input remains empty', async () => {
  const root = workspace(), filename = file(root, 'selected.txt', 'SYNTHETIC_SELECTED_TEXT');
  const scene = native592Input.homeSceneBlock();
  const result = await prepareTurnInput({ cwd: root, promptContentBlocks: [scene, native592Input.homeSceneBlock(), nativeFile(filename)] }, { limits: { maxAttachments: 1 } });
  assert.deepEqual(result.scenes, [{ id: '122844', name: '企业微信' }]); assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].kind, 'text'); assert.ok(result.message.includes('SYNTHETIC_SELECTED_TEXT'));
  await expectCode(prepareTurnInput({ promptContentBlocks: native592Input.homeBlocks([]), cwd: root }), 'TURN_INPUT_EMPTY');
  const other = native592Input.homeSceneBlock({ ...native592Input.wecomScene(), id: 'synthetic-other', name: 'Synthetic other scene' });
  await assert.rejects(prepareTurnInput({ promptContentBlocks: [scene, other, { type: 'text', text: 'synthetic' }], cwd: root }), error => error.code === 'NATIVE_SCENE_CONFLICT');
});

test('scene classification preserves remote/host/traversal guards and rejects forged scene declarations', async () => {
  const root = workspace(), filename = file(root, 'selected.txt', 'MUST_NOT_BYPASS_REMOTE_GUARD');
  await expectCode(prepareTurnInput({ cwd: root, promptContentBlocks: [{ type: 'resource_link', uri: 'https://example.invalid/file.txt',
    mimeType: 'text/plain', _meta: { filePath: filename } }] }), 'ATTACHMENT_REMOTE_UNSUPPORTED');
  await expectCode(prepareTurnInput({ cwd: root, promptContentBlocks: [{ type: 'resource_link', uri: 'file://remote-host/etc/passwd', mimeType: 'text/plain' }] }), 'ATTACHMENT_PATH_INVALID');
  await expectCode(prepareTurnInput({ cwd: root, promptContentBlocks: [{ type: 'resource_link', uri: 'file:///synthetic/../selected.txt', mimeType: 'text/plain' }] }), 'ATTACHMENT_PATH_INVALID');
  await expectCode(prepareTurnInput({ cwd: root, promptContentBlocks: [native592Input.skillInsert({ id: 'synthetic-skill', name: 'synthetic-skill' })] }), 'ATTACHMENT_REMOTE_UNSUPPORTED');
  for (const modify of [
    block => { block._meta.sceneId = 'wrong-id'; }, block => { block.uri = 'scene://122844?secret=DO_NOT_ECHO_SECRET'; },
    block => { block.uri = 'scene://../../DO_NOT_ECHO_SECRET'; }, block => { block.uri = 'https://example.invalid/DO_NOT_ECHO_SECRET'; },
    block => { block._meta.mentionType = 'skill'; block._meta.skillId = 'synthetic-skill'; },
  ]) {
    const block = JSON.parse(JSON.stringify(native592Input.homeSceneBlock())); modify(block);
    await assert.rejects(prepareTurnInput({ cwd: root, promptContentBlocks: [block, { type: 'text', text: 'synthetic' }] }), error => {
      assert.equal(error.code, 'NATIVE_SCENE_INVALID'); assert.ok(!String(error.message).includes('DO_NOT_ECHO_SECRET')); return true;
    });
  }
});

test('exact native connector-link kinds fail with typed reasons before any file or network access', async () => {
  const root = workspace(), provider = { id: 'synthetic-provider', connectorId: 'synthetic-connector', authorization: 'required',
    getInitialDisplayText: () => 'Synthetic connector link' }, url = 'https://example.invalid/synthetic-document';
  const previous = { open: fs.open, realpath: fs.realpath, lstat: fs.lstat }, fetchBefore = globalThis.fetch; let fileCalls = 0, networkCalls = 0;
  for (const key of Object.keys(previous)) fs[key] = () => { fileCalls++; throw Error('Connector links must not be read as files'); };
  globalThis.fetch = () => { networkCalls++; throw Error('No automatic connector expansion is allowed'); };
  try {
    for (const [authorized, kind, code] of [[false, 'connector-link-pending-auth', 'NATIVE_CONNECTOR_LINK_AUTH_REQUIRED'],
      [true, 'connector-link-resolved', 'NATIVE_CONNECTOR_LINK_UNSUPPORTED']]) {
      const block = native592Input.connectorLink({ rawUrl: url }, provider, authorized);
      assert.equal(block._meta.kind, kind); block._meta.filePath = join(root, 'must-not-be-opened.txt');
      await expectCode(prepareTurnInput({ cwd: root, promptContentBlocks: [block, { type: 'text', text: 'Synthetic input only' }] }), code);
    }
    await expectCode(prepareTurnInput({ cwd: root, promptContentBlocks: [{ type: 'resource_link', uri: url, _meta: { filePath: join(root, 'not-selected.txt') } }] }), 'ATTACHMENT_REMOTE_UNSUPPORTED');
  } finally { Object.assign(fs, previous); globalThis.fetch = fetchBefore; }
  assert.equal(fileCalls, 0); assert.equal(networkCalls, 0);
});

test('explicit selection text keeps priority over connector-link classification without reading or expanding its source', async () => {
  const root = workspace(), provider = { id: 'synthetic-provider', connectorId: 'synthetic-connector', authorization: 'required', getInitialDisplayText: () => 'Synthetic excerpt' };
  const previous = { open: fs.open, realpath: fs.realpath, lstat: fs.lstat }; let fileCalls = 0;
  for (const key of Object.keys(previous)) fs[key] = () => { fileCalls++; throw Error('An explicit selection must not open its source'); };
  try {
    for (const authorized of [false, true]) {
      const block = native592Input.connectorLink({ rawUrl: 'https://example.invalid/synthetic-document' }, provider, authorized);
      Object.assign(block._meta, authorized ? { mentionType: 'selection', llmText: 'SYNTHETIC_SELECTED_RESOLVED' }
        : { selectionQuote: true, selectedText: 'SYNTHETIC_SELECTED_PENDING' });
      block._meta.filePath = join(root, 'must-not-be-opened.txt');
      const prepared = await prepareTurnInput({ cwd: root, promptContentBlocks: [block] });
      assert.equal(prepared.attachments[0].kind, 'selection'); assert.deepEqual(prepared.scenes, []);
      assert.ok(prepared.message.includes(authorized ? 'SYNTHETIC_SELECTED_RESOLVED' : 'SYNTHETIC_SELECTED_PENDING'));
    }
  } finally { Object.assign(fs, previous); }
  assert.equal(fileCalls, 0);
});

test('the native 3000-grapheme paste boundary remains ordinary text and longer Unicode chips retain their whole text', async () => {
  for (const glyph of ['e\u0301', '👨‍👩‍👧‍👦']) {
    assert.equal(native592Input.inputLength(glyph + '\u200B'), 1);
    for (const count of [3000, 3001]) {
      const body = glyph.repeat(count), pasted = native592Input.paste({ text: body });
      assert.equal(native592Input.inputLength(body), count);
      if (count === 3000) {
        assert.equal(pasted.blocks.length, 0); assert.equal(pasted.plainText, body);
      } else {
        assert.equal(pasted.blocks.length, 1); assert.equal(pasted.blocks[0].type, 'resource_link');
        assert.ok(pasted.blocks[0].uri.startsWith('longtext://')); assert.equal(pasted.blocks[0]._meta.mentionType, 'long-text');
        assert.equal(native592Input.isAttachment(pasted.blocks[0]), false); assert.equal(native592Input.longTextContent(pasted.blocks[0]), body);
      }
      // Plain paste is captured at Slate insertText; the normal send boundary
      // serializes that text, whereas insertNodes supplies the real chip block.
      const blocks = pasted.blocks.length ? pasted.blocks : [{ type: 'text', text: pasted.plainText }];
      const result = await prepareTurnInput({ promptContentBlocks: blocks, prompt: 'DO_NOT_REPLACE_THE_BODY' });
      assert.equal(result.message, body); assert.deepEqual(result.attachments, []); assert.deepEqual(result.scenes, []);
    }
  }
});

test('native long paste uses fullText at its original user-text position, not its preview URI, and performs no file reads', async () => {
  const root = workspace(), original = 'SYNTHETIC_LONG_FIRST\r\n' + 'e\u0301'.repeat(3001) + '\r\nSYNTHETIC_LONG_LAST';
  const pasted = native592Input.paste({ text: original }), block = pasted.blocks[0], full = block._meta.fullText;
  assert.ok(full.startsWith('SYNTHETIC_LONG_FIRST\n')); assert.ok(full.endsWith('\nSYNTHETIC_LONG_LAST')); assert.ok(!full.includes('\r\n'));
  assert.ok(block._meta.displayText.length < full.length); assert.ok(!block.uri.includes('SYNTHETIC_LONG_LAST'));
  block._meta.filePath = join(root, 'must-not-open-longtext.txt');
  const previous = { open: fs.open, realpath: fs.realpath, lstat: fs.lstat }; let fileCalls = 0;
  for (const key of Object.keys(previous)) fs[key] = () => { fileCalls++; throw Error('Pasted text is not a file'); };
  try {
    const result = await prepareTurnInput({ cwd: root, promptContentBlocks: [{ type: 'text', text: 'BEFORE|' }, block, { type: 'text', text: '|AFTER' }] });
    assert.equal(result.message, 'BEFORE|' + full + '|AFTER'); assert.deepEqual(result.attachments, []);
    const edited = JSON.parse(JSON.stringify(block)); edited._meta.fullText = 'EDITED_WHOLE_FIRST|' + '文'.repeat(3001) + '|EDITED_WHOLE_LAST';
    assert.equal((await prepareTurnInput({ cwd: root, promptContentBlocks: [edited] })).message, edited._meta.fullText, 'An edited chip need not match its old preview or count');
  } finally { Object.assign(fs, previous); }
  assert.equal(fileCalls, 0);
});

test('forged long-text declarations cannot turn remote resources or preview-only chips into user text', async () => {
  const valid = native592Input.paste({ text: 'SYNTHETIC_FIRST|' + '文'.repeat(3001) + '|SYNTHETIC_LAST' }).blocks[0];
  for (const mutate of [
    block => { delete block._meta.fullText; }, block => { block._meta.fullText = { text: 'DO_NOT_ECHO_TEXT' }; },
    block => { block.uri = 'https://example.invalid/DO_NOT_ECHO_TEXT'; }, block => { block.uri = 'longtext://../../DO_NOT_ECHO_TEXT'; },
    block => { block.uri += '?token=DO_NOT_ECHO_TEXT'; },
  ]) {
    const block = JSON.parse(JSON.stringify(valid)); mutate(block);
    await assert.rejects(prepareTurnInput({ promptContentBlocks: [block] }), error => {
      assert.equal(error.code, 'NATIVE_LONG_TEXT_INVALID'); assert.ok(!String(error.message).includes('DO_NOT_ECHO_TEXT')); return true;
    });
  }
  await expectCode(prepareTurnInput({ promptContentBlocks: [{ type: 'resource_link', uri: 'https://example.invalid/plain', _meta: { fullText: 'DO_NOT_USE_UNSELECTED_TEXT' } }] }), 'ATTACHMENT_REMOTE_UNSUPPORTED');
});

test('maps the native local text shape and preserves Unicode without executing attachment text', async () => {
  const root = workspace();
  const content = '营业收入：¥1,230,000\n中文、e\u0301、😀\n$(touch never-execute)\n<script>globalThis.run=true</script>';
  const path = file(root, '季度 报表.md', content);
  const input = nativeFile(path, 'text/markdown');
  assert.equal(input._meta.blockStatus, 'completed');
  assert.equal(input.type, 'resource_link');
  const result = await prepareTurnInput({ prompt: 'fallback', promptContentBlocks: [{ type: 'text', text: '请分析。' }, input], cwd: root });
  assert.ok(result.message.startsWith('请分析。'));
  assert.ok(result.message.includes(content));
  assert.deepEqual(result.images, []);
  assert.equal(result.attachments[0].kind, 'text');
  assert.equal(result.attachments[0].size, Buffer.byteLength(content));
  assert.equal(result.attachments[0].sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(result.summary, '请分析。\n[附件：季度 报表.md]');
  assert.ok(!JSON.stringify(result.attachments).includes('never-execute'));
});

test('reads a native path image in main and ignores renderer inline bytes', async () => {
  const root = workspace();
  const path = file(root, '图片.png', PNG);
  const block = nativeFile(path, 'image/png');
  block.data = 'renderer-data-must-not-be-used';
  const result = await prepareTurnInput({ promptContentBlocks: [block] });
  assert.deepEqual(result.images, [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }]);
  assert.equal(result.summary, '[附件：图片.png]');
  assert.ok(!JSON.stringify(result.attachments).includes(PNG.toString('base64')));
  assert.equal(result.attachments[0].kind, 'image');
});

test('native local image without imageData is a resource_link and still becomes a Pi image', async () => {
  const root = workspace();
  const path = file(root, '来自文件选择.png', PNG);
  const block = native.createLocalFileAttachmentBlock({ filename: '来自文件选择.png', filePath: path, mimeType: 'image/png', size: PNG.length });
  assert.equal(block.type, 'resource_link');
  assert.equal(block.mimeType, 'image/png');
  const result = await prepareTurnInput({ promptContentBlocks: [block] });
  assert.equal(result.images[0].data, PNG.toString('base64'));
});

test('recognizes GIF and WebP containers and rejects their MIME mismatch', async () => {
  const root = workspace();
  for (const [name, mime, data] of [
    ['pixel.gif', 'image/gif', 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'],
    ['pixel.webp', 'image/webp', 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'],
  ]) {
    const bytes = Buffer.from(data, 'base64');
    const path = file(root, name, bytes);
    const result = await prepareTurnInput({ promptContentBlocks: [nativeFile(path, mime)] });
    assert.equal(result.images[0].mimeType, mime);
    assert.equal(result.images[0].data, data);
    await expectCode(prepareTurnInput({ promptContentBlocks: [nativeFile(path, 'image/jpeg')] }), 'ATTACHMENT_MIME_MISMATCH');
  }
});

test('native @file metadata can select an absolute file outside cwd, without reading siblings', async () => {
  const root = workspace();
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  const path = file(root, 'explicit.txt', 'ONLY SELECTED CONTENT');
  file(root, 'sibling.txt', 'MUST NOT APPEAR');
  const block = native.createFileMentionBlock({ label: 'explicit.txt', id: 'explicit.txt', description: root,
    metadata: { type: 'file', relativePath: 'explicit.txt', filePath: path } });
  const result = await prepareTurnInput({ promptContentBlocks: [block], cwd });
  assert.ok(result.message.includes('ONLY SELECTED CONTENT'));
  assert.ok(!result.message.includes('MUST NOT APPEAR'));
});

test('supports explicit relative @file within cwd, and escaped file URI', async () => {
  const root = workspace();
  const path = file(root, '中文 #文件%.txt', 'escaped content');
  const block = { type: 'resource_link', name: 'selected', uri: pathToFileURL(path).href, mimeType: 'text/plain' };
  assert.ok((await prepareTurnInput({ promptContentBlocks: [block], cwd: root })).message.includes('escaped content'));
  block.uri = '中文 #文件%.txt';
  assert.ok((await prepareTurnInput({ promptContentBlocks: [block], cwd: root })).message.includes('escaped content'));
});

test('native unescaped #/?/% filename URI reads only the exact explicit metadata path', async () => {
  const root = workspace();
  const path = file(root, '季度 #报表%?.txt', 'literal filename content');
  const block = native.createLocalFileAttachmentBlock({ filename: '季度 #报表%?.txt', filePath: path, mimeType: 'text/plain' });
  assert.ok(new URL(block.uri).hash);
  assert.notEqual(block.uri, pathToFileURL(path).href);
  const result = await prepareTurnInput({ promptContentBlocks: [block] });
  assert.ok(result.message.includes('literal filename content'));
  assert.equal(result.attachments[0].uri, pathToFileURL(path).href);
  const withoutExplicitPath = { ...block, _meta: { ...block._meta, filePath: undefined } };
  await expectCode(prepareTurnInput({ promptContentBlocks: [withoutExplicitPath] }), 'ATTACHMENT_PATH_INVALID');
});

test('native quote selection uses selected text without reading the source or preview image', async () => {
  const block = native.buildSelectionQuotePhraseBlock({ name: 'selected range', selectedText: '被选择的中文',
    uri: '/does-not-exist/private.docx', title: '选择来源.docx', screenshot: PNG.toString('base64') });
  assert.equal(block._meta.mentionType, 'selection');
  const result = await prepareTurnInput({ promptContentBlocks: [block] });
  assert.ok(result.message.includes('被选择的中文'));
  assert.equal(result.attachments[0].kind, 'selection');
  assert.equal(result.images.length, 0);
  assert.ok(!result.summary.includes('被选择的中文'));
});

test('native Tencent document selection uses selectionPayload.text and never filePath', async () => {
  const block = native.createDocumentSelectionContextBlock({ sessionId: 'fixture-session',
    filePath: '/does-not-exist/report.xlsx', documentResourceUri: 'tdoc://fixture-doc',
    selection: { text: 'A1:B3 金融数据', rangeId: 'sheet!A1:B3', aiPrompt: 'NATIVE ACTION NOT AN ATTACHMENT', title: '金融表格' } });
  assert.equal(block._meta.mentionType, 'tencentDocsSelection');
  const result = await prepareTurnInput({ promptContentBlocks: [block] });
  assert.ok(result.message.includes('A1:B3 金融数据'));
  assert.ok(!result.message.includes('NATIVE ACTION'));
  assert.equal(result.attachments[0].name, '金融表格');
});

test('empty selections fail instead of reading the full source document', async () => {
  const root = workspace();
  const path = file(root, 'unselected.txt', 'DO NOT READ WHOLE FILE');
  const block = { type: 'resource_link', uri: 'selection://file', _meta: { mentionType: 'selection', filePath: path } };
  await expectCode(prepareTurnInput({ promptContentBlocks: [block] }), 'ATTACHMENT_SELECTION_EMPTY');
});

test('native netdrive logical filePath must never become a local read', async () => {
  const root = workspace();
  const path = file(root, 'netdrive-logical.txt', 'DO NOT READ');
  const block = native.createNetDriveFileBlock({ fileName: 'cloud.txt', filePath: path, fileId: 'remote-fixture', fileSize: 11 });
  assert.equal(block.uri, 'netdrive://cloud.txt');
  await expectCode(prepareTurnInput({ promptContentBlocks: [block] }), 'ATTACHMENT_REMOTE_UNSUPPORTED');
});

test('rejects all remote/provider schemes including dangerous URLs and never fetches', async () => {
  const previous = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => { fetches++; throw new Error('must not fetch'); };
  try {
    for (const uri of ['https://example.invalid/file.png', 'http://127.0.0.1/admin', 'http://169.254.169.254/metadata',
      'ftp://example.invalid/a.txt', 'javascript:alert(1)', 'data:text/plain;base64,SGk=', 'ima:///file', 'tdoc://id', 'skill://id', 'command://synthetic-skill']) {
      await expectCode(prepareTurnInput({ promptContentBlocks: [{ type: 'resource_link', uri, name: 'selected', mimeType: 'text/plain' }] }), 'ATTACHMENT_REMOTE_UNSUPPORTED');
    }
    assert.equal(fetches, 0);
    assert.equal((await prepareTurnInput({ prompt: '请看 https://example.invalid/report' })).message, '请看 https://example.invalid/report');
  } finally { globalThis.fetch = previous; }
});

test('rejects inline-only native image and data-only generic file without moving bytes over binding', async () => {
  const image = native.createImageBlock(PNG.toString('base64'), 'image/png', '', { filename: 'Clipboard.png' });
  await expectCode(prepareTurnInput({ promptContentBlocks: [image] }), 'ATTACHMENT_LOCAL_PATH_REQUIRED');
  const generic = native.createFileBlock('binary-data', 'text/plain', 'only-name.txt', {});
  await expectCode(prepareTurnInput({ promptContentBlocks: [generic] }), 'ATTACHMENT_PATH_INVALID');
});

test('rejects failed/processing native blockStatus, even with a valid local file', async () => {
  const path = file(workspace(), 'ready.txt', 'content');
  for (const blockStatus of ['failed', 'processing', 'uploading', '', null]) {
    const block = nativeFile(path);
    block._meta.blockStatus = blockStatus;
    await expectCode(prepareTurnInput({ promptContentBlocks: [block] }), 'ATTACHMENT_NOT_READY');
  }
});

test('rejects invalid, escaped, nonlocal file URI, traversal and inconsistent selected paths', async () => {
  const root = workspace();
  const path = file(root, 'safe.txt', 'safe');
  for (const uri of ['file://remote-host/etc/passwd', 'file:///etc/passwd?x=1', 'file:///etc/passwd#x',
    'file:///bad%00.txt', 'file:///bad%2f.txt', 'file:///bad%5c.txt', 'file:///bad%zz.txt',
    'file:///some/../private.txt', 'file:///some/%2e%2e/private.txt', 'file:///some/.%2e/private.txt',
    '../safe.txt', `${root}/../safe.txt`, '//server/share/a.txt', 'bad\0.txt', 'C:\\windows\\a.txt']) {
    await expectCode(prepareTurnInput({ promptContentBlocks: [{ type: 'resource_link', uri, mimeType: 'text/plain' }], cwd: root }), 'ATTACHMENT_PATH_INVALID');
  }
  const block = nativeFile(path);
  block.uri = pathToFileURL(join(root, 'different.txt')).href;
  await expectCode(prepareTurnInput({ promptContentBlocks: [block] }), 'ATTACHMENT_PATH_MISMATCH');
});

test('rejects missing files, directories and symlink components', async () => {
  const root = workspace();
  const path = file(root, 'original.txt', 'selected');
  const link = join(root, 'link.txt');
  symlinkSync(path, link);
  await expectCode(prepareTurnInput({ promptContentBlocks: [{ type: 'resource_link', uri: pathToFileURL(link).href, mimeType: 'text/plain' }] }), 'ATTACHMENT_SYMLINK');
  const directory = join(root, 'folder');
  mkdirSync(directory);
  file(directory, 'nested.txt', 'selected');
  const dirLink = join(root, 'folder-link');
  symlinkSync(directory, dirLink);
  await expectCode(prepareTurnInput({ promptContentBlocks: [{ type: 'resource_link', uri: pathToFileURL(join(dirLink, 'nested.txt')).href, mimeType: 'text/plain' }] }), 'ATTACHMENT_SYMLINK');
  await expectCode(prepareTurnInput({ promptContentBlocks: [{ type: 'resource_link', uri: pathToFileURL(directory).href, mimeType: 'text/plain' }] }), 'ATTACHMENT_NOT_FILE');
  await expectCode(prepareTurnInput({ promptContentBlocks: [{ type: 'resource_link', uri: pathToFileURL(join(root, 'missing.txt')).href, mimeType: 'text/plain' }] }), 'ATTACHMENT_READ_FAILED');
});

test('rejects binary, invalid UTF-8, deceptive MIME and corrupt document files', async () => {
  const root = workspace();
  for (const [name, content, mimeType, code] of [
    ['binary.txt', Buffer.from([65, 0, 66]), 'text/plain', 'ATTACHMENT_BINARY_UNSUPPORTED'],
    ['invalid.txt', Buffer.from([0xc3, 0x28]), 'text/plain', 'ATTACHMENT_BINARY_UNSUPPORTED'],
    ['valid.txt', PNG, 'text/plain', 'ATTACHMENT_MIME_MISMATCH'],
    ['fake.png', 'not an image', 'image/png', 'ATTACHMENT_IMAGE_INVALID'],
    ['wrong.jpg', PNG, 'image/png', 'ATTACHMENT_MIME_MISMATCH'],
    ['wrong.png', PNG, 'image/jpeg', 'ATTACHMENT_MIME_MISMATCH'],
    ['vector.svg', '<svg/>', 'image/svg+xml', 'ATTACHMENT_IMAGE_INVALID'],
    ['binary.bin', 'text-like bytes', 'application/octet-stream', 'ATTACHMENT_BINARY_UNSUPPORTED'],
    ['mime.txt', 'text', 'not a mime', 'ATTACHMENT_MIME_INVALID'],
    ['financial.doc', 'old', 'application/msword', 'ATTACHMENT_DOCUMENT_UNSUPPORTED'],
    ['financial.docx', 'PK', 'application/octet-stream', 'ATTACHMENT_DOCUMENT_INVALID'],
    ['financial.xlsx', 'PK', 'application/octet-stream', 'ATTACHMENT_DOCUMENT_INVALID'],
    ['financial.pptx', 'PK', 'application/octet-stream', 'ATTACHMENT_DOCUMENT_INVALID'],
  ]) {
    const path = file(root, name, content);
    await expectCode(prepareTurnInput({ promptContentBlocks: [nativeFile(path, mimeType)] }), code);
  }
});

test('accepts UTF-8 BOM, tab, newline and selected code files as inert text', async () => {
  const path = file(workspace(), 'selected.mjs', '\ufeffimport { rmSync } from "node:fs";\n//\t中文\nthrow Error("NEVER EXECUTE");');
  const result = await prepareTurnInput({ promptContentBlocks: [nativeFile(path, 'application/javascript')] });
  assert.ok(result.message.includes('NEVER EXECUTE'));
  assert.ok(result.message.includes('//\t中文'));
});

test('enforces per-file, text, cumulative, count and final Pi RPC byte limits', async () => {
  const root = workspace();
  const imagePath = file(root, 'small.png', PNG);
  await expectCode(prepareTurnInput({ promptContentBlocks: [nativeFile(imagePath, 'image/png')] }, { limits: { maxFileBytes: PNG.length - 1 } }), 'ATTACHMENT_TOO_LARGE');
  const textPath = file(root, 'large.txt', '中'.repeat(20));
  const block = nativeFile(textPath);
  await expectCode(prepareTurnInput({ promptContentBlocks: [block] }, { limits: { maxTextBytes: 59 } }), 'ATTACHMENT_TOO_LARGE');
  await expectCode(prepareTurnInput({ promptContentBlocks: [block, block] }, { limits: { maxTotalBytes: 100 } }), 'ATTACHMENTS_TOO_LARGE');
  await expectCode(prepareTurnInput({ promptContentBlocks: [block, block] }, { limits: { maxAttachments: 1 } }), 'ATTACHMENTS_TOO_MANY');
  await expectCode(prepareTurnInput({ prompt: 'too large' }, { limits: { maxMessageBytes: 3 } }), 'TURN_INPUT_TOO_LARGE');
  await expectCode(prepareTurnInput({ promptContentBlocks: [nativeFile(imagePath, 'image/png')] }, { limits: { maxRpcBytes: 40 } }), 'TURN_INPUT_TOO_LARGE');
  for (const limits of [{ maxFileBytes: 0 }, { maxAttachments: 1.5 }, { unrecognized: 3 }]) {
    await assert.rejects(prepareTurnInput({ prompt: 'test' }, { limits }), TypeError);
  }
});

test('default maximum aggregate image bytes and almost maximum text fit Pi 8MiB RPC record including base64', async () => {
  const root = workspace();
  const bytes = Buffer.alloc(DEFAULT_TURN_INPUT_LIMITS.maxTotalBytes);
  PNG.copy(bytes);
  const path = file(root, 'maximum.png', bytes);
  const result = await prepareTurnInput({ prompt: 'x'.repeat(DEFAULT_TURN_INPUT_LIMITS.maxMessageBytes - 1024),
    promptContentBlocks: [nativeFile(path, 'image/png')] });
  const recordBytes = Buffer.byteLength(JSON.stringify({ type: 'prompt', id: 'fixture-id', message: result.message, images: result.images }));
  assert.ok(recordBytes < 8 * 1024 * 1024);
  assert.ok(recordBytes > bytes.length);
  assert.equal(result.images[0].data.length, 4 * Math.ceil(bytes.length / 3));
  await expectCode(prepareTurnInput({ prompt: '\0'.repeat(DEFAULT_TURN_INPUT_LIMITS.maxMessageBytes - 1024),
    promptContentBlocks: [nativeFile(path, 'image/png')] }), 'TURN_INPUT_TOO_LARGE');
});

test('rejects size metadata drift since selection and invalid selected size', async () => {
  const path = file(workspace(), 'changed.txt', 'new content');
  const block = nativeFile(path);
  block._meta.size = 3;
  await expectCode(prepareTurnInput({ promptContentBlocks: [block] }), 'ATTACHMENT_CHANGED');
  for (const size of [-1, 1.5, '8']) {
    block._meta.size = size;
    await expectCode(prepareTurnInput({ promptContentBlocks: [block] }), 'ATTACHMENT_SIZE_INVALID');
  }
});

async function interceptRead(action, run) {
  const original = fs.open;
  let intercepted = false;
  fs.open = async (...args) => {
    const handle = await original(...args);
    return new Proxy(handle, {
      get(target, name) {
        if (name === 'read') return async (...readArgs) => {
          const result = await target.read(...readArgs);
          if (!intercepted) { intercepted = true; await action(); }
          return result;
        };
        const value = Reflect.get(target, name);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  try { await run(); } finally { fs.open = original; }
  assert.equal(intercepted, true);
}

test('cancelled before preparation and during a bounded read aborts without partial result', async () => {
  const controller = new AbortController();
  controller.abort();
  await expectCode(prepareTurnInput({ prompt: 'test', signal: controller.signal }), 'TURN_INPUT_CANCELLED');
  const root = workspace();
  const path = file(root, 'cancel.txt', 'selected content');
  const mid = new AbortController();
  await interceptRead(() => mid.abort(), () => expectCode(prepareTurnInput({ promptContentBlocks: [nativeFile(path)], signal: mid.signal }), 'TURN_INPUT_CANCELLED'));
});

test('same-size file mutation during read fails from mtime/ctime instead of sending a mixed snapshot', async () => {
  const path = file(workspace(), 'mutated.txt', 'old contents');
  const block = nativeFile(path);
  await interceptRead(() => fs.writeFile(path, 'new contents'), () => expectCode(prepareTurnInput({ promptContentBlocks: [block] }), 'ATTACHMENT_CHANGED'));
});

test('file replacement during read fails inode comparison even when size matches', async () => {
  const root = workspace();
  const path = file(root, 'replaced.txt', 'same size');
  const block = nativeFile(path);
  await interceptRead(() => {
    renameSync(path, join(root, 'old.txt'));
    writeFileSync(path, 'same size');
  }, () => expectCode(prepareTurnInput({ promptContentBlocks: [block] }), 'ATTACHMENT_CHANGED'));
});

test('empty, malformed or unsupported input fails; fallback text works without blocks', async () => {
  assert.equal((await prepareTurnInput({ prompt: '普通输入' })).summary, '普通输入');
  for (const input of [{ promptContentBlocks: null }, { prompt: 3 }, { promptContentBlocks: [null] },
    { promptContentBlocks: [{ type: 'text', text: 3 }] }]) await expectCode(prepareTurnInput(input), 'TURN_INPUT_INVALID');
  await expectCode(prepareTurnInput({ promptContentBlocks: [{ type: 'audio' }] }), 'TURN_INPUT_BLOCK_UNSUPPORTED');
  await expectCode(prepareTurnInput({}), 'TURN_INPUT_EMPTY');
});
