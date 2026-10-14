import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { buildZip } from '../src/package-archive.mjs';
import { buildConnectorMarketplace, CONNECTOR_MARKETPLACE_NAME } from '../src/connector-catalog.mjs';

function fixture({ id = 'private-echo', version = '1.0.0', publicRecord = true, prefix = '' } = {}) {
  const plugin = { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: id, version, description: 'Local echo connector',
    extensions: { 'ai.workbuddy': { schemaVersion: '1.0.0', display: { name: 'Private Echo', description: 'Private tools' }, setup: { mcpServers: { echo: { timeout: 20000 } } }, policy: { mcpServers: { echo: { defer_loading: false } } } } } };
  const mcp = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { echo: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/scripts/echo.mjs'], cwd: './' } } };
  const entries = [{ name: prefix + 'plugin.json', data: Buffer.from(JSON.stringify(plugin)) }, { name: prefix + 'mcp.json', data: Buffer.from(JSON.stringify(mcp)) }, { name: prefix + 'scripts/echo.mjs', data: Buffer.from('process.stdout.write("fixture");\n') }];
  const assets = new Map();
  const record = { kind: 'connector', id, name: 'Private Echo', description: 'Private tools', version, enabled: true, metadata: { public: publicRecord }, files: entries.map(entry => {
    const sha256 = createHash('sha256').update(entry.data).digest('hex'), assetPath = `objects/${sha256}`;
    assets.set(assetPath, entry.data);
    return { name: entry.name, path: assetPath, size: entry.data.length, sha256 };
  }) };
  return { record, assets, plugin, mcp, entries };
}

function zipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 8), 0);
    const size = buffer.readUInt32LE(offset + 18), length = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + length).toString('utf8'), start = offset + 30 + length + extra;
    entries.set(name, buffer.subarray(start, start + size)); offset = start + size;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
  return entries;
}

test('private archive contains native marketplace layout and preserves protocol resources byte for byte', async () => {
  const f = fixture(), restricted = fixture({ id: 'restricted', publicRecord: false });
  const result = await buildConnectorMarketplace({ records: [restricted.record, f.record], version: 5, publicUrl: 'http://127.0.0.1:8787', readAsset: p => f.assets.get(p), buildZip });
  const entries = zipEntries(result.buffer), manifest = JSON.parse(entries.get('.codebuddy-plugin/marketplace.json'));
  assert.equal(manifest.name, CONNECTOR_MARKETPLACE_NAME);
  assert.deepEqual(manifest.plugins, [{ name: f.record.id, source: './connectors/private-echo', version: '1.0.0', description: 'Private tools' }]);
  for (const entry of f.entries) assert.deepEqual(entries.get(`connectors/private-echo/${entry.name}`), entry.data);
  assert.equal([...entries.keys()].some(name => name.includes('restricted')), false);
  assert.equal(result.etag, `"${createHash('sha256').update(result.buffer).digest('hex')}"`);
  assert.equal(result.url, 'http://127.0.0.1:8787/connector-agent-plugins/connector-plugins.zip');
});

test('updated package changes version, asset bytes and etag; async dependencies are supported', async () => {
  const one = fixture(), two = fixture({ version: '1.0.1', prefix: 'upload-root/' });
  const build = f => buildConnectorMarketplace({ records: [f.record], version: f.record.version, publicUrl: 'https://private.example.test', readAsset: async p => f.assets.get(p), buildZip: async e => buildZip(e) });
  const a = await build(one), b = await build(two);
  assert.notEqual(a.etag, b.etag); assert.equal(b.manifest.plugins[0].version, '1.0.1');
  assert.ok(zipEntries(b.buffer).has('connectors/private-echo/plugin.json'));
  assert.equal([...zipEntries(b.buffer).keys()].some(name => name.includes('upload-root')), false);
});

test('unpublished/private records are never read; disabled and other-kind records are excluded', async () => {
  const f = fixture();
  const records = [{ ...f.record, metadata: {} }, { ...f.record, enabled: false }, { ...f.record, kind: 'skill' }, { ...f.record, metadata: { public: true, allowedUsers: [] } }, { ...f.record, allowedUsers: ['someone'] }];
  const result = await buildConnectorMarketplace({ records, publicUrl: 'https://private.example.test', readAsset: () => { throw new Error('must not read restricted resource'); }, buildZip });
  assert.deepEqual(result.manifest.plugins, []);
});

test('aggregate byte and file limits reject the inventory before reading any assets', async () => {
  for (const mutate of [
    f => { f.record.files = f.record.files.map(file => ({ ...file, size: 24 * 1024 * 1024 })); },
    f => { f.record.files.push(...Array.from({ length: 5000 }, (_, i) => ({ name: `data/file-${i}.bin`, path: 'fixture', size: 1 }))); },
    f => { delete f.record.files[0].size; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(buildConnectorMarketplace({ records: [f.record], publicUrl: 'https://private.example.test', readAsset: () => { assert.fail('oversized inventory must not read assets'); }, buildZip }), /limits|metadata/);
  }
});

test('rejects unsafe paths, duplicate names, checksum changes and invalid package identity', async () => {
  for (const mutate of [
    f => { f.record.files[0].name = '../plugin.json'; },
    f => { f.record.files.push(f.record.files[0]); },
    f => { f.record.files[0].sha256 = 'a'.repeat(64); },
    f => { f.record.version = '9.0.0'; },
    f => { f.record.id = '../escape'; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(buildConnectorMarketplace({ records: [f.record], publicUrl: 'https://private.example.test', readAsset: p => f.assets.get(p), buildZip }));
  }
});

test('legacy dot-directory manifest is kept at its original native package path', async () => {
  const data = Buffer.from(JSON.stringify({ name: 'legacy-echo', version: '1.0.0', extensions: { 'ai.workbuddy': { connector: { name: 'Legacy Echo' } } } }));
  const record = { kind: 'connector', id: 'legacy-echo', version: '1.0.0', enabled: true, metadata: { public: true }, files: [{ name: '.codebuddy-plugin/plugin.json', path: 'fixture', size: data.length }] };
  const archive = await buildConnectorMarketplace({ records: [record], publicUrl: 'https://private.example.test', readAsset: () => data, buildZip });
  assert.ok(zipEntries(archive.buffer).has('connectors/legacy-echo/.codebuddy-plugin/plugin.json'));
});

const nativeEvidence = new URL('./fixtures/connector-consumers.json', import.meta.url);
test('current original native converter accepts the generated plugin and WorkBuddy extension', async () => {
  const slices = JSON.parse(fs.readFileSync(nativeEvidence, 'utf8'));
  const code = slices.map(({ start, code }) => {
    assert.ok(code.startsWith(start)); return code;
  }).join('\n');
  const context = vm.createContext({ Map, Object, isRecord$1: v => v && typeof v === 'object' && !Array.isArray(v), isPluginRecord: v => v && typeof v === 'object' && !Array.isArray(v) });
  vm.runInContext(code, context);
  const f = fixture(), archive = await buildConnectorMarketplace({ records: [f.record], publicUrl: 'https://private.example.test', readAsset: p => f.assets.get(p), buildZip });
  const files = zipEntries(archive.buffer), plugin = JSON.parse(files.get('connectors/private-echo/plugin.json'));
  const result = context.toConnectorManifest(archive.manifest, new Map([['private-echo', { pluginManifest: plugin, mcp: f.mcp }]]));
  assert.equal(result.connectors[0].source, 'private-echo'); assert.equal(result.connectors[0].name, 'Private Echo');
  assert.equal(result.connectors[0].type, 'mcp'); assert.equal(result.connectors[0].version, '1.0.0');
});
