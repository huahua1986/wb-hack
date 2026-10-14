import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

export const PACKAGE_LIMITS = Object.freeze({ maxFiles: 5000, maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 });

export function validatePackageName(name) {
  if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 1024 || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name) || /[\uD800-\uDFFF]/u.test(name)
    || name.startsWith('/') || name.includes(':') || name.split('/').some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Invalid package entry path');
  }
  return name;
}

function limits(options) {
  const result = { ...PACKAGE_LIMITS, ...options };
  for (const key of Object.keys(PACKAGE_LIMITS)) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > PACKAGE_LIMITS[key]) throw new Error('Invalid package limits');
  }
  return result;
}

function validateEntries(entries, options) {
  const policy = limits(options), names = new Set(), portableNames = new Set();
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > policy.maxFiles) throw new Error('Invalid package file count');
  let total = 0;
  for (const entry of entries) {
    validatePackageName(entry?.name);
    const portable = entry.name.normalize('NFC').toLowerCase();
    if (names.has(entry.name) || portableNames.has(portable)) throw new Error('Duplicate package entry');
    names.add(entry.name);
    portableNames.add(portable);
    if (!Buffer.isBuffer(entry.data) || entry.data.length > policy.maxFileBytes) throw new Error('Package file exceeds size limit');
    total += entry.data.length;
    if (total > policy.maxTotalBytes) throw new Error('Package exceeds total size limit');
  }
  // Archive extraction must not encounter a regular file followed by children of that file.
  for (const name of portableNames) {
    const parts = name.split('/');
    while (parts.length > 1) { parts.pop(); if (portableNames.has(parts.join('/'))) throw new Error('Conflicting package entry paths'); }
  }
  return [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export function readSourceDirectory(sourceDir, options = {}) {
  const policy = limits(options);
  if (typeof sourceDir !== 'string' || !sourceDir || !path.isAbsolute(sourceDir)) throw new Error('Package source must be an absolute directory path');
  const sourceStat = fs.lstatSync(sourceDir);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error('Package source must be a directory, not a symlink');
  const root = fs.realpathSync(sourceDir), entries = [];
  let total = 0, visited = 0;
  const visit = (directory, prefix) => {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(root, fs.realpathSync(directory))) throw new Error('Package directory changed or contains a symlink');
    for (const name of fs.readdirSync(directory).sort()) {
      if (++visited > policy.maxFiles * 2) throw new Error('Package source exceeds directory limits');
      const relative = prefix ? prefix + '/' + name : name;
      validatePackageName(relative);
      const filename = path.join(directory, name), info = fs.lstatSync(filename);
      if (info.isSymbolicLink()) throw new Error('Package source contains a symlink');
      if (info.isDirectory()) { visit(filename, relative); continue; }
      if (!info.isFile() || info.nlink !== 1) throw new Error('Package source must contain only ordinary files without hard links');
      if (entries.length >= policy.maxFiles || info.size > policy.maxFileBytes || total + info.size > policy.maxTotalBytes) throw new Error('Package source exceeds limits');
      const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const current = fs.fstatSync(descriptor);
        if (!current.isFile() || current.nlink !== 1 || current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size
          || !inside(root, fs.realpathSync(filename))) throw new Error('Package source changed during publication');
        const data = Buffer.alloc(current.size);
        let offset = 0;
        while (offset < data.length) { const count = fs.readSync(descriptor, data, offset, data.length - offset, offset); if (!count) throw new Error('Package file changed during publication'); offset += count; }
        const after = fs.fstatSync(descriptor);
        if (after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) throw new Error('Package file changed during publication');
        entries.push({ name: relative, data });
        total += data.length;
      } finally { fs.closeSync(descriptor); }
    }
  };
  visit(root, '');
  return validateEntries(entries, policy);
}

function inside(root, target) { return target === root || target.startsWith(root + path.sep); }

function tarPath(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  for (let index = name.lastIndexOf('/'); index > 0; index = name.lastIndexOf('/', index - 1)) {
    const prefix = name.slice(0, index), base = name.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(base) <= 100) return { name: base, prefix };
  }
  throw new Error('Package entry path exceeds tar format limits');
}

function octal(buffer, offset, length, value) {
  const encoded = value.toString(8);
  if (encoded.length > length - 1) throw new Error('Tar value exceeds format limits');
  buffer.write(encoded.padStart(length - 1, '0') + '\0', offset, length, 'ascii');
}

export function buildTarGz(entries, options = {}) {
  const chunks = [];
  for (const entry of validateEntries(entries, options)) {
    const location = tarPath(entry.name), header = Buffer.alloc(512);
    header.write(location.name, 0, 100, 'utf8');
    octal(header, 100, 8, 0o644); octal(header, 108, 8, 0); octal(header, 116, 8, 0);
    octal(header, 124, 12, entry.data.length); octal(header, 136, 12, 0);
    header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii'); header.write(location.prefix, 345, 155, 'utf8');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    chunks.push(header, entry.data, Buffer.alloc((512 - entry.data.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data) { let value = 0xffffffff; for (const byte of data) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }

export function buildZip(entries, options = {}) {
  const files = [], central = [];
  let offset = 0;
  for (const entry of validateEntries(entries, options)) {
    const name = Buffer.from(entry.name), checksum = crc32(entry.data), local = Buffer.alloc(30), directory = Buffer.alloc(46);
    if (name.length > 0xffff) throw new Error('Zip name exceeds format limits');
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(entry.data.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(0x0021, 14);
    directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(entry.data.length, 20); directory.writeUInt32LE(entry.data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    files.push(local, name, entry.data); central.push(directory, name); offset += local.length + name.length + entry.data.length;
  }
  const end = Buffer.alloc(22), count = files.length / 3, centralBytes = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, centralBytes, end]);
}
