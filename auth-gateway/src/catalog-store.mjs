import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildTarGz, buildZip, readSourceDirectory } from './package-archive.mjs';

const KINDS = new Set(['expert', 'skill', 'connector']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;
const OBJECT_PATH = /^objects\/[a-f0-9]{2}\/[a-f0-9]{64}\.(?:bin|zip|tar\.gz)$/;

function kindValue(kind) { if (!KINDS.has(kind)) throw new Error('Invalid catalog kind'); return kind; }
function idValue(value, label = 'id') { if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid catalog ' + label); return value; }
function textValue(value, label, max, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error('Invalid catalog ' + label);
  return value.trim();
}
function versionValue(value) { if (typeof value !== 'string' || value.length > 64 || !VERSION.test(value)) throw new Error('Invalid catalog version'); return value; }
function metadataValue(value) {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 10000 || depth > 12) throw new Error('Catalog metadata is too complex');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { for (const nested of item) visit(nested, depth + 1); return; }
    if (typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) throw new Error('Catalog metadata must contain only JSON values');
    if (Object.getOwnPropertySymbols(item).length) throw new Error('Catalog metadata must contain only JSON values');
    for (const key of Object.keys(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid catalog metadata key');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!Object.hasOwn(descriptor, 'value')) throw new Error('Catalog metadata must contain only JSON values');
      visit(descriptor.value, depth + 1);
    }
  };
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('Catalog metadata must be an object');
  visit(value, 0);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 64 * 1024) throw new Error('Catalog metadata exceeds size limit');
  return json;
}
function sha256(data) { return createHash('sha256').update(data).digest('hex'); }
function contentType(name) {
  const extension = path.extname(name).toLowerCase();
  return ({ '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' })[extension] || 'application/octet-stream';
}

