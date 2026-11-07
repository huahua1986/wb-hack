import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNativeSceneBlock, parseNativeLongTextBlock, describeNativeInput } from '../src/native-input-resources.mjs';
import { createNativeInputReplay } from './fixtures/native-input-592.replay.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const scene = () => plain(createNativeInputReplay().homeSceneBlock());
const invalid = input => assert.throws(() => parseNativeSceneBlock(input), error => {
  assert.equal(error.code, 'NATIVE_SCENE_INVALID');
  assert.equal(error.message, '原生场景标记无效，请从首页重新选择场景。');
  return true;
});

test('real native Wecom home block maps to bounded context without forwarding icon or file data', () => {
  const native = createNativeInputReplay(), blocks = native.homeBlocks([{ type: 'text', text: 'Synthetic task. No connector calls.' }]);
  assert.equal(blocks[0].uri, 'scene://122844');
  assert.deepEqual(parseNativeSceneBlock(blocks[0]), { id: '122844', name: '企业微信' });
  assert.deepEqual(Object.keys(parseNativeSceneBlock(blocks[0])).sort(), ['id', 'name']);
  assert.equal(parseNativeSceneBlock(blocks[1]), null);
});

test('scene parser leaves native skill, slash command, file and HTTPS connector inputs for their own paths', () => {
  const native = createNativeInputReplay();
  const blocks = [
    native.skillInsert({ id: '/synthetic/SKILL.md', name: 'test', slug: 'test', displayName: 'Synthetic' }),
    native.slashCommand({ name: 'compact', category: 'command' }),
    native.fileMention({ id: 'note.md', label: 'note.md', metadata: { type: 'file', filePath: '/synthetic/note.md' } }),
    native.connectorLink({ rawUrl: 'https://synthetic.invalid/document/1' }, { id: 'synthetic', connectorId: 'synthetic' }, false),
    { type: 'resource_link', uri: 'https://synthetic.invalid/attachment.pdf' },
  ];
  for (const block of blocks) assert.equal(parseNativeSceneBlock(block), null);
  const kinds = describeNativeInput(blocks).blocks.map(block => block.kind);
  assert.deepEqual(kinds, ['skill', 'command', 'file', 'connector-link', 'remote']);
});

test('scene declarations cannot disguise HTTP, file, query, hash, credentials or path resources', () => {
  for (const uri of ['https://synthetic.invalid/122844', 'file:///synthetic/122844', 'scene://122844?token=SECRET',
    'scene://122844#fragment', 'scene://user:password@122844', 'scene://122844/path', 'scene://%31%32', 'SCENE://122844']) {
    invalid({ ...scene(), uri });
  }
  for (const uri of ['scene://122844', 'scene:122844']) invalid({ type: 'resource_link', uri });
  const block = scene(); block._meta.sceneId = 'other'; invalid(block);
});

test('scene parser requires the exact semantic metadata rather than trusting URI or display labels', () => {
  for (const key of ['type', 'mentionType', 'sceneId', 'displayText']) {
    const missing = scene(); delete missing._meta[key]; invalid(missing);
  }
  for (const key of ['type', 'mentionType']) { const block = scene(); block._meta[key] = 'file'; invalid(block); }
  const numeric = scene(); numeric._meta.sceneId = 122844; invalid(numeric);
  assert.equal(parseNativeSceneBlock({ type: 'text', uri: 'scene://122844', _meta: scene()._meta }), null);
  assert.equal(parseNativeSceneBlock({ type: 'image', uri: 'scene://122844', _meta: scene()._meta }), null);
});

