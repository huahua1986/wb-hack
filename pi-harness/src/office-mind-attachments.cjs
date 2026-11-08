'use strict';
const { createHash } = require('node:crypto');
const { existsSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { promisify } = require('node:util');
const { deflateRaw } = require('node:zlib');

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED = 64 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_ATTACHMENTS = 128;
const RESOURCE = /^resources\/[A-Za-z0-9_.-]{1,240}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const compress = promisify(deflateRaw);

function failure(reason = 'MIND_ATTACHMENT_ARCHIVE_INVALID', status = 422) {
  const code = 'NATIVE_OFFICE_' + reason;
  return Object.assign(new Error(code), { code, status });
}

function archiveDependencies() {
  const bundled = path.resolve(__dirname, '../../DocumentEngine');
  const root = existsSync(path.join(bundled, 'package-lock.json')) ? bundled : path.resolve(__dirname, '../document-engine');
  const requireFromEngine = createRequire(path.join(root, 'package.json'));
  try {
    return { yauzl: requireFromEngine('yauzl'), crc32: requireFromEngine('./node_modules/yauzl/crc32.js') };
  } catch { throw failure('MIND_ATTACHMENT_ARCHIVE_UNAVAILABLE', 503); }
}

async function readArchive(bytes, { yauzl, crc32 }) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) throw failure();
  try {
    const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, {
      lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false,
    }, (error, result) => error ? reject(error) : resolve(result)));
    try {
      if (zip.entryCount > MAX_ENTRIES) throw failure();
      const entries = new Map();
      let expanded = 0;
      await new Promise((resolve, reject) => {
        zip.on('error', reject);
        zip.on('end', resolve);
        zip.on('entry', entry => {
          const { fileName, uncompressedSize } = entry;
          if (!fileName || /[\x00-\x1f\x7f]/.test(fileName) || entries.has(fileName) ||
              uncompressedSize > MAX_FILE_BYTES || expanded + uncompressedSize > MAX_ARCHIVE_EXPANDED) return reject(failure());
          expanded += uncompressedSize;
          entries.set(fileName, entry);
          zip.readEntry();
        });
        zip.readEntry();
      });
      const files = new Map();
      for (const [name, entry] of entries) {
        const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > entry.uncompressedSize) { stream.destroy(); throw failure(); }
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        if (size !== entry.uncompressedSize || crc32(buffer) !== entry.crc32) throw failure();
        files.set(name, buffer);
      }
      return files;
    } finally { zip.close(); }
  } catch { throw failure(); }
}

// The staged SDK archive is private. Rebuild its ZIP with only the verified entries and new resources.
async function writeArchive(files, crc32) {
  if (files.size > MAX_ENTRIES) throw failure('MIND_ATTACHMENT_LIMIT', 413);
  const localParts = [], directory = [];
  let offset = 0, directorySize = 0, expanded = 0;
  for (const [name, bytes] of files) {
    const encodedName = Buffer.from(name);
    expanded += bytes.length;
    if (expanded > MAX_ARCHIVE_EXPANDED || encodedName.length > 0xffff) throw failure('MIND_ATTACHMENT_LIMIT', 413);
    const compressed = await compress(bytes);
    const packed = compressed.length < bytes.length ? compressed : bytes;
    const method = packed === bytes ? 0 : 8;
    const crc = crc32(bytes);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(33, 12); // DOS date 1980-01-01.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(encodedName.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4, 28);
    if (name.endsWith('/')) central.writeUInt32LE(0x10, 38);
    central.writeUInt32LE(offset, 42);
    offset += local.length + encodedName.length + packed.length;
    directorySize += central.length + encodedName.length;
    if (offset + directorySize + 22 > MAX_FILE_BYTES) throw failure('MIND_ATTACHMENT_LIMIT', 413);
    localParts.push(local, encodedName, packed);
    directory.push(central, encodedName);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...directory, end]);
}

function json(files, name, required = true) {
  const bytes = files.get(name);
  if (!bytes && !required) return undefined;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw failure(); }
}

function topics(sheets) {
  if (!Array.isArray(sheets)) throw failure();
  const pending = sheets.map(sheet => sheet?.rootTopic).filter(object);
  const nodes = [];
  while (pending.length) {
    const node = pending.pop();
    nodes.push(node);
    if (nodes.length > 100_000) throw failure();
    for (const siblings of Object.values(node.children ?? {})) {
      if (Array.isArray(siblings)) for (const child of siblings) if (object(child)) pending.push(child);
    }
  }
  return nodes;
}

