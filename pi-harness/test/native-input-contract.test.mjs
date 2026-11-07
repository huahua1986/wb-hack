import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectAsar } from '../package-dmg/asar.mjs';
import { createNativeInputReplay, nativeInputFixture as fixture } from './fixtures/native-input-592.replay.mjs';

test('native input fixture pins exact WorkBuddy 5.9.2 producers and consumers', () => {
  assert.equal(fixture.artifactSHA256, '0b79c0358c129749bc3355f52bbae13f115577ab37c082a76dfdc54f66fd3f79');
  for (const slice of fixture.slices) {
    assert.equal(createHash('sha256').update(slice.source).digest('hex'), slice.sha256);
    assert.equal(Buffer.byteLength(slice.source), slice.range.end - slice.range.start);
  }
});

test('actual built-in Wecom home scene implicitly precedes synthetic text with a non-file scene resource', () => {
  const native = createNativeInputReplay(), text = { type: 'text', text: 'Synthetic meeting outline. Do not call any connector.' };
  const scene = native.wecomScene(), blocks = native.homeBlocks([text]);
  assert.equal(scene.id, 122844); assert.equal(scene.name, '企业微信'); assert.equal(scene.insertSceneTag, undefined);
  assert.equal(blocks.length, 2); assert.equal(blocks[1], text);
  const block = blocks[0]; assert.equal(block.type, 'resource_link'); assert.equal(block.uri, 'scene://122844'); assert.equal(block.name, '企业微信');
  assert.equal(block._meta.type, 'scene'); assert.equal(block._meta.mentionType, 'scene'); assert.equal(block._meta.sceneId, '122844');
  assert.equal(block._meta.displayText, '企业微信'); assert.equal(block._meta.displayAsPhrase, true); assert.equal(block._meta.displayAsContext, false);
  assert.equal(block.mimeType, undefined); assert.equal(block._meta.filePath, undefined); assert.equal(block._meta.size, undefined);
  assert.equal(native.isScene(block), true); assert.equal(native.sceneId(blocks), '122844');
  const original = [text]; assert.equal(native.homeBlocks(original, { ...scene, insertSceneTag: false }), original);
});

test('native scene action replaces old scene chips and preserves synthetic text/file input when appending', () => {
  const native = createNativeInputReplay(), old = native.homeSceneBlock({ id: 3, name: 'Old scene' });
  const file = native.fileMention({ id: 'note.md', label: 'note.md', metadata: { type: 'file', filePath: '/synthetic/note.md', relativePath: 'note.md' } });
  const result = native.applyScene([old, file, { type: 'text', text: 'existing' }], native.wecomScene(), 'synthetic appendix', 0, { appendPrompt: true });
  assert.equal(result[0].uri, 'scene://122844'); assert.equal(result[1], file); assert.equal(result[2].text, 'existing\nsynthetic appendix');
  assert.equal(result.filter(native.isScene).length, 1);
});

test('skill construction has skill URI and command URI forms with semantic skill metadata', () => {
  const native = createNativeInputReplay(), auto = native.skillBlock({ skillName: 'synthetic-notes', autoAttached: true });
  assert.equal(auto.uri, 'skill://synthetic-notes'); assert.equal(auto._meta.mentionType, 'skill'); assert.equal(auto._meta.autoAttached, true);
  const slash = native.skillInsert({ id: '/synthetic/skills/notes/SKILL.md', name: 'notes', displayName: 'Synthetic Notes', slug: 'synthetic-notes' });
  assert.equal(slash.uri, 'command://synthetic-notes'); assert.equal(slash._meta.mentionType, 'skill'); assert.equal(slash._meta.type, 'skill');
  assert.equal(slash._meta.skillId, '/synthetic/skills/notes/SKILL.md'); assert.equal(slash._meta.isCommand, true);
  const commandSkill = native.slashCommand({ name: 'notes', category: 'skill', metadata: { skillId: '/synthetic/notes/SKILL.md' } });
  assert.equal(commandSkill.uri, 'command://notes'); assert.equal(commandSkill._meta.mentionType, 'skill');
});

test('ordinary slash command and local file/folder mention producers retain distinct native metadata', () => {
  const native = createNativeInputReplay(), command = native.slashCommand({ name: 'compact', category: 'command' });
  assert.equal(command.uri, 'command://compact'); assert.equal(command._meta.mentionType, 'command'); assert.equal(command._meta.isCommand, true);
  assert.equal(command._meta.commandName, 'compact'); assert.equal(command._meta.trigger, '/');
  for (const type of ['file', 'folder']) {
    const block = native.fileMention({ id: 'notes', label: 'notes', metadata: { type, filePath: '/synthetic/notes', relativePath: 'notes' } });
    assert.equal(block.uri, 'notes'); assert.equal(block._meta.filePath, '/synthetic/notes'); assert.equal(block._meta.type, type);
    assert.equal(block._meta.mentionType, type); assert.equal(block._meta.trigger, '@');
  }
});

