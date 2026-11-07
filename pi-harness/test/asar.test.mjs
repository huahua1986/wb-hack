import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectAsar, repackAsar } from '../package-dmg/asar.mjs';

const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const blockSize = 4 * 1024 * 1024;
function integrity(data) {
  const blocks = [];
  for (let i = 0; i < data.length; i += blockSize) blocks.push(hash(data.subarray(i, i + blockSize)));
  return { algorithm: 'SHA256', hash: hash(data), blockSize, blocks: blocks.length ? blocks : [hash(data)] };
}
function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-asar-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'input.asar'), output = path.join(root, 'output.asar');
  const header = { files: {} }, payload = [];
  let offset = 0;
  for (const [filename, value] of Object.entries(files)) {
    const parts = filename.split('/'), name = parts.pop();
    let cursor = header;
    for (const part of parts) cursor = cursor.files[part] ??= { files: {} };
    if (value.link) { cursor.files[name] = value; continue; }
    const data = Buffer.isBuffer(value) ? value : value.data;
    const entry = { size: data.length, integrity: integrity(data) };
    if (value.executable) entry.executable = true;
    if (value.unpacked) {
      entry.unpacked = true;
      const unpacked = path.join(`${input}.unpacked`, filename);
      fs.mkdirSync(path.dirname(unpacked), { recursive: true }); fs.writeFileSync(unpacked, data);
    } else { entry.offset = String(offset); offset += data.length; payload.push(data); }
    cursor.files[name] = entry;
  }
  const json = Buffer.from(JSON.stringify(header));
  const pickleSize = 8 + Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(8 + pickleSize);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(pickleSize, 4);
  prefix.writeUInt32LE(pickleSize - 4, 8); prefix.writeUInt32LE(json.length, 12); json.copy(prefix, 16);
  fs.writeFileSync(input, Buffer.concat([prefix, ...payload]));
  return { input, output, root, header };
}

test('repack adds, replaces and deletes without changing source or unpacked metadata', (t) => {
  const big = Buffer.alloc(blockSize + 37, 0x36);
  const f = fixture(t, {
    'main.cjs': Buffer.from('original main'),
    'keep/big.bin': big,
    'keep/empty': Buffer.alloc(0),
    'keep/run': { data: Buffer.from('executable'), executable: true },
    'native/addon.node': { data: Buffer.from('native'), unpacked: true, executable: true },
    'native/link.node': { link: 'native/addon.node', unpacked: true },
    'cli/package.json': { data: Buffer.from('old cli'), unpacked: true },
    'cli/other.txt': Buffer.from('remove me'),
  });
  const before = hash(fs.readFileSync(f.input));
  const result = repackAsar({
    ...f,
    replacements: new Map([['main.cjs', Buffer.from('replacement main')]]),
    additions: new Map([['pi/中文.cjs', Buffer.from('new Pi')], ['pi/empty', Buffer.alloc(0)]]),
    remove: (filename) => filename === 'cli',
  });
  assert.equal(hash(fs.readFileSync(f.input)), before);
  const after = inspectAsar(f.output);
  assert.equal(after.headerHash, result.headerHash);
  assert.deepEqual(after.read('main.cjs'), Buffer.from('replacement main'));
  assert.deepEqual(after.read('keep/big.bin'), big);
  assert.equal(after.read('keep/empty').length, 0);
  assert.deepEqual(after.read('pi/中文.cjs'), Buffer.from('new Pi'));
  assert.equal(after.header.files.keep.files.run.executable, true);
  assert.deepEqual(after.header.files.native, f.header.files.native);
  assert.equal(own(after.header.files, 'cli'), false);
  assert.ok(result.removedPaths.includes('cli/package.json'));
  assert.equal(result.unpackedWrites.size, 0);
  assert.equal(fs.existsSync(`${f.output}.unpacked`), false);
  // Independent decode checks every packed offset, whole-file hash and block hash.
  const raw = fs.readFileSync(f.output), jsonLength = raw.readUInt32LE(12);
  assert.equal(hash(raw.subarray(16, 16 + jsonLength)), result.headerHash);
  let expectedOffset = 0;
  for (const { path: filename, entry } of after.entries) {
    if (entry.files || entry.link || entry.unpacked) continue;
    assert.equal(Number(entry.offset), expectedOffset, filename);
    const data = raw.subarray(after.dataOffset + expectedOffset, after.dataOffset + expectedOffset + entry.size);
    assert.deepEqual(entry.integrity, integrity(data), filename);
    assert.deepEqual(after.read(filename), data);
    expectedOffset += entry.size;
  }
  assert.equal(raw.length, after.dataOffset + result.packedBytes);
});
const own = (object, name) => Object.hasOwn(object, name);

test('unpacked changes return explicit writes; flags and integrity are retained', (t) => {
  const f = fixture(t, { 'native/bin': { data: Buffer.from('old'), unpacked: true, executable: true } });
  const changed = Buffer.from('new unpacked binary');
  const added = Buffer.from('new unpacked file');
  const result = repackAsar({ ...f,
    replacements: new Map([['native/bin', changed]]),
    additions: new Map([['pi/bin', { data: added, unpacked: true, executable: true }]]),
  });
  const after = inspectAsar(f.output);
  assert.equal(result.packedBytes, 0);
  assert.deepEqual([...result.unpackedWrites.keys()], ['native/bin', 'pi/bin']);
  assert.equal(after.header.files.native.files.bin.unpacked, true);
  assert.equal(after.header.files.native.files.bin.executable, true);
  assert.equal(own(after.header.files.native.files.bin, 'offset'), false);
  for (const [filename, data] of result.unpackedWrites) {
    const target = path.join(`${f.output}.unpacked`, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data);
    assert.deepEqual(after.read(filename), data);
  }
});