function attachmentPath(value) {
  if (typeof value !== 'string') return null;
  const resource = value.startsWith('xap:') ? value.slice(4) : value;
  return RESOURCE.test(resource) && !resource.endsWith('/.') && !resource.endsWith('/..') ? resource : null;
}
function attachments(node) {
  return Array.isArray(node.attachments) ? node.attachments.filter(object) : [];
}
function checkLimits(state, added = 0) {
  let size = added;
  for (const bytes of state.resources.values()) size += bytes.length;
  if (state.resources.size > MAX_ATTACHMENTS || state.bindings.size > MAX_ATTACHMENTS || size > MAX_FILE_BYTES) {
    throw failure('MIND_ATTACHMENT_LIMIT', 413);
  }
}

async function captureMindAttachments(bytes) {
  const state = { resources: new Map(), bindings: new Map() };
  if (!bytes) return state;
  const files = await readArchive(bytes, archiveDependencies());
  const standard = json(files, 'content.json', false), native = json(files, 'tdoc-content.json', false);
  for (const node of [...topics(standard ?? []), ...topics(native?.content ?? [])]) {
    const href = attachmentPath(node.href);
    if (href && files.has(href)) state.resources.set(href, files.get(href));
    for (const entry of attachments(node)) {
      const resource = attachmentPath(entry.objKey);
      if (!resource || !files.has(resource) || typeof entry.id !== 'string' || typeof node.id !== 'string') continue;
      state.resources.set(resource, files.get(resource));
      state.bindings.set(entry.id, { nodeId: node.id, resource, pending: false });
    }
  }
  checkLimits(state);
  return state;
}

function mindAttachmentResource(bytes, originalName, state) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_FILE_BYTES || typeof originalName !== 'string') {
    throw failure('MIND_ATTACHMENT_LIMIT', 413);
  }
  const originalExtension = path.extname(originalName).toLowerCase().slice(1);
  const extension = /^[a-z0-9]{1,10}$/.test(originalExtension) ? originalExtension : 'bin';
  const name = 'pi-attachment-' + digest(bytes) + '.' + extension;
  const resource = { path: 'resources/' + name, name, bytes };
  if (state) {
    if (state.bindings.size >= MAX_ATTACHMENTS || (!state.resources.has(resource.path) && state.resources.size >= MAX_ATTACHMENTS)) {
      throw failure('MIND_ATTACHMENT_LIMIT', 413);
    }
    checkLimits(state, state.resources.has(resource.path) ? 0 : bytes.length);
  }
  return resource;
}

function rememberMindAttachment(state, resource, { result, nodeId }) {
  let saved;
  try { saved = result.structuredContent ?? JSON.parse(result.content?.[0]?.text); }
  catch { throw failure('MIND_ATTACHMENT_RESULT_INVALID', 502); }
  if (saved?.ok !== true || saved.node_id !== nodeId || typeof saved.attachment_id !== 'string' ||
      !saved.attachment_id || saved.attachment_id.length > 256 || state.bindings.has(saved.attachment_id)) {
    throw failure('MIND_ATTACHMENT_RESULT_INVALID', 502);
  }
  state.resources.set(resource.path, resource.bytes);
  state.bindings.set(saved.attachment_id, { nodeId, resource: resource.path, pending: true });
  checkLimits(state);
}

function forgetMindAttachment(state, attachmentId) {
  const binding = state?.bindings.get(attachmentId);
  if (binding) binding.removed = true;
}

function currentResource(value, port) {
  const direct = attachmentPath(value);
  if (direct || typeof value !== 'string') return direct;
  const prefix = `http://127.0.0.1:${port}/localapi/resources/`;
  if (!value.startsWith(prefix)) return null;
  const [key, name, ...rest] = value.slice(prefix.length).split('/');
  return /^[a-f0-9]{24,32}$/.test(key) && name && rest.length === 0 ? attachmentPath('resources/' + name) : null;
}

function uniqueNode(nodes, id) {
  const found = nodes.filter(node => node.id === id);
  if (found.length !== 1) throw failure();
  return found[0];
}

