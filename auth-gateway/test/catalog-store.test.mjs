import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AuthStore } from '../src/store.mjs';
import { CatalogStore } from '../src/catalog-store.mjs';
import { buildTarGz, buildZip, readSourceDirectory } from '../src/package-archive.mjs';
import { readCatalogManifest, runCatalog } from '../scripts/catalog.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-catalog-'));
  const config = { dataDir: path.join(directory, 'data') }, sourceDir = path.join(directory, 'source');
  fs.mkdirSync(sourceDir); fs.mkdirSync(path.join(sourceDir, 'skills'));
  fs.writeFileSync(path.join(sourceDir, 'plugin.json'), JSON.stringify({ name: 'private-test', version: '1.0.0' }));
  fs.writeFileSync(path.join(sourceDir, 'skills', 'SKILL.md'), '# Private skill\nDo useful local work.\n');
  const auth = new AuthStore(config), catalog = new CatalogStore(config, { db: auth.db, key: auth.key, now: () => 1700000000000 });
  t.after(() => { try { auth.close(); } catch {} fs.rmSync(directory, { recursive: true, force: true }); });
  const manifest = { kind: 'expert', id: 'private-test', name: '私有测试专家', description: '本地目录', version: '1.0.0', categoryId: 'engineering', tags: ['local'], metadata: { categoryName: '研发', nested: { supported: true } }, sourceDir };
  return { directory, config, sourceDir, auth, catalog, manifest };
}