test('connector-link producer uses the real business URL and explicit pending/resolved authorization metadata', () => {
  const native = createNativeInputReplay(), url = 'https://synthetic.invalid/document/1', provider = { id: 'synthetic-docs', connectorId: 'synthetic-connector' };
  const pending = native.connectorLink({ rawUrl: url }, provider, false), authorized = native.connectorLink({ rawUrl: url }, provider, true);
  assert.equal(pending.uri, url); assert.equal(pending._meta.kind, 'connector-link-pending-auth'); assert.equal(pending._meta.connectorId, 'synthetic-connector');
  assert.equal(pending._meta.providerId, 'synthetic-docs'); assert.equal(pending._meta.rawUrl, url); assert.equal(pending._meta.linkResolveState, 'idle');
  assert.equal(authorized._meta.kind, 'connector-link-resolved');
  const direct = native.connectorLink({ rawUrl: url }, { ...provider, authorization: 'none' }, false);
  assert.equal(direct._meta.kind, 'connector-link-resolved'); assert.equal(direct._meta.connectorId, undefined);
  const resolved = native.completeConnectorLink(authorized, url, { title: 'Synthetic resolved link', canonicalUrl: 'file:///synthetic/forbidden', metadata: { providerId: 'forged', rawUrl: 'forged' } });
  assert.equal(resolved.uri, url); assert.equal(resolved._meta.providerId, 'synthetic-docs'); assert.equal(resolved._meta.rawUrl, url);
  assert.equal(resolved._meta.linkResolveState, 'resolved');
});

test('connector adopted ID is a recommendation key, and does not by itself establish a resource-link payload ABI', () => {
  const native = createNativeInputReplay();
  assert.equal(native.connectorCandidateMatches({ kind: 'connector', connectorId: 'synthetic' }, ['connector://synthetic']), true);
  assert.equal(native.connectorCandidateMatches({ kind: 'connector', connectorId: 'synthetic' }, ['synthetic']), false);
});

test('Slate BOM markers are editor zero-width text, not evidence of an attachment resource type', () => {
  const native = createNativeInputReplay(), first = native.zeroWidth({}), second = native.zeroWidth({});
  assert.equal(first.type, 'span'); assert.equal(first.props['data-slate-zero-width'], 'z'); assert.equal(first.children[0], '\uFEFF');
  assert.equal(first.children[0] + second.children[0], '\uFEFF\uFEFF');
  const text = { type: 'text', text: '\uFEFF\uFEFFsynthetic text' }, blocks = native.homeBlocks([text]);
  assert.equal(blocks[1], text); assert.equal(blocks[1].text, text.text);
});

test('direct plain-text paste creates a longtext resource only above the native 3000-grapheme threshold', () => {
  const native = createNativeInputReplay(), atLimit = '合'.repeat(3000), overLimit = atLimit + '\r\nSYNTHETIC-END';
  const short = native.paste({ text: atLimit }); assert.equal(short.blocks.length, 0); assert.equal(short.plainText, atLimit);
  const pasted = native.paste({ text: overLimit }), block = pasted.blocks[0]; assert.equal(pasted.blocks.length, 1); assert.equal(pasted.plainText, '');
  assert.equal(block.type, 'resource_link'); assert.match(block.uri, /^longtext:\/\//);
  assert.equal(block._meta.mentionType, 'long-text'); assert.equal(block._meta.fullText, overLimit.replace(/\r\n/g, '\n'));
  assert.equal(native.longTextContent(block), overLimit.replace(/\r\n/g, '\n')); assert.ok(block._meta.fullText.endsWith('SYNTHETIC-END'));
  assert.equal(block._meta.displayText, '合'.repeat(10) + '...'); assert.equal(block.mimeType, undefined); assert.equal(native.isAttachment(block), false);
});

test('longtext length and preview use graphemes rather than UTF-16; its consumer reads fullText without URI reconstruction', () => {
  const native = createNativeInputReplay(), cluster = 'e\u0301', text = cluster.repeat(3001), block = native.paste({ text }).blocks[0];
  assert.equal(text.length, 6002); assert.equal(native.inputLength(text), 3001); assert.ok(block.uri.endsWith('-3001'));
  assert.equal(block._meta.displayText, cluster.repeat(10) + '...'); assert.equal(native.longTextContent(block), text);
  const staleUri = { ...block, _meta: { ...block._meta, fullText: 'edited\r\nSYNTHETIC' } };
  assert.equal(native.longTextContent(staleUri), 'edited\nSYNTHETIC');
  const zeroWidth = '\u200B'.repeat(10) + 'x'.repeat(3000), pasted = native.paste({ text: zeroWidth });
  assert.equal(native.inputLength(zeroWidth), 3000); assert.equal(pasted.blocks.length, 0); assert.equal(pasted.plainText, zeroWidth);
});

test('plain short @names stay text, and disabling longtext chips or applying maxLength does not create a resource', () => {
  const native = createNativeInputReplay(), mentions = '请提醒@合成甲和@合成乙参与合成事项。';
  const short = native.paste({ text: mentions }); assert.equal(short.blocks.length, 0); assert.equal(short.plainText, mentions);
  const text = '合'.repeat(3001), disabled = native.paste({ text, enableLongTextPasteChip: false });
  assert.equal(disabled.blocks.length, 0); assert.equal(disabled.plainText, text);
  const truncated = native.paste({ text, maxLength: 2500 }); assert.equal(truncated.blocks.length, 0); assert.equal(native.inputLength(truncated.plainText), 2500);
});

test('native custom clipboard MIME and data-contentblock HTML preserve URI/meta before plain text fallback', () => {
  const native = createNativeInputReplay(), block = { type: 'resource_link', name: 'Synthetic copied control', uri: 'synthetic-unknown://stable', _meta: { kind: 'synthetic-test', value: 1 } };
  const custom = native.paste({ text: 'visible plain text', blocks: [block] });
  assert.equal(custom.blocks.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(custom.blocks[0])), block); assert.equal(custom.plainText, '');
  assert.deepEqual(custom.clipboardReads, ['application/x-cb-chat-contentblocks']);
  // Controlled DOM nodes replay the original JSON extractor, not browser HTML sanitization.
  const html = native.paste({ text: 'visible plain text', htmlBlocks: [block] });
  assert.deepEqual(JSON.parse(JSON.stringify(html.blocks[0])), block); assert.equal(html.plainText, '');
});

