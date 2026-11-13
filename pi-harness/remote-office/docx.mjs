import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { SaxesParser } from 'saxes';
import yauzl from 'yauzl';
import yazl from 'yazl';

const crc32 = createRequire(import.meta.url)('yauzl/crc32.js');
const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MAX_EXPANDED = 32 * 1024 * 1024;
export const MAX_DOCX_BYTES = 8 * 1024 * 1024;
export const MAX_FILES_PER_KIND = 8;
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function docxError(code, status = 422) {
  return Object.assign(new Error(code), { code, status });
}

export function isDocxName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,91}\.docx$/i.test(name)
    && !name.includes('..');
}

export function fileDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function docxDirectory(workspace, kind) {
  if (kind !== 'input' && kind !== 'output') throw TypeError('Invalid Office file kind');
  const expected = join(workspace, 'office-files');
  const directory = join(expected, kind);
  for (const candidate of [workspace, expected, directory]) {
    if (candidate !== workspace) await mkdir(candidate, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    const info = await lstat(candidate);
    if (!info.isDirectory() || (info.mode & 0o077) || await realpath(candidate) !== candidate) {
      throw docxError('OFFICE_WORKSPACE_INVALID', 409);
    }
  }
  return directory;
}

export async function readDocxFile(directory, name) {
  if (!isDocxName(name)) throw docxError('OFFICE_FILE_NAME_INVALID', 400);
  const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    if (error.code === 'ENOENT') throw docxError('OFFICE_FILE_NOT_FOUND', 404);
    if (error.code === 'ELOOP') throw docxError('OFFICE_FILE_INVALID');
    throw error;
  });
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_DOCX_BYTES) {
      throw docxError('OFFICE_FILE_INVALID');
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw docxError('OFFICE_FILE_CHANGED', 409);
      offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw docxError('OFFICE_FILE_CHANGED', 409);
    }
    return bytes;
  } finally {
    await file.close();
  }
}

export async function publishDocxFile(directory, name, bytes) {
  if (!isDocxName(name)) throw docxError('OFFICE_FILE_NAME_INVALID', 400);
  const temporary = join(directory, '.pending-' + randomUUID());
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try {
      await link(temporary, join(directory, name));
    } catch (error) {
      if (error.code === 'EEXIST') throw docxError('OFFICE_FILE_EXISTS', 409);
      throw error;
    }
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function parseXml(bytes, register) {
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => { throw docxError('OFFICE_DOCX_UNSAFE'); });
  parser.on('error', () => { throw docxError('OFFICE_DOCX_INVALID'); });
  register(parser, xml);
  parser.write(xml).close();
  return xml;
}

function verifyPackage(entries) {
  const content = entries.get('[Content_Types].xml');
  const relationship = entries.get('_rels/.rels');
  const document = entries.get('word/document.xml');
  if (!content || !relationship || !document) throw docxError('OFFICE_DOCX_INVALID');
  let mainType = false;
  let mainPart = false;
  let root = false;
  parseXml(content, parser => parser.on('opentag', tag => {
    if (tag.uri === TYPES && tag.local === 'Override' && tag.attributes.PartName?.value === '/word/document.xml') {
      mainType ||= tag.attributes.ContentType?.value === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
    }
  }));
  for (const [name, bytes] of entries) {
    if (!name.endsWith('.rels')) continue;
    parseXml(bytes, parser => parser.on('opentag', tag => {
      if (tag.uri !== RELS || tag.local !== 'Relationship') return;
      const target = tag.attributes.Target?.value ?? '';
      if (tag.attributes.TargetMode?.value === 'External' || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) {
        throw docxError('OFFICE_DOCX_EXTERNAL_LINK');
      }
      if (name === '_rels/.rels' && tag.attributes.Type?.value?.endsWith('/officeDocument') && target === 'word/document.xml') {
        mainPart = true;
      }
    }));
  }
  parseXml(document, parser => {
    let first = true;
    parser.on('opentag', tag => {
      if (!first) return;
      first = false;
      root = tag.uri === WORD && tag.local === 'document';
    });
  });
  if (!mainType || !mainPart || !root) throw docxError('OFFICE_DOCX_INVALID');
}

