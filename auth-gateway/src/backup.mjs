import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { AuthStore } from './store.mjs';
import { serverRunning } from './server-lock.mjs';

const digest = filename => {
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
};
function separate(source, output) {
  if (output === source || output.startsWith(source + path.sep) || source.startsWith(output + path.sep)) throw new Error('Backup and data directories must be separate');
}

const OBJECT_PATH = /^objects\/[a-f0-9]{2}\/[a-f0-9]{64}\.(?:bin|zip|tar\.gz)$/;
const AUTH_FILES = ['gateway.sqlite', 'delivery.key'];
function safeFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || relative.startsWith('/')
    || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid backup file path');
  const parts = relative.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Backup directories must not be symlinks');
  }
  const absolute = path.join(current, parts.at(-1)), info = fs.lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !fs.realpathSync(absolute).startsWith(root + path.sep)) throw new Error('Invalid backup file or link');
  return { absolute, info };
}

function catalogInventory(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_assets'").get()) {
    for (const table of ['catalog_versions', 'catalog_version_files']) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new Error('Catalog database references missing asset inventory');
    }
    return [];
  }
  const assets = db.prepare('SELECT path,sha256,size FROM catalog_assets ORDER BY path').all();
  const known = new Set();
  for (const asset of assets) {
    if (typeof asset.path !== 'string' || !OBJECT_PATH.test(asset.path) || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !Number.isSafeInteger(asset.size) || asset.size < 0 || known.has(asset.path)
      || asset.path.split('/')[1] !== asset.sha256.slice(0, 2) || !asset.path.split('/')[2].startsWith(asset.sha256 + '.')) throw new Error('Invalid catalog asset inventory');
    known.add(asset.path);
  }
  for (const [table, column] of [['catalog_versions', 'package_path'], ['catalog_version_files', 'asset_path']]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    for (const row of db.prepare(`SELECT DISTINCT ${column} AS path FROM ${table}`).all()) {
      if (!known.has(row.path)) throw new Error('Catalog database references an unregistered asset');
    }
  }
  return assets;
}

