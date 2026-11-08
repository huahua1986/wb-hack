import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { zip } from './helpers/document-fixtures.mjs';

const require = createRequire(import.meta.url);
const requireFromEngine = createRequire(new URL('../document-engine/package.json', import.meta.url));
const yauzl = requireFromEngine('yauzl');
const { captureMindAttachments, embedMindAttachments, forgetMindAttachment,
  mindAttachmentResource, rememberMindAttachment } = require('../src/office-mind-attachments.cjs');
const TOOLS = require('../src/office-mind-tools.cjs');
const link = 'https://example.invalid/original';
const port = 45499;
const attachmentBytes = Buffer.from([0, 1, 254, 255, 2, 13, 10]);

function archive(standard, native, extras = {}) {
  return zip({
    'content.json': JSON.stringify([{ rootTopic: standard }]),
    'tdoc-content.json': JSON.stringify({ content: [{ rootTopic: native }] }),
    'manifest.json': JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } }),
    'tdoc-manifest.json': '[]',
    'metadata.json': '{"version":"3.0"}',
    ...extras,
  }, { compressed: true });
}

async function entries(bytes) {
  const reader = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
  const output = new Map();
  await new Promise((resolve, reject) => {
    reader.on('error', reject);
    reader.on('end', resolve);
    reader.on('entry', entry => reader.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      stream.on('error', reject);
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => { output.set(entry.fileName, Buffer.concat(chunks)); reader.readEntry(); });
    }));
    reader.readEntry();
  });
  return output;
}
const parsed = (files, name) => JSON.parse(files.get(name).toString('utf8'));
const owner = { id: 'root', title: 'Existing topic', href: link };
const metadata = { id: 'attachment-id', name: 'fixture.txt', classify: 'doc', objKey: '' };

test('keeps the existing link and writes the attachment bytes with both portable manifests', async () => {
  const source = archive(owner, owner);
  const state = await captureMindAttachments(source);
  const resource = mindAttachmentResource(attachmentBytes, 'fixture.txt', state);
  rememberMindAttachment(state, resource, {
    result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, node_id: owner.id, attachment_id: metadata.id }) }] },
    nodeId: owner.id,
  });
  const native = archive(owner, { ...owner, attachments: [metadata] });
  const files = await entries(await embedMindAttachments(native, state, { port }));
  assert.deepEqual(files.get(resource.path), attachmentBytes);
  assert.equal(files.get('metadata.json').toString(), '{"version":"3.0"}');
  const { rootTopic: standard } = parsed(files, 'content.json')[0];
  assert.equal(standard.href, link);
  const [portableAttachment] = standard.children.attached;
  assert.equal(portableAttachment.title, metadata.name);
  assert.equal(portableAttachment.href, 'xap:' + resource.path);
  const { rootTopic: enriched } = parsed(files, 'tdoc-content.json').content[0];
  assert.equal(enriched.href, link);
  assert.equal(enriched.attachments[0].objKey, resource.path);
  assert.equal(enriched.children.attached[0].href, resource.path);
  assert.deepEqual(parsed(files, 'manifest.json')['file-entries'][resource.path], {});
  assert.deepEqual(parsed(files, 'tdoc-manifest.json'), [{ path: '', placeholder: resource.path, url: resource.path }]);

  const reopened = await captureMindAttachments(await embedMindAttachments(native, state, { port }));
  const sdkUrl = 'http://127.0.0.1:' + port + '/localapi/resources/' + 'a'.repeat(32) + '/' + resource.name;
  const actualChild = { ...portableAttachment, title: 'User changed title', href: sdkUrl };
  const sdkOwner = { ...owner, children: { attached: [actualChild] } };
  const sdkResave = archive(sdkOwner, { ...sdkOwner, attachments: [{ ...metadata, objKey: sdkUrl }] });
  const retained = await entries(await embedMindAttachments(sdkResave, reopened, { port }));
  assert.deepEqual(retained.get(resource.path), attachmentBytes);
  const retainedChild = parsed(retained, 'content.json')[0].rootTopic.children.attached[0];
  assert.equal(retainedChild.href, 'xap:' + resource.path);
  assert.equal(retainedChild.title, 'User changed title');

  forgetMindAttachment(reopened, metadata.id);
  const removed = await entries(await embedMindAttachments(archive(sdkOwner, sdkOwner), reopened, { port }));
  assert.ok(!removed.has(resource.path));
  const root = parsed(removed, 'content.json')[0].rootTopic;
  assert.equal(root.href, link);
  assert.equal(root.children.attached[0].title, 'User changed title');
  assert.ok(!Object.hasOwn(root.children.attached[0], 'href'));
});

test('preserves preexisting standard-only attachments and leaves an unrelated legacy archive unchanged', async () => {
  const name = 'resources/legacy-id.txt';
  const source = zip({
    'content.json': JSON.stringify([{ rootTopic: { ...owner, href: 'xap:' + name } }]),
    [name]: attachmentBytes,
  });
  const state = await captureMindAttachments(source);
  const sdkHref = 'http://127.0.0.1:' + port + '/localapi/resources/' + 'a'.repeat(31) + '/legacy-id.txt';
  const sdkOwner = { ...owner, href: sdkHref, title: 'Unrelated edit' };
  const result = await entries(await embedMindAttachments(archive(sdkOwner, sdkOwner), state, { port }));
  assert.deepEqual(result.get(name), attachmentBytes);
  assert.equal(parsed(result, 'content.json')[0].rootTopic.href, 'xap:' + name);
  assert.equal(parsed(result, 'content.json')[0].rootTopic.title, 'Unrelated edit');

  const legacy = zip({ 'content.xml': '<xmap-content/>' });
  const saved = archive(owner, owner);
  assert.equal(await embedMindAttachments(saved, await captureMindAttachments(legacy), { port }), saved);
});

test('requires a local path and refuses to save when the SDK loses a confirmed attachment', async () => {
  const policy = TOOLS.get('mind_add_node_attachment');
  assert.deepEqual(policy.omit, ['url', 'obj_key']);
  assert.deepEqual(policy.required, ['filename']);
  assert.ok(policy.validate({ filename: '/workspace/fixture.txt' }));
  assert.ok(!policy.validate({ name: 'fixture.txt' }));
  const staged = archive(owner, owner);
  const state = await captureMindAttachments(staged);
  const resource = mindAttachmentResource(attachmentBytes, 'fixture.txt', state);
  rememberMindAttachment(state, resource, { result: { structuredContent: { ok: true, node_id: owner.id, attachment_id: metadata.id } }, nodeId: owner.id });
  await assert.rejects(embedMindAttachments(staged, state, { port }), { code: 'NATIVE_OFFICE_MIND_ATTACHMENT_RESULT_INVALID' });
});
