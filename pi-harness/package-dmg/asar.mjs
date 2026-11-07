import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_BLOCK_SIZE = 4 * 1024 * 1024;
const MAX_HEADER_SIZE = 64 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const own = (object, key) => Object.hasOwn(object, key);
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function memberPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') ||
      value.startsWith('/') || /^[A-Za-z]:/.test(value) ||
      value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe ASAR member path: ${JSON.stringify(value)}`);
  }
  return value;
}

function readExactly(fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const length = fs.readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (!length) throw new Error('Truncated ASAR archive');
    offset += length;
  }
}

function writeExactly(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
}

function integrityForBuffer(data, blockSize = DEFAULT_BLOCK_SIZE) {
  const blocks = [];
  for (let offset = 0; offset < data.length; offset += blockSize) {
    blocks.push(sha256(data.subarray(offset, offset + blockSize)));
  }
  if (!blocks.length) blocks.push(sha256(Buffer.alloc(0)));
  return { algorithm: 'SHA256', hash: sha256(data), blockSize, blocks };
}

function sameIntegrity(left, right) {
  return left.algorithm === right.algorithm && left.hash === right.hash && left.blockSize === right.blockSize &&
    left.blocks.length === right.blocks.length && left.blocks.every((hash, index) => hash === right.blocks[index]);
}

function streamedIntegrity(blockSize = DEFAULT_BLOCK_SIZE) {
  const fileHash = crypto.createHash('sha256');
  let blockHash = crypto.createHash('sha256'), length = 0;
  const blocks = [];
  return {
    update(chunk) {
      fileHash.update(chunk);
      for (let offset = 0; offset < chunk.length;) {
        const end = Math.min(offset + blockSize - length, chunk.length);
        blockHash.update(chunk.subarray(offset, end));
        length += end - offset;
        if (length === blockSize) { blocks.push(blockHash.digest('hex')); blockHash = crypto.createHash('sha256'); length = 0; }
        offset = end;
      }
    },
    digest() {
      if (length || !blocks.length) blocks.push(blockHash.digest('hex'));
      return { algorithm: 'SHA256', hash: fileHash.digest('hex'), blockSize, blocks };
    },
  };
}

function validateIntegrity(value, size, name) {
  if (!value || value.algorithm !== 'SHA256' || !SHA256.test(value.hash) ||
      !Number.isSafeInteger(value.blockSize) || value.blockSize <= 0 ||
      !Array.isArray(value.blocks) || value.blocks.length !== Math.max(1, Math.ceil(size / value.blockSize)) ||
      value.blocks.some((hash) => typeof hash !== 'string' || !SHA256.test(hash))) {
    throw new Error(`Invalid ASAR integrity: ${name}`);
  }
}

function entriesOf(header, packedSize) {
  const entries = [];
  function walk(directory, prefix = '') {
    if (!directory || typeof directory !== 'object' || Array.isArray(directory) ||
        !directory.files || typeof directory.files !== 'object' || Array.isArray(directory.files)) {
      throw new Error(`Invalid ASAR directory: ${prefix || '/'}`);
    }
    for (const [name, entry] of Object.entries(directory.files)) {
      if (name.includes('/')) throw new Error(`Invalid ASAR entry name: ${name}`);
      const filename = memberPath(prefix ? `${prefix}/${name}` : name);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Invalid ASAR entry: ${filename}`);
      if (entry.unpacked !== undefined && typeof entry.unpacked !== 'boolean') throw new Error(`Invalid unpacked flag: ${filename}`);
      if (entry.executable !== undefined && typeof entry.executable !== 'boolean') throw new Error(`Invalid executable flag: ${filename}`);
      entries.push({ path: filename, entry });
      if (own(entry, 'files')) {
        if (own(entry, 'link') || own(entry, 'size') || own(entry, 'offset')) throw new Error(`Ambiguous ASAR directory: ${filename}`);
        walk(entry, filename);
      } else if (own(entry, 'link')) {
        memberPath(entry.link);
        if (own(entry, 'size') || own(entry, 'offset')) throw new Error(`Ambiguous ASAR link: ${filename}`);
      } else {
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`Invalid ASAR size: ${filename}`);
        if (entry.unpacked === true) {
          if (own(entry, 'offset')) throw new Error(`Unpacked member has an offset: ${filename}`);
        } else if (typeof entry.offset !== 'string' || !/^\d+$/.test(entry.offset) ||
                   !Number.isSafeInteger(Number(entry.offset)) || Number(entry.offset) + entry.size > packedSize) {
          throw new Error(`Invalid ASAR offset or boundary: ${filename}`);
        }
        if (entry.integrity !== undefined) validateIntegrity(entry.integrity, entry.size, filename);
      }
    }
  }
  walk(header);
  return entries;
}

