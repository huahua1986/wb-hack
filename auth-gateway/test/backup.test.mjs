import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackup, restoreBackup } from '../src/backup.mjs';
import { acquireServerLock } from '../src/server-lock.mjs';
import { AuthStore } from '../src/store.mjs';
import { CatalogStore } from '../src/catalog-store.mjs';
import { hashPassword } from '../src/credentials.mjs';
import { testConfig } from './helpers.mjs';

function configIn(root) {
  const config = testConfig();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  return { ...config, dataDir: path.join(root, 'data') };
}

test('online backup is consistent and restore retains accounts but invalidates every backed-up session', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-backup-test-')), config = testConfig();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  config.dataDir = path.join(root, 'data');
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
  let store = new AuthStore(config);
  store.addUser('backup-user', 'Backup user', await hashPassword('backup-test-password-only'));
  const state = store.createLoginState();
  store.grantLogin(state, store.getUser('backup-user').id);
  const auth = store.pollLogin(state).auth;
  const sourceDir = path.join(root, 'package-source'); fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Private backup fixture\n');
  const catalog = new CatalogStore(config, { db: store.db, key: store.key });
  const published = [];
  for (const kind of ['expert', 'skill', 'connector']) published.push(catalog.publish({ kind, id: 'backup-' + kind, name: 'Backup ' + kind, version: '1.0.0', sourceDir }));
  fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Updated private backup fixture\n');
  published.push(catalog.publish({ kind: 'expert', id: 'backup-expert', name: 'Backup expert', version: '1.1.0', sourceDir }));
  catalog.setEnabled('connector', 'backup-connector', false);
  const backup = path.join(root, 'snapshot');
  await createBackup(config, backup);
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json')));
  assert.equal(manifest.version, 2);
  assert.equal(Object.keys(manifest.files).length, catalog.inventory().length + 2);
  assert.equal(fs.statSync(path.join(backup, 'delivery.key')).mode & 0o777, 0o600);
  await assert.rejects(createBackup(config, backup), /already exists/);
  await assert.rejects(createBackup(config, path.join(config.dataDir, 'nested')), /separate/);
  const release = acquireServerLock(config.dataDir);
  assert.throws(() => restoreBackup(config, backup), /Stop/);
  release();
  store.close();
  const restored = restoreBackup(config, backup, { actor: 'restore-operator' });
  assert.equal(restored.invalidatedSessions, 1);
  assert.ok(fs.existsSync(restored.previousData));
  store = new AuthStore(config);
  try {
    assert.equal(store.getUser('backup-user').nickname, 'Backup user');
    assert.equal(store.account(auth.accessToken), undefined);
    assert.equal(store.refresh(auth.refreshToken), undefined);
    assert.ok(store.listAudit().some(row => row.action === 'backup_restored_sessions_invalidated' && row.actor === 'restore-operator'));
    const restoredCatalog = new CatalogStore(config, { db: store.db, key: store.key });
    for (const record of published) {
      const historical = restoredCatalog.get(record.kind, record.id, { version: record.version, includeDisabled: true });
      assert.equal(historical.sha256, record.sha256);
      assert.equal(fs.statSync(restoredCatalog.asset(historical.packagePath).absolutePath).size, record.size);
      for (const file of historical.files) assert.equal(restoredCatalog.asset(file.path).sha256, file.sha256);
    }
    assert.equal(restoredCatalog.get('expert', 'backup-expert').version, '1.1.0');
    assert.equal(restoredCatalog.get('connector', 'backup-connector'), undefined);
  } finally { store.close(); }
});

test('restore remains compatible with v1 authentication-only backups', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-backup-v1-')), config = configIn(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new AuthStore(config);
  store.addUser('legacy-user', 'Legacy account', await hashPassword('legacy-backup-password-only'));
  store.close();
  const snapshot = path.join(root, 'snapshot'); await createBackup(config, snapshot);
  const filename = path.join(snapshot, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(filename));
  manifest.version = 1; fs.writeFileSync(filename, JSON.stringify(manifest));
  restoreBackup(config, snapshot);
  const restored = new AuthStore(config);
  try { assert.equal(restored.getUser('legacy-user').nickname, 'Legacy account'); } finally { restored.close(); }
});