test('default Home mode alone selects no scene or skill; restore/prepared contexts must explicitly carry them', () => {
  const native = createNativeInputReplay(), restore = native.planBuddyRestore({ consumeKey: 'synthetic', modeIds: ['work', 'code'], defaultMode: 'work',
    snapshot: null, scenesForMode: () => [native.wecomScene()] });
  assert.equal(restore.status, 'apply'); assert.equal(restore.modeId, 'work'); assert.equal(restore.scene, undefined); assert.equal(restore.prefill.kind, 'reset');
  const prepared = native.preparedInput({}); assert.equal(prepared.blocks.length, 0); assert.equal(prepared.expert, null);
  const prompt = native.preparedInput({ expert: { defaultInitPrompt: 'Synthetic expert prompt' } });
  assert.equal(prompt.blocks.length, 1); assert.equal(prompt.blocks[0].type, 'text');
  const skill = native.preparedInput({ skill: { name: 'synthetic-skill' } }); assert.equal(skill.blocks[0].uri, 'skill://synthetic-skill');
  const restored = native.planBuddyRestore({ consumeKey: 'synthetic', modeIds: ['work'], defaultMode: 'work',
    snapshot: { modeId: 'work', sceneId: 122844, blocks: [] }, scenesForMode: () => [native.wecomScene()] });
  assert.equal(restored.scene.id, 122844);
  assert.equal(fixture.slices.find(slice => slice.name === 'homeSelectedSceneInitialization').source, '[y,b]=(0,q.useState)()');
});

test('native attachment predicate keeps controls separate from upload metadata and local mentions', () => {
  const native = createNativeInputReplay();
  for (const block of [native.homeSceneBlock(), native.skillBlock({ skillName: 'synthetic' }), native.paste({ text: 'x'.repeat(3001) }).blocks[0],
    native.fileMention({ id: 'note.md', label: 'note.md', metadata: { type: 'file', filePath: '/synthetic/note.md' } })]) assert.equal(native.isAttachment(block), false);
  for (const values of [{ mimeType: 'text/plain' }, { _meta: { originalFilename: 'synthetic.txt' } }, { _meta: { blockStatus: 'completed' } }]) {
    assert.equal(native.isAttachment({ type: 'resource_link', uri: 'https://synthetic.invalid/file', ...values }), true);
  }
});

test('every native input source slice matches the fixed original ASAR byte for byte', { skip: !process.env.NATIVE_PREVIEW_TEST_ASAR }, () => {
  const archive = inspectAsar(process.env.NATIVE_PREVIEW_TEST_ASAR);
  for (const slice of fixture.slices) {
    const bytes = archive.read(slice.member); assert.equal(createHash('sha256').update(bytes).digest('hex'), slice.memberSHA256);
    assert.deepEqual(bytes.subarray(slice.range.start, slice.range.end), Buffer.from(slice.source));
  }
});