test('scene identifiers and labels enforce byte and Unicode boundaries', () => {
  const native = createNativeInputReplay();
  assert.deepEqual(parseNativeSceneBlock(native.homeSceneBlock({ id: 'a'.repeat(128), name: 'a'.repeat(256) })), { id: 'a'.repeat(128), name: 'a'.repeat(256) });
  assert.deepEqual(parseNativeSceneBlock(native.homeSceneBlock({ id: 'office_1-test', name: '文'.repeat(85) })), { id: 'office_1-test', name: '文'.repeat(85) });
  for (const id of ['a'.repeat(129), '', 'with space', '含中文', '..', 'a/b', 'a?b']) invalid(native.homeSceneBlock({ id, name: 'Synthetic' }));
  for (const name of ['', '   ', 'a'.repeat(257), '文'.repeat(86), 'bad\nlabel', 'bad\u0085label', 'bad\u0000label', '\ud800', '\udc00']) {
    invalid(native.homeSceneBlock({ id: 'test', name }));
  }
  assert.deepEqual(parseNativeSceneBlock(native.homeSceneBlock({ id: 'emoji', name: '文档📚' })), { id: 'emoji', name: '文档📚' });
});

test('diagnostic records reveal fixed shapes, protocol and fingerprints but no prompt or address values', () => {
  const secret = 'SYNTHETIC_PASSWORD_456';
  const validScene = scene(); validScene._meta.svgIcon = secret; validScene.name = secret;
  const blocks = [validScene,
    { type: 'text', text: secret },
    { type: 'resource_link', uri: `https://user:${secret}@synthetic.invalid/private/${secret}?token=${secret}`, name: secret,
      _meta: { kind: 'connector-link-pending-auth', providerId: secret, connectorId: secret, rawUrl: secret, llmText: secret } },
    { type: 'resource_link', uri: `file:///private/${secret}.md`, _meta: { type: 'file', filePath: `/private/${secret}.md` } },
    { type: secret, uri: 'command://synthetic', _meta: { type: secret, mentionType: secret, kind: secret } },
  ];
  const result = describeNativeInput(blocks), encoded = JSON.stringify(result);
  assert.doesNotMatch(encoded, new RegExp(secret));
  for (const forbidden of ['synthetic.invalid', '/private/', 'rawUrl', 'providerId', 'connectorId', 'llmText', 'svgIcon', '"name":', '"text":']) assert.equal(encoded.includes(forbidden), false);
  assert.deepEqual(result.blocks[0], { index: 0, type: 'resource_link', uriScheme: 'scene:', kind: 'scene', sceneId: '122844', uriFingerprint: result.blocks[0].uriFingerprint });
  assert.match(result.blocks[0].uriFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(result.blocks[2].uriScheme, 'https:'); assert.equal(result.blocks[2].kind, 'connector-link');
  assert.equal(result.blocks[4].type, 'unknown'); assert.equal(result.blocks[4].kind, 'unknown');
  for (const entry of result.blocks) assert.ok(Object.keys(entry).every(key => ['index', 'type', 'uriScheme', 'kind', 'uriFingerprint', 'sceneId'].includes(key)));
});

test('invalid scenes are diagnostic-only and cannot leak their claimed identifiers or labels', () => {
  const block = scene(); block.uri = 'https://synthetic.invalid?password=HIDDEN'; block._meta.sceneId = 'HIDDEN'; block._meta.displayText = 'HIDDEN';
  const result = describeNativeInput([block]);
  assert.equal(result.blocks[0].kind, 'invalid-scene');
  assert.equal(result.blocks[0].sceneId, undefined);
  assert.doesNotMatch(JSON.stringify(result), /HIDDEN|synthetic.invalid|password/);
});

test('custom protocol names cannot inject credentials or arbitrary strings into diagnostics', () => {
  const secret = 'MySecretPassword';
  const result = describeNativeInput([
    { type: 'resource_link', uri: `${secret}://private/resource` },
    { type: 'resource_link', uri: 'Custom.Scheme+1:private' },
    { type: 'resource_link', uri: 'HTTPS://synthetic.invalid/document' },
  ]);
  assert.deepEqual(result.blocks.map(block => [block.uriScheme, block.kind]), [
    ['other:', 'remote'], ['other:', 'remote'], ['https:', 'remote'],
  ]);
  assert.doesNotMatch(JSON.stringify(result), /MySecretPassword|mysecretpassword|Custom|custom|private|synthetic.invalid/);
  assert.ok(result.blocks.every(block => /^[a-f0-9]{16}$/.test(block.uriFingerprint)));
});

test('diagnostics bound the number of blocks, protocol length and fingerprint input without throwing', () => {
  const result = describeNativeInput(Array.from({ length: 1000 }, () => ({ type: 'text', text: 'not retained' })));
  assert.equal(result.blocks.length, 64); assert.equal(result.truncated, true);
  const bounded = describeNativeInput([
    { type: 'resource_link', uri: 'A'.repeat(31) + ':x' },
    { type: 'resource_link', uri: 'A'.repeat(32) + ':x' },
    { type: 'resource_link', uri: 'https://' + 'a'.repeat(9000) },
    { type: 'resource_link', uri: '\nhttps://synthetic.invalid' },
  ]).blocks;
  assert.equal(bounded[0].uriScheme, 'other:'); assert.equal(bounded[1].uriScheme, 'unknown');
  assert.equal(bounded[2].uriFingerprint, undefined); assert.equal(bounded[3].uriScheme, 'unknown');
  for (const input of [undefined, null, {}, 'private text']) assert.deepEqual(describeNativeInput(input), { version: 1, blocks: [] });
  const throwing = new Proxy({}, { get() { throw Error('PRIVATE'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const invalidInputs = describeNativeInput([null, undefined, 1, 'PRIVATE', [], throwing, revoked.proxy]);
  assert.equal(invalidInputs.blocks.length, 7);
  assert.ok(invalidInputs.blocks.every(block => block.type === 'unknown' && block.kind === 'unknown'));
  assert.doesNotMatch(JSON.stringify(invalidInputs), /PRIVATE/);
});

test('describing a scene does not mutate the original native content blocks', () => {
  const native = createNativeInputReplay(), blocks = plain(native.homeBlocks([{ type: 'text', text: 'Synthetic' }]));
  const expected = structuredClone(blocks);
  Object.freeze(blocks[0]._meta); Object.freeze(blocks[0]); Object.freeze(blocks[1]); Object.freeze(blocks);
  describeNativeInput(blocks); parseNativeSceneBlock(blocks[0]);
  assert.deepEqual(blocks, expected);
});

const pastedLongText = (text = '合成'.repeat(1501)) => plain(createNativeInputReplay().paste({ text }).blocks[0]);
const invalidLongText = input => assert.throws(() => parseNativeLongTextBlock(input), error => {
  assert.equal(error.code, 'NATIVE_LONG_TEXT_INVALID');
  assert.equal(error.message, '原生长文本内容无效或超出大小限制，请重新粘贴文本。');
  return true;
});

test('real native long-paste resource supplies its complete text rather than its preview URI', () => {
  const native = createNativeInputReplay(), text = '🧪'.repeat(3001) + '\r\nSynthetic end marker.';
  const pasted = native.paste({ text }), block = pasted.blocks[0];
  assert.equal(block.type, 'resource_link'); assert.equal(block._meta.mentionType, 'long-text');
  assert.ok(block.uri.startsWith('longtext://')); assert.equal(native.isAttachment(block), false);
  const expected = text.replace(/\r\n/g, '\n');
  assert.equal(native.longTextContent(block), expected);
  assert.deepEqual(parseNativeLongTextBlock(block), { text: expected });
  assert.equal(Object.keys(parseNativeLongTextBlock(block)).join(','), 'text');
});

test('long-text references may outlive text edits and cannot substitute preview text for fullText', () => {
  const original = pastedLongText(), uri = original.uri;
  for (const text of ['Edited short text.', 'Line one\r\nLine two\tvalue', '']) {
    const edited = { ...original, _meta: { ...original._meta, fullText: text, displayText: 'Display-only fake content.' } };
    assert.deepEqual(parseNativeLongTextBlock(edited), { text });
    assert.equal(edited.uri, uri);
  }
  const missing = { ...original, _meta: { ...original._meta } }; delete missing._meta.fullText;
  invalidLongText(missing);
  const noPreviewMetadata = { ...original, _meta: { mentionType: 'long-text', fullText: 'Actual full text.' } };
  assert.deepEqual(parseNativeLongTextBlock(noPreviewMetadata), { text: 'Actual full text.' });
});

test('long-text URI and native semantic claims must agree without permitting remote or local address disguises', () => {
  for (const uri of ['https://synthetic.invalid/private', 'file:///private/local.txt', 'scene://122844',
    'LONGTEXT://preview...-3001', 'longtext:preview...-3001', 'longtext://preview/path...-3001',
    'longtext://user:password@preview...-3001', 'longtext://preview...-3001?token=PRIVATE',
    'longtext://preview...-3001#private', 'longtext://预览...-3001', 'longtext://bad%ZZ...-3001',
    'longtext://preview-3001', 'longtext://preview...-0', 'longtext://preview...--1',
    'longtext://preview...-1.5', 'longtext://preview...-03001', 'longtext://preview...-9007199254740992',
    'longtext://' + 'a'.repeat(8192) + '...-3001']) {
    invalidLongText({ ...pastedLongText(), uri });
  }
  const missing = pastedLongText(); delete missing._meta.mentionType; invalidLongText(missing);
  const otherMention = pastedLongText(); otherMention._meta.mentionType = 'file'; invalidLongText(otherMention);
  invalidLongText({ type: 'resource_link', uri: pastedLongText().uri });
});

test('long-text parsing preserves other resource classes and cannot relabel an HTTPS attachment', () => {
  const native = createNativeInputReplay(), blocks = [
    native.homeSceneBlock(),
    native.skillInsert({ id: '/synthetic/SKILL.md', name: 'test', slug: 'test' }),
    native.connectorLink({ rawUrl: 'https://synthetic.invalid/document' }, { id: 'synthetic' }, false),
    { type: 'resource_link', uri: 'https://synthetic.invalid/attachment.pdf', _meta: { fullText: 'not enough' } },
    { type: 'text', text: 'ordinary', uri: pastedLongText().uri, _meta: { mentionType: 'long-text', fullText: 'ordinary' } },
  ];
  for (const block of blocks) assert.equal(parseNativeLongTextBlock(block), null);
  const forged = blocks[3]; forged._meta.mentionType = 'long-text'; invalidLongText(forged);
});

test('long-text byte and UTF-16 limits are independent from its opaque historical reference', () => {
  const block = pastedLongText(), maximum = 1024 * 1024;
  for (const text of ['a'.repeat(maximum), '文'.repeat(Math.floor(maximum / 3)), '📚'.repeat(maximum / 4)]) {
    assert.equal(parseNativeLongTextBlock({ ...block, _meta: { ...block._meta, fullText: text } }).text, text);
  }
  for (const text of ['a'.repeat(maximum + 1), '文'.repeat(Math.floor(maximum / 3) + 1), 'bad\0text', '\ud800', '\udc00', 42, new String('not primitive'), null]) {
    invalidLongText({ ...block, _meta: { ...block._meta, fullText: text } });
  }
});

test('long-text diagnostics retain protocol and kind without exposing fullText or preview text', () => {
  const secret = 'SYNTHETIC_PRIVATE_123';
  const block = pastedLongText(), marker = `${encodeURIComponent(secret)}...`;
  block.uri = `longtext://${marker}-3001`; block._meta.fullText = secret.repeat(300); block._meta.displayText = secret;
  const result = describeNativeInput([block]);
  assert.deepEqual(result.blocks[0], { index: 0, type: 'resource_link', uriScheme: 'longtext:', kind: 'long-text', uriFingerprint: result.blocks[0].uriFingerprint });
  assert.match(result.blocks[0].uriFingerprint, /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_123|fullText|displayText|longtext:\/\//);
  const broken = { ...block, _meta: { ...block._meta, fullText: '\ud800' } };
  assert.equal(describeNativeInput([broken]).blocks[0].kind, 'invalid-long-text');
  assert.doesNotMatch(JSON.stringify(describeNativeInput([broken])), /SYNTHETIC_PRIVATE_123/);
});

test('parsing and describing frozen native long-text blocks does not change their URI or content', () => {
  const block = pastedLongText(), before = structuredClone(block);
  Object.freeze(block._meta); Object.freeze(block);
  parseNativeLongTextBlock(block); describeNativeInput([block]);
  assert.deepEqual(block, before);
});