function copyVerified(root, relative, destination, checksum, expectedSize) {
  const { absolute, info } = safeFile(root, relative);
  if (expectedSize !== undefined && info.size !== expectedSize) throw new Error('Backup asset size mismatch');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const input = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let output;
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  try {
    output = fs.openSync(destination, 'wx', 0o600);
    const opened = fs.fstatSync(input);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new Error('Backup source changed during copy');
    let count;
    while ((count = fs.readSync(input, buffer, 0, buffer.length, null))) {
      hash.update(buffer.subarray(0, count));
      let offset = 0;
      while (offset < count) offset += fs.writeSync(output, buffer, offset, count - offset);
    }
    const after = fs.fstatSync(input);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('Backup source changed during copy');
    if (hash.digest('hex') !== checksum) throw new Error('Backup checksum mismatch');
    fs.fsyncSync(output);
  } finally { fs.closeSync(input); if (output !== undefined) fs.closeSync(output); }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.kind !== 'workbuddy-auth-backup' || ![1, 2].includes(manifest.version) || manifest.schema !== 2
    || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('Unsupported backup format');
  for (const [relative, checksum] of Object.entries(manifest.files)) {
    if (!(AUTH_FILES.includes(relative) || (manifest.version === 2 && relative.startsWith('content/') && OBJECT_PATH.test(relative.slice(8))))
      || typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Invalid backup manifest path or checksum');
  }
  for (const relative of AUTH_FILES) if (!Object.hasOwn(manifest.files, relative)) throw new Error('Backup manifest is missing an authentication file');
}

export async function createBackup(config, output) {
  if (fs.lstatSync(config.dataDir).isSymbolicLink()) throw new Error('Data directory must not be a symlink');
  const destination = path.resolve(output), dataDir = fs.realpathSync(config.dataDir);
  separate(dataDir, destination);
  if (fs.existsSync(destination)) throw new Error('Backup output already exists');
  if (!fs.existsSync(path.join(dataDir, 'gateway.sqlite')) || !fs.existsSync(path.join(dataDir, 'delivery.key'))) throw new Error('No existing authentication database/key to back up');
  for (const name of AUTH_FILES) safeFile(dataDir, name);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const parent = fs.realpathSync(path.dirname(destination));
  separate(dataDir, path.join(parent, path.basename(destination)));
  const store = new AuthStore(config);
  const stage = fs.mkdtempSync(path.join(parent, '.wb-backup-'));
  fs.chmodSync(stage, 0o700);
  try {
    await backup(store.db, path.join(stage, 'gateway.sqlite'));
    copyVerified(dataDir, 'delivery.key', path.join(stage, 'delivery.key'), createHash('sha256').update(store.key).digest('hex'), 32);
    const files = {};
    for (const name of AUTH_FILES) { fs.chmodSync(path.join(stage, name), 0o600); files[name] = digest(path.join(stage, name)); }
    const snapshot = new DatabaseSync(path.join(stage, 'gateway.sqlite'), { readOnly: true });
    try {
      for (const asset of catalogInventory(snapshot)) {
        const relative = 'content/' + asset.path;
        copyVerified(dataDir, relative, path.join(stage, relative), asset.sha256, asset.size);
        files[relative] = asset.sha256;
      }
    } finally { snapshot.close(); }
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ kind: 'workbuddy-auth-backup', version: 2, schema: 2, createdAt: new Date().toISOString(), files }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(stage, destination);
    return { backup: destination, schema: 2 };
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
  finally { store.close(); }
}

export function restoreBackup(config, input, { actor = 'system' } = {}) {
  if (serverRunning(config.dataDir)) throw new Error('Stop the authentication server before restoring');
  if (fs.lstatSync(input).isSymbolicLink()) throw new Error('Backup directory must not be a symlink');
  const source = fs.realpathSync(input), destination = path.resolve(config.dataDir);
  separate(source, destination);
  for (const name of ['manifest.json', ...AUTH_FILES]) safeFile(source, name);
  if (fs.statSync(path.join(source, 'manifest.json')).size > 32 * 1024 * 1024) throw new Error('Backup manifest exceeds size limit');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  validateManifest(manifest);
  for (const name of AUTH_FILES) if (manifest.files[name] !== digest(path.join(source, name))) throw new Error('Backup checksum mismatch');
  if (fs.statSync(path.join(source, 'delivery.key')).size !== 32) throw new Error('Invalid backup key');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  separate(source, path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination)));
  const stage = fs.mkdtempSync(path.join(path.dirname(destination), '.wb-restore-'));
  fs.chmodSync(stage, 0o700);
  let oldDirectory;
  try {
    for (const name of AUTH_FILES) copyVerified(source, name, path.join(stage, name), manifest.files[name]);
    const check = new DatabaseSync(path.join(stage, 'gateway.sqlite'), { readOnly: true });
    try {
      if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || check.prepare('PRAGMA user_version').get().user_version !== 2
        || check.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Invalid backup database');
      const assets = catalogInventory(check), expected = new Set([...AUTH_FILES, ...assets.map(asset => 'content/' + asset.path)]);
      if (Object.keys(manifest.files).length !== expected.size || Object.keys(manifest.files).some(relative => !expected.has(relative))) throw new Error('Backup manifest does not match catalog inventory');
      for (const asset of assets) {
        const relative = 'content/' + asset.path;
        if (manifest.version !== 2 || manifest.files[relative] !== asset.sha256) throw new Error('Backup is missing a catalog asset');
        copyVerified(source, relative, path.join(stage, relative), asset.sha256, asset.size);
      }
    } finally { check.close(); }
    const store = new AuthStore({ ...config, dataDir: stage });
    let invalidatedSessions;
    try {
      store.transaction(() => {
        invalidatedSessions = store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
        store.db.exec('DELETE FROM login_states; DELETE FROM access_tokens; DELETE FROM sessions;');
        store.audit('backup_restored_sessions_invalidated', null, null, { actor });
      });
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { store.close(); }
    if (fs.existsSync(destination)) {
      if (fs.lstatSync(destination).isSymbolicLink()) throw new Error('Data directory must not be a symlink');
      oldDirectory = destination + '.before-restore-' + randomUUID();
      fs.renameSync(destination, oldDirectory);
    }
    try { fs.renameSync(stage, destination); }
    catch (error) { if (oldDirectory) fs.renameSync(oldDirectory, destination); throw error; }
    return { restored: destination, invalidatedSessions, previousData: oldDirectory || null };
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
}