function getEntry(header, filename, follow = true) {
  let parts = memberPath(filename).split('/');
  for (let redirects = 0; redirects < 64; redirects++) {
    let current = header;
    let restart = false;
    for (let index = 0; index < parts.length; index++) {
      if (!current.files || !own(current.files, parts[index])) throw new Error(`ASAR member not found: ${filename}`);
      current = current.files[parts[index]];
      if (current.link && (follow || index < parts.length - 1)) {
        parts = [...memberPath(current.link).split('/'), ...parts.slice(index + 1)];
        restart = true;
        break;
      }
    }
    if (!restart) return { entry: current, path: parts.join('/') };
  }
  throw new Error(`Cyclic ASAR link: ${filename}`);
}

function readUnpacked(archivePath, filename, entry) {
  const base = fs.realpathSync(`${archivePath}.unpacked`);
  const target = fs.realpathSync(path.join(base, ...memberPath(filename).split('/')));
  if (!target.startsWith(`${base}${path.sep}`)) throw new Error(`Unpacked member escapes archive: ${filename}`);
  const data = fs.readFileSync(target);
  if (data.length !== entry.size) throw new Error(`Unpacked member size mismatch: ${filename}`);
  return data;
}

/** Inspect the small header only. read() explicitly loads one requested member. */
export function inspectAsar(archivePath) {
  const resolved = path.resolve(archivePath);
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let headerBytes, headerSize, archiveSize, sourceStat;
  try {
    const stat = fs.fstatSync(fd);
    sourceStat = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
    if (!stat.isFile()) throw new Error('ASAR input must be a regular file');
    archiveSize = stat.size;
    const prefix = Buffer.alloc(16);
    readExactly(fd, prefix, 0);
    headerSize = prefix.readUInt32LE(4);
    const jsonLength = prefix.readUInt32LE(12);
    const alignedLength = Math.ceil(jsonLength / 4) * 4;
    if (prefix.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > MAX_HEADER_SIZE ||
        headerSize + 8 > archiveSize || prefix.readUInt32LE(8) !== headerSize - 4 ||
        headerSize !== 8 + alignedLength) throw new Error('Invalid ASAR Pickle header');
    const pickle = Buffer.alloc(headerSize);
    readExactly(fd, pickle, 8);
    headerBytes = pickle.subarray(8, 8 + jsonLength);
    if (pickle.subarray(8 + jsonLength).some((byte) => byte !== 0)) throw new Error('Invalid ASAR Pickle padding');
  } finally { fs.closeSync(fd); }
  const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headerBytes));
  const dataOffset = 8 + headerSize;
  const entries = entriesOf(header, archiveSize - dataOffset);
  for (const item of entries) if (item.entry.link) getEntry(header, item.path);
  return {
    header, dataOffset, headerSize, headerHash: sha256(headerBytes), entries, sourceStat,
    read(filename) {
      const found = getEntry(header, filename);
      if (found.entry.files) throw new Error(`ASAR member is a directory: ${filename}`);
      let data;
      if (found.entry.unpacked) data = readUnpacked(resolved, found.path, found.entry);
      else {
        data = Buffer.alloc(found.entry.size);
        const file = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        try { readExactly(file, data, dataOffset + Number(found.entry.offset)); }
        finally { fs.closeSync(file); }
      }
      if (found.entry.integrity && !sameIntegrity(integrityForBuffer(data, found.entry.integrity.blockSize),
          found.entry.integrity)) throw new Error(`ASAR member integrity mismatch: ${filename}`);
      return data;
    },
  };
}

function content(value, original) {
  const options = Buffer.isBuffer(value) ? { data: value } : value;
  if (!options || !Buffer.isBuffer(options.data)) throw new Error('ASAR content must be a Buffer or { data: Buffer }');
  for (const flag of ['unpacked', 'executable']) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') throw new Error(`Invalid ASAR content ${flag}`);
  }
  const entry = original ? structuredClone(original) : {};
  entry.size = options.data.length;
  if (options.unpacked !== undefined) entry.unpacked = options.unpacked;
  if (options.executable !== undefined) entry.executable = options.executable;
  entry.integrity = integrityForBuffer(options.data, original?.integrity?.blockSize);
  delete entry.offset;
  if (!entry.unpacked) entry.offset = '0';
  return { entry, data: options.data };
}

function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header));
  const headerSize = 8 + Math.ceil(json.length / 4) * 4;
  if (headerSize > MAX_HEADER_SIZE) throw new Error('ASAR header is too large');
  const bytes = Buffer.alloc(8 + headerSize);
  bytes.writeUInt32LE(4, 0);
  bytes.writeUInt32LE(headerSize, 4);
  bytes.writeUInt32LE(headerSize - 4, 8);
  bytes.writeUInt32LE(json.length, 12);
  json.copy(bytes, 16);
  return { bytes, headerHash: sha256(json) };
}

