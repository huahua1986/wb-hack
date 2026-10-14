import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AuthStore } from '../src/store.mjs';
import { CatalogStore } from '../src/catalog-store.mjs';
import { readConfig } from '../src/config.mjs';
import { adminContext } from '../src/admin-context.mjs';

const USAGE = 'Usage: catalog publish --manifest <file> | list <expert|skill|connector> [--all] | show <kind> <id> [--version <version>] | enable|disable <kind> <id> [--data-dir <path>]';

export function readCatalogManifest(filename) {
  const resolved = path.resolve(filename), info = fs.lstatSync(resolved);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error('Manifest must be an ordinary JSON file up to 128 KiB');
  const manifest = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid catalog manifest');
  const allowed = new Set(['kind', 'id', 'name', 'description', 'version', 'categoryId', 'tags', 'metadata', 'sourceDir']);
  if (Object.keys(manifest).some(key => !allowed.has(key))) throw new Error('Unknown catalog manifest field');
  const source = manifest.sourceDir;
  if (typeof source !== 'string' || !source || path.isAbsolute(source) || source.includes('\\') || source.split('/').includes('..') || /^[A-Za-z]:/.test(source)) {
    throw new Error('Manifest sourceDir must be relative to the manifest without parent traversal');
  }
  return { ...manifest, sourceDir: path.resolve(path.dirname(resolved), source) };
}

export async function runCatalog(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  process.umask(0o077);
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    'data-dir': { type: 'string' }, manifest: { type: 'string' }, version: { type: 'string' }, all: { type: 'boolean' },
  } });
  const [command, kind, id] = positionals;
  if (!['publish', 'list', 'show', 'enable', 'disable'].includes(command)
    || positionals.length !== (command === 'publish' ? 1 : command === 'list' ? 2 : 3)
    || (command === 'publish') !== (values.manifest !== undefined)
    || (values.version !== undefined && command !== 'show') || (values.all && command !== 'list')) throw new Error(USAGE);
  const config = readConfig({ ...process.env, ...(values['data-dir'] ? { GATEWAY_DATA_DIR: values['data-dir'] } : {}) });
  const auth = new AuthStore(config);
  try {
    const catalog = new CatalogStore(config, { db: auth.db, key: auth.key });
    const output = value => stdout.write(JSON.stringify(value) + '\n');
    if (command === 'publish') {
      const record = catalog.publish(readCatalogManifest(values.manifest));
      auth.audit('catalog_publish:' + record.kind + ':' + record.id + ':' + record.version, null, null, adminContext());
      output({ kind: record.kind, id: record.id, version: record.version, enabled: record.enabled, sha256: record.sha256, size: record.size, packagePath: record.packagePath });
    } else if (command === 'list') {
      for (const record of catalog.list(kind, { enabledOnly: !values.all })) output({ kind: record.kind, id: record.id, name: record.name, version: record.version, enabled: record.enabled, categoryId: record.categoryId });
    } else if (command === 'show') {
      const record = catalog.get(kind, id, { version: values.version, includeDisabled: true });
      if (!record) throw new Error('Catalog entry does not exist');
      // Describe the published object inventory without dumping publisher-supplied metadata or package contents.
      const { metadata, ...safe } = record; output(safe);
    } else {
      const record = catalog.setEnabled(kind, id, command === 'enable');
      auth.audit('catalog_' + command + ':' + record.kind + ':' + record.id, null, null, adminContext());
      output({ kind: record.kind, id: record.id, version: record.version, enabled: record.enabled });
    }
  } finally { auth.close(); }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCatalog().catch(error => { console.error(error.message); process.exitCode = 1; });
}