test('exact block boundary and empty-file integrity use official block semantics', (t) => {
  const f = fixture(t, { file: Buffer.from('old') });
  const data = Buffer.alloc(blockSize, 0x81);
  repackAsar({ ...f, replacements: new Map([['file', data]]), additions: new Map([['empty', Buffer.alloc(0)]]) });
  const after = inspectAsar(f.output);
  assert.equal(after.header.files.file.integrity.blocks.length, 1);
  assert.equal(after.header.files.empty.integrity.blocks.length, 1);
  assert.deepEqual(after.read('file'), data);
  assert.equal(after.read('empty').length, 0);
});

test('unsafe names, collisions, invalid edits and same/existing outputs fail closed', (t) => {
  const f = fixture(t, { 'file': Buffer.from('original'), 'cli/a': Buffer.from('remove') });
  const before = fs.readFileSync(f.input);
  for (const filename of ['../evil', '/absolute', 'a/../evil', 'a//b', 'a\\b', 'C:/drive', 'nul\0x', './x']) {
    assert.throws(() => repackAsar({ ...f, additions: new Map([[filename, Buffer.from('bad')]]) }), /Unsafe/);
    assert.throws(() => inspectAsar(f.input).read(filename), /Unsafe/);
  }
  assert.throws(() => repackAsar({ ...f, output: f.input }), /differ/);
  fs.writeFileSync(f.output, 'existing');
  assert.throws(() => repackAsar(f), /EEXIST/);
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'existing');
  fs.unlinkSync(f.output);
  assert.throws(() => repackAsar({ ...f, replacements: new Map([['missing', Buffer.from('x')]]) }), /Cannot replace/);
  assert.throws(() => repackAsar({ ...f, additions: new Map([['file', Buffer.from('x')]]) }), /Cannot add/);
  assert.throws(() => repackAsar({ ...f, additions: new Map([['file/a', Buffer.from('x')]]) }), /not a directory/);
  assert.throws(() => repackAsar({ ...f, remove: (p) => p === 'cli', additions: new Map([['cli/new', Buffer.from('x')]]) }), /Cannot add/);
  assert.throws(() => repackAsar({ ...f, remove: (p) => p === 'file', replacements: new Map([['file', Buffer.from('x')]]) }), /Cannot replace/);
  assert.deepEqual(fs.readFileSync(f.input), before);
  assert.equal(fs.existsSync(f.output), false);
});

test('corrupt source bytes fail integrity and remove only newly created output', (t) => {
  const f = fixture(t, { file: Buffer.from('intact') });
  const raw = fs.readFileSync(f.input); raw[raw.length - 1] ^= 1; fs.writeFileSync(f.input, raw);
  assert.throws(() => inspectAsar(f.input).read('file'), /integrity mismatch/);
  assert.throws(() => repackAsar(f), /integrity mismatch/);
  assert.equal(fs.existsSync(f.output), false);
});

test('header truncation, invalid offsets, padding and path traversal are rejected', (t) => {
  const f = fixture(t, { file: Buffer.from('good') });
  const original = fs.readFileSync(f.input);
  for (const length of [0, 8, 15, original.length - 1]) {
    fs.writeFileSync(f.output, original.subarray(0, length));
    assert.throws(() => inspectAsar(f.output), /Truncated|Invalid/);
  }
  const bad = Buffer.from(original); bad.writeUInt32LE(0xffffffff, 4); fs.writeFileSync(f.output, bad);
  assert.throws(() => inspectAsar(f.output), /Pickle/);
  const padded = Buffer.from(original), paddingStart = 16 + original.readUInt32LE(12);
  assert.ok(paddingStart < 8 + original.readUInt32LE(4));
  padded[paddingStart] = 1; fs.writeFileSync(f.output, padded);
  assert.throws(() => inspectAsar(f.output), /padding/);
  const json = JSON.stringify({ files: { '..': { files: {} } } });
  const size = 8 + Math.ceil(Buffer.byteLength(json) / 4) * 4, bytes = Buffer.alloc(8 + size);
  bytes.writeUInt32LE(4, 0); bytes.writeUInt32LE(size, 4); bytes.writeUInt32LE(size - 4, 8);
  bytes.writeUInt32LE(Buffer.byteLength(json), 12); bytes.write(json, 16); fs.writeFileSync(f.output, bytes);
  assert.throws(() => inspectAsar(f.output), /Unsafe/);
});

test('links resolve safely, cannot escape unpacked tree, and cannot remain dangling after deletion', (t) => {
  const f = fixture(t, { real: Buffer.from('content'), alias: { link: 'real' }, 'unpacked/file': { data: Buffer.from('content'), unpacked: true } });
  const before = inspectAsar(f.input);
  assert.deepEqual(before.read('alias'), Buffer.from('content'));
  assert.throws(() => repackAsar({ ...f, remove: (p) => p === 'real' }), /not found/);
  const target = path.join(`${f.input}.unpacked`, 'unpacked/file');
  fs.unlinkSync(target); fs.symlinkSync(f.input, target);
  assert.throws(() => before.read('unpacked/file'), /escapes/);
});