export async function validateDocx(bytes) {
  if (bytes.length < 4 || bytes.length > MAX_DOCX_BYTES || bytes.readUInt32LE(0) !== 0x04034b50) {
    throw docxError('OFFICE_DOCX_INVALID');
  }
  const entries = new Map();
  const names = new Set();
  try {
    const zip = await yauzl.fromBufferPromise(bytes, { strictFileNames: true, validateEntrySizes: true });
    try {
      if (zip.entryCount > 1024) throw docxError('OFFICE_DOCX_TOO_LARGE', 413);
      let expanded = 0;
      for await (const entry of zip.eachEntry()) {
        const name = entry.fileName;
        const normalized = name.toLowerCase();
        const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (names.has(normalized) || !/^[a-zA-Z0-9_.\[\] -]+(?:\/[a-zA-Z0-9_.\[\] -]+)*\/?$/.test(name)
          || name.split('/').some(part => part === '.' || part === '..') || entry.isEncrypted() || unixType === 0xa000
          || /(?:^|\/)(?:embeddings|activex|_xmlsignatures)(?:\/|$)|vbaProject\.bin$/i.test(name)) {
          throw docxError('OFFICE_DOCX_UNSAFE');
        }
        names.add(normalized);
        if (name.endsWith('/')) continue;
        expanded += entry.uncompressedSize;
        if (entry.uncompressedSize > MAX_DOCX_BYTES || expanded > MAX_EXPANDED) {
          throw docxError('OFFICE_DOCX_TOO_LARGE', 413);
        }
        const chunks = [];
        let size = 0;
        const stream = await zip.openReadStreamPromise(entry);
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > entry.uncompressedSize) throw docxError('OFFICE_DOCX_INVALID');
          chunks.push(chunk);
        }
        const data = Buffer.concat(chunks);
        if (size !== entry.uncompressedSize || crc32(data) !== entry.crc32) throw docxError('OFFICE_DOCX_INVALID');
        entries.set(name, data);
      }
    } finally {
      zip.close();
    }
    verifyPackage(entries);
    return entries;
  } catch (error) {
    if (error.code?.startsWith('OFFICE_')) throw error;
    throw docxError('OFFICE_DOCX_INVALID');
  }
}

/** Edit one text run and copy the remaining archive parts without content changes. */
export async function replaceDocxText(bytes, find, replacement) {
  if (typeof find !== 'string' || find.length < 1 || find.length > 2000 || typeof replacement !== 'string'
    || replacement.length > 2000 || /[\x00-\x1f\x7f]/.test(find + replacement) || find === replacement) {
    throw docxError('OFFICE_TEXT_ARGUMENT_INVALID', 400);
  }
  const entries = await validateDocx(bytes);
  const main = entries.get('word/document.xml');
  let run, bodyDepth = 0, match, matches = 0;
  const xml = parseXml(main, (parser, source) => {
    parser.on('opentag', tag => {
      if (tag.uri !== WORD) return;
      if (tag.local === 'body') bodyDepth++;
      if (bodyDepth > 0 && tag.local === 't' && !tag.isSelfClosing) run = { start: parser.position, text: '' };
    });
    parser.on('text', text => { if (run) run.text += text; });
    parser.on('cdata', text => { if (run) run.text += text; });
    parser.on('closetag', tag => {
      if (tag.uri !== WORD) return;
      if (tag.local === 'body') bodyDepth--;
      if (tag.local !== 't' || !run) return;
      const index = run.text.indexOf(find);
      if (index !== -1) {
        matches += run.text.indexOf(find, index + 1) === -1 ? 1 : 2;
        const end = source.lastIndexOf('</', parser.position - 1);
        if (end < run.start) throw docxError('OFFICE_DOCX_INVALID');
        match = { start: run.start, end, value: run.text.slice(0, index) + replacement + run.text.slice(index + find.length) };
      }
      run = undefined;
    });
  });
  if (matches !== 1) throw docxError(matches ? 'OFFICE_TEXT_AMBIGUOUS' : 'OFFICE_TEXT_NOT_FOUND', 409);
  const safe = match.value.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
  entries.set('word/document.xml', Buffer.from(xml.slice(0, match.start) + safe + xml.slice(match.end)));
  const zip = new yazl.ZipFile();
  const chunks = [];
  let size = 0;
  for (const [name, data] of entries) zip.addBuffer(data, name);
  zip.end();
  for await (const chunk of zip.outputStream) {
    size += chunk.length;
    if (size > MAX_DOCX_BYTES) throw docxError('OFFICE_DOCX_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  const output = Buffer.concat(chunks);
  await validateDocx(output);
  return output;
}