function readTar(buffer) {
  const tar = gunzipSync(buffer), files = {};
  for (let offset = 0; offset + 512 <= tar.length && tar[offset] !== 0;) {
    const header = tar.subarray(offset, offset + 512), name = header.subarray(0, 100).toString().split('\0')[0], prefix = header.subarray(345, 500).toString().split('\0')[0];
    const size = parseInt(header.subarray(124, 136).toString().split('\0')[0], 8), checksum = parseInt(header.subarray(148, 156).toString().split('\0')[0], 8);
    assert.equal(header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0), checksum);
    assert.equal(header[156], 48); assert.equal(header.subarray(257, 263).toString(), 'ustar\0');
    files[prefix ? prefix + '/' + name : name] = tar.subarray(offset + 512, offset + 512 + size).toString();
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function readZip(buffer) {
  const end = buffer.subarray(buffer.length - 22);
  assert.equal(end.readUInt32LE(0), 0x06054b50);
  const count = end.readUInt16LE(10), files = {};
  let offset = end.readUInt32LE(16);
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const nameLength = buffer.readUInt16LE(offset + 28), size = buffer.readUInt32LE(offset + 24), local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString();
    assert.equal(buffer.readUInt32LE(local), 0x04034b50); assert.equal(buffer.readUInt16LE(local + 8), 0); assert.equal(buffer.readUInt16LE(local + 6), 0x0800);
    const dataOffset = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    files[name] = buffer.subarray(dataOffset, dataOffset + size).toString();
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return files;
}

test('catalog publishes immutable versioned archives, preserves history, and does not alter auth schema', t => {
  const { catalog, manifest, auth, sourceDir } = fixture(t);
  const first = catalog.publish(manifest), object = catalog.asset(first.packagePath);
  assert.match(first.packagePath, /^objects\/[a-f0-9]{2}\/[a-f0-9]{64}\.tar\.gz$/);
  assert.equal(auth.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(auth.db.prepare('SELECT version FROM catalog_schema WHERE id=1').get().version, 1);
  assert.equal(readTar(fs.readFileSync(object.absolutePath))['skills/SKILL.md'], '# Private skill\nDo useful local work.\n');
  assert.throws(() => catalog.publish(manifest), /already exists/);
  fs.writeFileSync(path.join(sourceDir, 'skills', 'SKILL.md'), '# Updated private skill\n');
  const second = catalog.publish({ ...manifest, version: '1.1.0' });
  assert.notEqual(second.sha256, first.sha256);
  assert.equal(catalog.get('expert', manifest.id).version, '1.1.0');
  assert.equal(catalog.get('expert', manifest.id, { version: '1.0.0' }).sha256, first.sha256);
  assert.equal(catalog.list('expert', { keyword: '私有', categoryId: 'engineering' }).length, 1);
  assert.deepEqual(catalog.categories('expert'), [{ id: 'engineering', name: '研发', count: 1 }]);
  catalog.setEnabled('expert', manifest.id, false);
  assert.equal(catalog.get('expert', manifest.id), undefined);
  assert.equal(catalog.get('expert', manifest.id, { version: '1.0.0' }), undefined);
  assert.deepEqual(catalog.list('expert'), []);
  assert.equal(catalog.get('expert', manifest.id, { version: '1.0.0', includeDisabled: true }).enabled, false);
  assert.equal(catalog.list('expert', { enabledOnly: false }).length, 1);
  assert.equal(catalog.asset(first.packagePath).sha256, first.sha256);
  catalog.publish({ ...manifest, version: '1.2.0' });
  assert.equal(catalog.get('expert', manifest.id), undefined, 'new publication must not silently re-enable a withdrawn entry');
  catalog.setEnabled('expert', manifest.id, true);
  assert.equal(catalog.get('expert', manifest.id).version, '1.2.0');
});

test('skills and connectors expose valid zip archives and immutable source inventories', t => {
  const { catalog, manifest } = fixture(t);
  for (const kind of ['skill', 'connector']) {
    const record = catalog.publish({ ...manifest, kind });
    assert.match(record.packagePath, /\.zip$/);
    const files = readZip(fs.readFileSync(catalog.asset(record.packagePath).absolutePath));
    assert.equal(files['skills/SKILL.md'], '# Private skill\nDo useful local work.\n');
    for (const file of record.files) assert.equal(fs.readFileSync(catalog.asset(file.path).absolutePath).toString(), files[file.name]);
  }
  const zip = buildZip([{ name: 'checksum.txt', data: Buffer.from('123456789') }]);
  assert.equal(zip.readUInt32LE(14), 0xcbf43926, 'ZIP CRC32 must be interoperable');
  assert.ok(catalog.inventory().every(asset => catalog.asset(asset.path).sha256 === asset.sha256));
});

test('catalog persists across authentication store reopen without owning its database', t => {
  const { catalog, auth, config, manifest } = fixture(t);
  const record = catalog.publish(manifest);
  assert.equal(auth.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  const second = new AuthStore(config);
  try {
    const reopened = new CatalogStore(config, { db: second.db, key: second.key });
    assert.equal(reopened.get('expert', manifest.id).sha256, record.sha256);
    assert.equal(reopened.inventory().length, catalog.inventory().length);
  } finally { second.close(); }
  assert.equal(catalog.get('expert', manifest.id).id, manifest.id);
});

test('package builders reject traversal, links, conflicts, duplicates and oversized input', t => {
  const { sourceDir, directory } = fixture(t);
  for (const builder of [buildTarGz, buildZip]) {
    for (const name of ['../escape', '/absolute', 'C:/drive', 'folder\\file', 'folder/../file', 'folder//file', 'file\0.txt', 'file:stream', 'CON.txt', 'file.']) assert.throws(() => builder([{ name, data: Buffer.from('x') }]), /path/);
    assert.throws(() => builder([{ name: 'a', data: Buffer.from('x') }, { name: 'a', data: Buffer.from('y') }]), /Duplicate/);
    assert.throws(() => builder([{ name: 'A', data: Buffer.from('x') }, { name: 'a', data: Buffer.from('y') }]), /Duplicate/);
    assert.throws(() => builder([{ name: 'a', data: Buffer.from('x') }, { name: 'a/b', data: Buffer.from('y') }]), /Conflicting/);
    assert.throws(() => builder([{ name: 'A', data: Buffer.from('x') }, { name: 'a/b', data: Buffer.from('y') }]), /Conflicting/);
    assert.throws(() => builder([{ name: 'a', data: Buffer.from('ab') }], { maxFileBytes: 1 }), /size/);
    assert.throws(() => builder([]), /count/);
  }
  const symlink = path.join(sourceDir, 'outside'); fs.symlinkSync(directory, symlink);
  assert.throws(() => readSourceDirectory(sourceDir), /symlink/); fs.unlinkSync(symlink);
  const hardlink = path.join(sourceDir, 'copy'); fs.linkSync(path.join(sourceDir, 'plugin.json'), hardlink);
  assert.throws(() => readSourceDirectory(sourceDir), /hard links/); fs.unlinkSync(hardlink);
  const rootLink = path.join(directory, 'source-link'); fs.symlinkSync(sourceDir, rootLink);
  assert.throws(() => readSourceDirectory(rootLink), /symlink/);
  assert.throws(() => readSourceDirectory(sourceDir, { maxFiles: 1 }), /limits/);
});

test('catalog refuses unregistered or tampered assets and non-JSON metadata', t => {
  const { catalog, manifest } = fixture(t);
  for (const input of [{ ...manifest, id: '../escape' }, { ...manifest, version: '../v1' }, { ...manifest, metadata: { execute: () => {} } }, { ...manifest, metadata: { value: Infinity } }]) assert.throws(() => catalog.publish(input), /Invalid|JSON/);
  assert.throws(() => catalog.publish({ ...manifest, metadata: { long: 'x'.repeat(65536) } }), /size limit/);
  const record = catalog.publish(manifest), asset = catalog.asset(record.packagePath);
  assert.equal(catalog.asset('../../delivery.key'), undefined);
  assert.equal(catalog.asset('objects/ab/' + 'a'.repeat(64) + '.zip'), undefined);
  fs.writeFileSync(asset.absolutePath, 'tampered');
  assert.throws(() => catalog.asset(record.packagePath), /integrity/);
});

test('publication cannot bundle authentication data or ambiguously expose user-restricted content', t => {
  const { catalog, manifest, config, directory } = fixture(t);
  assert.throws(() => catalog.publish({ ...manifest, sourceDir: config.dataDir }), /authentication data/);
  assert.throws(() => catalog.publish({ ...manifest, sourceDir: directory }), /authentication data/);
  assert.throws(() => catalog.publish({ ...manifest, metadata: { public: true, allowedUsers: ['reader'] } }), /Public content/);
  assert.throws(() => catalog.publish({ ...manifest, metadata: { allowedUsers: ['reader', null] } }), /visibility/);
  assert.throws(() => catalog.publish({ ...manifest, metadata: { public: 'true' } }), /boolean/);
  assert.deepEqual(catalog.inventory(), []);
});

test('catalog CLI manages relative manifests and records operator audit without dumping metadata', async t => {
  const { directory, config, auth } = fixture(t);
  const filename = path.join(directory, 'manifest.json');
  const manifest = { kind: 'skill', id: 'private-cli', name: 'CLI 测试技能', version: '1.0.0', sourceDir: './source', metadata: { password: 'not-an-auth-password-but-never-print' } };
  fs.writeFileSync(filename, JSON.stringify(manifest));
  const lines = [], stdout = { write: line => lines.push(line) };
  await runCatalog(['publish', '--manifest', filename, '--data-dir', config.dataDir], { stdout });
  const current = path.join(directory, 'current-catalog.mjs');
  fs.symlinkSync(fileURLToPath(new URL('../scripts/catalog.mjs', import.meta.url)), current);
  const listed = spawnSync(process.execPath, [current, 'list', 'skill', '--data-dir', config.dataDir], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr); assert.equal(JSON.parse(listed.stdout.trim()).id, 'private-cli');
  await runCatalog(['disable', 'skill', 'private-cli', '--data-dir', config.dataDir], { stdout });
  await runCatalog(['show', 'skill', 'private-cli', '--data-dir', config.dataDir], { stdout });
  assert.equal(lines.length, 3); assert.equal(JSON.parse(lines[1]).enabled, false);
  assert.ok(lines.every(line => !line.includes(manifest.metadata.password)));
  assert.ok(auth.listAudit().some(row => row.action === 'catalog_publish:skill:private-cli:1.0.0'));
  assert.throws(() => { fs.writeFileSync(filename, JSON.stringify({ ...manifest, sourceDir: '../source' })); readCatalogManifest(filename); }, /parent traversal/);
  assert.throws(() => { fs.writeFileSync(filename, JSON.stringify({ ...manifest, unexpected: true })); readCatalogManifest(filename); }, /Unknown/);
});