function childId(id) { return digest('pi-xmind-attachment:' + id).slice(0, 24); }

function setPortableLink(node, id, resource, title, port, standard) {
  const href = standard ? 'xap:' + resource : resource;
  if (!node.href || currentResource(node.href, port) === resource) {
    node.href = href;
    return;
  }
  node.children ??= {};
  node.children.attached ??= [];
  const child = node.children.attached.find(topic => topic?.id === childId(id));
  if (child) {
    if (currentResource(child.href, port) !== resource) throw failure();
    child.href = href;
  } else node.children.attached.push({ ...(standard ? { class: 'topic' } : {}), id: childId(id), title, href });
}

async function embedMindAttachments(savedBytes, state, { port } = {}) {
  if (!state?.resources.size) return savedBytes;
  checkLimits(state);
  const dependencies = archiveDependencies();
  const files = await readArchive(savedBytes, dependencies);
  const standard = json(files, 'content.json'), native = json(files, 'tdoc-content.json');
  const standardNodes = topics(standard), nativeNodes = topics(native?.content);
  const managed = new Set();
  for (const [id, { nodeId, resource, pending, removed }] of state.bindings) {
    managed.add(resource);
    const owner = nativeNodes.find(node => node.id === nodeId);
    const matching = attachments(owner ?? {}).filter(item => item.id === id);
    if (matching.length > 1 || (removed && matching.length) || (pending && !removed && owner && !matching.length)) {
      throw failure('MIND_ATTACHMENT_RESULT_INVALID', 502);
    }
    if (!matching.length) {
      // A deleted attachment no longer owns its old portable link. Keep any unrelated edit to that topic.
      for (const node of [...standardNodes, ...nativeNodes]) {
        if ((node.id === nodeId || node.id === childId(id)) && currentResource(node.href, port) === resource) delete node.href;
      }
      continue;
    }
    const [attachment] = matching;
    attachment.objKey = resource;
    if (!pending) continue;
    const title = typeof attachment.name === 'string' && attachment.name ? attachment.name : path.basename(resource);
    setPortableLink(uniqueNode(standardNodes, nodeId), id, resource, title, port, true);
    setPortableLink(uniqueNode(nativeNodes, nodeId), id, resource, title, port, false);
  }

  const used = new Set();
  for (const [nodes, portable] of [[topics(standard), true], [topics(native.content), false]]) {
    for (const node of nodes) {
      const href = currentResource(node.href, port);
      if (state.resources.has(href)) { node.href = (portable ? 'xap:' : '') + href; used.add(href); }
      for (const item of attachments(node)) {
        const resource = currentResource(item.objKey, port);
        if (state.resources.has(resource)) { item.objKey = resource; used.add(resource); }
      }
      const images = Array.isArray(node.images) ? node.images.map(image => image?.url) : [node.image?.src];
      for (const image of images) {
        const resource = currentResource(image, port);
        if (state.resources.has(resource)) used.add(resource);
      }
    }
  }

  const manifest = json(files, 'manifest.json');
  let nativeManifest = json(files, 'tdoc-manifest.json');
  if (!object(manifest?.['file-entries']) || !Array.isArray(nativeManifest)) throw failure();
  for (const [resource, bytes] of state.resources) {
    if (!used.has(resource)) {
      if (managed.has(resource)) {
        files.delete(resource);
        delete manifest['file-entries'][resource];
        nativeManifest = nativeManifest.filter(entry => entry?.placeholder !== resource);
      }
      continue;
    }
    if (files.has(resource) && !files.get(resource).equals(bytes)) throw failure();
    files.set(resource, bytes);
    manifest['file-entries'][resource] ??= {};
    if (!nativeManifest.some(entry => entry?.placeholder === resource)) nativeManifest.push({ path: '', placeholder: resource, url: resource });
  }
  files.set('content.json', Buffer.from(JSON.stringify(standard)));
  files.set('tdoc-content.json', Buffer.from(JSON.stringify(native)));
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  files.set('tdoc-manifest.json', Buffer.from(JSON.stringify(nativeManifest)));
  return writeArchive(files, dependencies.crc32);
}

module.exports = { captureMindAttachments, mindAttachmentResource, rememberMindAttachment, forgetMindAttachment, embedMindAttachments };