test('restore rejects missing, changed and linked catalog objects and unsafe manifest paths before replacing live data', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-backup-catalog-')), config = configIn(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'package-source'); fs.mkdirSync(sourceDir); fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Original private skill\n');
  const auth = new AuthStore(config), catalog = new CatalogStore(config, { db: auth.db, key: auth.key });
  const record = catalog.publish({ kind: 'skill', id: 'protected-skill', name: 'Protected skill', version: '1.0.0', sourceDir });
  const beforeKey = fs.readFileSync(path.join(config.dataDir, 'delivery.key'));
  auth.close();
  const snapshot = path.join(root, 'snapshot'); await createBackup(config, snapshot);
  const manifestFile = path.join(snapshot, 'manifest.json'), originalManifest = JSON.parse(fs.readFileSync(manifestFile));
  const relative = 'content/' + record.packagePath, filename = path.join(snapshot, relative), originalAsset = fs.readFileSync(filename);
  const unchanged = () => {
    assert.deepEqual(fs.readFileSync(path.join(config.dataDir, 'delivery.key')), beforeKey);
    const store = new AuthStore(config);
    try { assert.equal(new CatalogStore(config, { db: store.db, key: store.key }).get('skill', record.id).sha256, record.sha256); } finally { store.close(); }
  };
  fs.writeFileSync(filename, Buffer.alloc(originalAsset.length));
  assert.throws(() => restoreBackup(config, snapshot), /checksum/); unchanged();
  fs.writeFileSync(filename, originalAsset);
  const unsafe = structuredClone(originalManifest); unsafe.files['content/../../delivery.key'] = record.sha256;
  fs.writeFileSync(manifestFile, JSON.stringify(unsafe));
  assert.throws(() => restoreBackup(config, snapshot), /manifest path/); unchanged();
  const missing = structuredClone(originalManifest); delete missing.files[relative];
  fs.writeFileSync(manifestFile, JSON.stringify(missing));
  assert.throws(() => restoreBackup(config, snapshot), /inventory|missing/); unchanged();
  const legacy = structuredClone(originalManifest); legacy.version = 1;
  for (const name of Object.keys(legacy.files)) if (name.startsWith('content/')) delete legacy.files[name];
  fs.writeFileSync(manifestFile, JSON.stringify(legacy));
  assert.throws(() => restoreBackup(config, snapshot), /inventory|missing/); unchanged();
  fs.writeFileSync(manifestFile, JSON.stringify(originalManifest));
  const link = path.join(snapshot, 'object-hardlink'); fs.linkSync(filename, link);
  assert.throws(() => restoreBackup(config, snapshot), /link/); unchanged(); fs.unlinkSync(link);
  fs.unlinkSync(filename); fs.symlinkSync(path.join(config.dataDir, relative), filename);
  assert.throws(() => restoreBackup(config, snapshot), /link/); unchanged(); fs.unlinkSync(filename);
  fs.writeFileSync(filename, originalAsset, { mode: 0o600 });
  const bucket = path.dirname(filename), renamed = bucket + '.real'; fs.renameSync(bucket, renamed); fs.symlinkSync(renamed, bucket);
  assert.throws(() => restoreBackup(config, snapshot), /symlink/); unchanged(); fs.unlinkSync(bucket); fs.renameSync(renamed, bucket);
  fs.unlinkSync(filename);
  assert.throws(() => restoreBackup(config, snapshot), /ENOENT/); unchanged();
});

test('backup refuses broken catalog objects and never publishes a partial snapshot', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-backup-broken-content-')), config = configIn(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source'); fs.mkdirSync(sourceDir); fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Published package\n');
  const auth = new AuthStore(config), catalog = new CatalogStore(config, { db: auth.db, key: auth.key });
  const record = catalog.publish({ kind: 'expert', id: 'broken-expert', name: 'Broken expert', version: '1.0.0', sourceDir });
  const object = catalog.asset(record.packagePath).absolutePath, bytes = fs.readFileSync(object);
  auth.close();
  fs.writeFileSync(object, Buffer.alloc(bytes.length));
  const output = path.join(root, 'snapshot');
  await assert.rejects(createBackup(config, output), /checksum/);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.readdirSync(root).filter(name => name.startsWith('.wb-backup-')).length, 0);
  fs.unlinkSync(object); fs.symlinkSync(path.join(sourceDir, 'SKILL.md'), object);
  await assert.rejects(createBackup(config, output), /link/);
  assert.equal(fs.existsSync(output), false);
});

test('restore refuses corrupt files without touching existing data', async t => {
  const config = testConfig(), parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-corrupt-test-'));
  t.after(() => { fs.rmSync(config.dataDir, { recursive: true, force: true }); fs.rmSync(parent, { recursive: true, force: true }); });
  const store = new AuthStore(config); store.close();
  const snapshot = path.join(parent, 'snapshot');
  await createBackup(config, snapshot);
  const before = fs.readFileSync(path.join(config.dataDir, 'delivery.key'));
  fs.writeFileSync(path.join(snapshot, 'delivery.key'), Buffer.alloc(32));
  assert.throws(() => restoreBackup(config, snapshot), /checksum/);
  assert.deepEqual(fs.readFileSync(path.join(config.dataDir, 'delivery.key')), before);
});