/** Synchronous, bounded-copy repack. Never writes input or .unpacked files. */
export function repackAsar({ input, output, replacements = new Map(), additions = new Map(), remove = () => false }) {
  if (!(replacements instanceof Map) || !(additions instanceof Map) || typeof remove !== 'function') throw new Error('Invalid ASAR repack options');
  if (path.resolve(input) === path.resolve(output)) throw new Error('ASAR output must differ from input');
  const source = inspectAsar(input);
  const header = structuredClone(source.header);
  const originals = new Map(source.entries.map((item) => [item.path, item.entry]));
  const removed = new Set();
  const changes = new Map();
  function prune(directory, prefix = '') {
    for (const [name, entry] of Object.entries(directory.files)) {
      const filename = prefix ? `${prefix}/${name}` : name;
      if (remove(filename, structuredClone(entry))) {
        for (const item of source.entries) if (item.path === filename || item.path.startsWith(`${filename}/`)) removed.add(item.path);
        delete directory.files[name];
      } else if (entry.files) prune(entry, filename);
    }
  }
  prune(header);
  function parentOf(filename, create) {
    const parts = memberPath(filename).split('/');
    const name = parts.pop();
    let directory = header;
    for (const part of parts) {
      if (!own(directory.files, part)) {
        if (!create) throw new Error(`ASAR parent not found: ${filename}`);
        Object.defineProperty(directory.files, part, { value: { files: Object.create(null) }, enumerable: true, writable: true, configurable: true });
      }
      directory = directory.files[part];
      if (!directory.files) throw new Error(`ASAR parent is not a directory: ${filename}`);
    }
    return { directory, name };
  }
  for (const [filename, value] of replacements) {
    memberPath(filename);
    const original = originals.get(filename);
    if (!original || original.files || original.link || removed.has(filename)) throw new Error(`Cannot replace ASAR member: ${filename}`);
    const changed = content(value, original);
    const { directory, name } = parentOf(filename, false);
    directory.files[name] = changed.entry;
    changes.set(filename, changed.data);
  }
  for (const [filename, value] of additions) {
    memberPath(filename);
    if (originals.has(filename) || [...removed].some((item) => filename.startsWith(`${item}/`))) throw new Error(`Cannot add existing or removed ASAR member: ${filename}`);
    const changed = content(value);
    const { directory, name } = parentOf(filename, true);
    if (own(directory.files, name)) throw new Error(`ASAR addition collision: ${filename}`);
    Object.defineProperty(directory.files, name, { value: changed.entry, enumerable: true, writable: true, configurable: true });
    changes.set(filename, changed.data);
  }
  const entries = entriesOf(header, Number.MAX_SAFE_INTEGER);
  for (const item of entries) if (item.entry.link) getEntry(header, item.path);
  let packedSize = 0;
  const packed = [];
  const unpackedWrites = new Map();
  for (const item of entries) {
    if (item.entry.files || item.entry.link) continue;
    if (item.entry.unpacked) {
      if (changes.has(item.path)) unpackedWrites.set(item.path, changes.get(item.path));
    } else {
      item.entry.offset = String(packedSize);
      packedSize += item.entry.size;
      if (!Number.isSafeInteger(packedSize)) throw new Error('ASAR archive exceeds safe integer size');
      packed.push(item);
    }
  }
  const encoded = encodeHeader(header);
  let sourceFd, targetFd, created = false;
  try {
    sourceFd = fs.openSync(input, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const sourceStat = fs.fstatSync(sourceFd);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs']) {
      if (sourceStat[key] !== source.sourceStat[key]) throw new Error('ASAR input changed after inspection');
    }
    targetFd = fs.openSync(output, 'wx', sourceStat.mode & 0o777);
    created = true;
    writeExactly(targetFd, encoded.bytes);
    const buffer = Buffer.alloc(1024 * 1024);
    for (const item of packed) {
      if (changes.has(item.path)) { writeExactly(targetFd, changes.get(item.path)); continue; }
      const original = originals.get(item.path);
      const integrity = original.integrity && streamedIntegrity(original.integrity.blockSize);
      let remaining = original.size;
      let position = source.dataOffset + Number(original.offset);
      while (remaining) {
        const chunk = buffer.subarray(0, Math.min(buffer.length, remaining));
        readExactly(sourceFd, chunk, position);
        integrity?.update(chunk);
        writeExactly(targetFd, chunk);
        remaining -= chunk.length;
        position += chunk.length;
      }
      if (integrity && !sameIntegrity(integrity.digest(), original.integrity)) throw new Error(`ASAR member integrity mismatch: ${item.path}`);
    }
    const after = fs.fstatSync(sourceFd);
    if (sourceStat.size !== after.size || sourceStat.mtimeMs !== after.mtimeMs) throw new Error('ASAR input changed while copying');
    fs.fsyncSync(targetFd);
  } catch (error) {
    if (created) { if (targetFd !== undefined) { fs.closeSync(targetFd); targetFd = undefined; } fs.unlinkSync(output); }
    throw error;
  } finally {
    if (sourceFd !== undefined) fs.closeSync(sourceFd);
    if (targetFd !== undefined) fs.closeSync(targetFd);
  }
  return {
    headerHash: encoded.headerHash, entries: entries.length, packedCount: packed.length,
    unpackedCount: entries.filter((item) => item.entry.unpacked && !item.entry.files && !item.entry.link).length,
    packedBytes: packedSize, removedPaths: [...removed], unpackedWrites,
  };
}