export class CatalogStore {
  constructor(config, { db, key, now = Date.now } = {}) {
    if (!db?.prepare || !db?.exec) throw new Error('CatalogStore requires the authentication database');
    if (key !== undefined && (!Buffer.isBuffer(key) || key.length !== 32)) throw new Error('Invalid catalog delivery key');
    this.db = db; this.now = now; this.dataRoot = fs.realpathSync(config.dataDir); this.root = path.resolve(config.dataDir, 'content');
    fs.mkdirSync(this.root, { mode: 0o700, recursive: true });
    if (fs.lstatSync(this.root).isSymbolicLink()) throw new Error('Catalog content directory must not be a symlink');
    this.root = fs.realpathSync(this.root);
    this.db.exec('CREATE TABLE IF NOT EXISTS catalog_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)');
    const schema = this.db.prepare('SELECT version FROM catalog_schema WHERE id=1').get();
    if (schema && schema.version !== 1) throw new Error('Unsupported catalog schema version');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_entries (
        kind TEXT NOT NULL CHECK(kind IN ('expert','skill','connector')), id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), updated_at INTEGER NOT NULL,
        PRIMARY KEY(kind,id)
      );
      CREATE TABLE IF NOT EXISTS catalog_assets (
        path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0), content_type TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalog_versions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL,
        name TEXT NOT NULL, description TEXT NOT NULL, category_id TEXT NOT NULL, tags TEXT NOT NULL,
        metadata TEXT NOT NULL, package_path TEXT NOT NULL REFERENCES catalog_assets(path), published_at INTEGER NOT NULL,
        UNIQUE(kind,id,version), FOREIGN KEY(kind,id) REFERENCES catalog_entries(kind,id)
      );
      CREATE TABLE IF NOT EXISTS catalog_version_files (
        version_sequence INTEGER NOT NULL REFERENCES catalog_versions(sequence), name TEXT NOT NULL,
        asset_path TEXT NOT NULL REFERENCES catalog_assets(path), PRIMARY KEY(version_sequence,name)
      );
      CREATE INDEX IF NOT EXISTS catalog_latest ON catalog_versions(kind,id,sequence DESC);
      INSERT OR IGNORE INTO catalog_schema(id,version) VALUES(1,1);
    `);
  }

  list(kind, { keyword, categoryId, enabledOnly = true } = {}) {
    kindValue(kind);
    if (typeof enabledOnly !== 'boolean') throw new Error('Invalid catalog enabled filter');
    if (keyword !== undefined) keyword = textValue(keyword, 'keyword', 256, { empty: true }).toLocaleLowerCase();
    if (categoryId !== undefined) idValue(categoryId, 'category');
    return this.db.prepare(`SELECT v.*,e.enabled,e.updated_at,a.sha256,a.size FROM catalog_versions v
      JOIN catalog_entries e ON e.kind=v.kind AND e.id=v.id JOIN catalog_assets a ON a.path=v.package_path
      WHERE v.kind=? AND v.sequence=(SELECT MAX(latest.sequence) FROM catalog_versions latest WHERE latest.kind=v.kind AND latest.id=v.id)
      ${enabledOnly ? 'AND e.enabled=1' : ''} ORDER BY v.sequence DESC`).all(kind)
      .map(row => this.record(row)).filter(record => (!categoryId || record.categoryId === categoryId)
        && (!keyword || [record.name, record.description, ...record.tags].join(' ').toLocaleLowerCase().includes(keyword)));
  }

  get(kind, id, { version, includeDisabled = false } = {}) {
    kindValue(kind); idValue(id);
    if (version !== undefined) versionValue(version);
    if (typeof includeDisabled !== 'boolean') throw new Error('Invalid catalog disabled filter');
    const row = this.db.prepare(`SELECT v.*,e.enabled,e.updated_at,a.sha256,a.size FROM catalog_versions v
      JOIN catalog_entries e ON e.kind=v.kind AND e.id=v.id JOIN catalog_assets a ON a.path=v.package_path
      WHERE v.kind=? AND v.id=? ${version !== undefined ? 'AND v.version=?' : ''} ${includeDisabled ? '' : 'AND e.enabled=1'}
      ORDER BY v.sequence DESC LIMIT 1`).get(...[kind, id, ...(version === undefined ? [] : [version])]);
    return row ? this.record(row) : undefined;
  }

  record(row) {
    return { kind: row.kind, id: row.id, name: row.name, description: row.description, version: row.version,
      categoryId: row.category_id, tags: JSON.parse(row.tags), metadata: JSON.parse(row.metadata), enabled: !!row.enabled,
      publishedAt: row.published_at, updatedAt: row.updated_at, packagePath: row.package_path, sha256: row.sha256, size: row.size,
      files: this.db.prepare('SELECT f.name,a.path,a.sha256,a.size,a.content_type FROM catalog_version_files f JOIN catalog_assets a ON a.path=f.asset_path WHERE f.version_sequence=? ORDER BY f.name').all(row.sequence)
        .map(file => ({ name: file.name, path: file.path, sha256: file.sha256, size: file.size, contentType: file.content_type })) };
  }

  categories(kind) {
    const categories = new Map();
    for (const entry of this.list(kind)) {
      const category = categories.get(entry.categoryId) || { id: entry.categoryId, name: typeof entry.metadata.categoryName === 'string' ? entry.metadata.categoryName : entry.categoryId, count: 0 };
      category.count++; categories.set(entry.categoryId, category);
    }
    return [...categories.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  publish({ kind, id, name, description = '', version, categoryId = 'general', tags = [], metadata = {}, sourceDir }) {
    kindValue(kind); idValue(id); versionValue(version); idValue(categoryId, 'category');
    name = textValue(name, 'name', 256); description = textValue(description, 'description', 8192, { empty: true });
    if (!Array.isArray(tags) || tags.length > 32) throw new Error('Invalid catalog tags');
    tags = [...new Set(tags.map(tag => textValue(tag, 'tag', 64)))];
    const metadataJson = metadataValue(metadata);
    if (metadata.public !== undefined && typeof metadata.public !== 'boolean') throw new Error('Catalog public visibility must be boolean');
    if (metadata.allowedUsers !== undefined && (!Array.isArray(metadata.allowedUsers) || metadata.allowedUsers.length > 1000 || metadata.allowedUsers.some(user => typeof user !== 'string' || !user || user.length > 128))) throw new Error('Invalid catalog user visibility');
    if (metadata.public === true && metadata.allowedUsers !== undefined) throw new Error('Public content cannot also have a user access list');
    if (typeof sourceDir !== 'string' || !path.isAbsolute(sourceDir)) throw new Error('Package source must be an absolute directory path');
    const sourceRoot = fs.realpathSync(sourceDir);
    if (sourceRoot === this.dataRoot || sourceRoot.startsWith(this.dataRoot + path.sep) || this.dataRoot.startsWith(sourceRoot + path.sep)) throw new Error('Package source overlaps authentication data');
    if (this.db.prepare('SELECT 1 FROM catalog_versions WHERE kind=? AND id=? AND version=?').get(kind, id, version)) throw new Error('Catalog version already exists; publish a new version');
    const entries = readSourceDirectory(sourceDir);
    const archive = kind === 'expert' ? buildTarGz(entries) : buildZip(entries);
    const files = entries.map(entry => ({ name: entry.name, ...this.writeObject(entry.data, 'bin', contentType(entry.name)) }));
    const bundle = this.writeObject(archive, kind === 'expert' ? 'tar.gz' : 'zip', kind === 'expert' ? 'application/gzip' : 'application/zip');
    const publishedAt = this.now();
    if (!Number.isSafeInteger(publishedAt) || publishedAt < 0) throw new Error('Invalid catalog clock');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO catalog_entries(kind,id,enabled,updated_at) VALUES(?,?,1,?) ON CONFLICT(kind,id) DO UPDATE SET updated_at=excluded.updated_at').run(kind, id, publishedAt);
      for (const asset of [...files, bundle]) {
        this.db.prepare('INSERT OR IGNORE INTO catalog_assets(path,sha256,size,content_type) VALUES(?,?,?,?)').run(asset.path, asset.sha256, asset.size, asset.contentType);
      }
      const result = this.db.prepare('INSERT INTO catalog_versions(kind,id,version,name,description,category_id,tags,metadata,package_path,published_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(kind, id, version, name, description, categoryId, JSON.stringify(tags), metadataJson, bundle.path, publishedAt);
      for (const file of files) this.db.prepare('INSERT INTO catalog_version_files(version_sequence,name,asset_path) VALUES(?,?,?)').run(result.lastInsertRowid, file.name, file.path);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(kind, id, { version, includeDisabled: true });
  }

  setEnabled(kind, id, enabled) {
    kindValue(kind); idValue(id);
    if (typeof enabled !== 'boolean') throw new Error('Catalog enabled must be boolean');
    const result = this.db.prepare('UPDATE catalog_entries SET enabled=?,updated_at=? WHERE kind=? AND id=?').run(enabled ? 1 : 0, this.now(), kind, id);
    if (!result.changes) throw new Error('Catalog entry does not exist');
    return this.get(kind, id, { includeDisabled: true });
  }

  inventory() {
    return this.db.prepare('SELECT path,sha256,size,content_type FROM catalog_assets ORDER BY path').all()
      .map(row => ({ path: row.path, sha256: row.sha256, size: row.size, contentType: row.content_type }));
  }

  asset(relativePath) {
    if (typeof relativePath !== 'string' || !OBJECT_PATH.test(relativePath)) return undefined;
    const row = this.db.prepare('SELECT * FROM catalog_assets WHERE path=?').get(relativePath);
    if (!row) return undefined;
    const absolutePath = path.join(this.root, relativePath);
    this.validateObject(absolutePath, row.size, row.sha256);
    return { absolutePath, size: row.size, sha256: row.sha256, contentType: row.content_type };
  }

  validateObject(filename, size, digest) {
    const info = fs.lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== size
      || !fs.realpathSync(filename).startsWith(this.root + path.sep) || sha256(fs.readFileSync(filename)) !== digest) throw new Error('Catalog object failed integrity verification');
    const directory = path.dirname(filename);
    if (fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(path.dirname(directory)).isSymbolicLink()) throw new Error('Catalog object directories must not be symlinks');
  }

  writeObject(data, extension, type) {
    const digest = sha256(data), relativePath = 'objects/' + digest.slice(0, 2) + '/' + digest + '.' + extension;
    const filename = path.join(this.root, relativePath), directory = path.dirname(filename);
    for (const folder of [path.join(this.root, 'objects'), directory]) {
      const existed = fs.existsSync(folder);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(folder).isSymbolicLink() || !fs.lstatSync(folder).isDirectory()) throw new Error('Catalog object directories must not be symlinks');
      if (!existed) {
        const parentDescriptor = fs.openSync(path.dirname(folder), fs.constants.O_RDONLY);
        try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
      }
    }
    const temporary = path.join(directory, '.publish-' + randomUUID());
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    try {
      try { fs.linkSync(temporary, filename); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { fs.unlinkSync(temporary); }
    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    this.validateObject(filename, data.length, digest);
    return { path: relativePath, sha256: digest, size: data.length, contentType: type };
  }
}
