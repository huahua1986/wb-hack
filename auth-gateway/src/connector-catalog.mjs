import { createHash } from 'node:crypto';
import { validatePublicUrl } from './config.mjs';
import { PACKAGE_LIMITS, validatePackageName } from './package-archive.mjs';

export const CONNECTOR_MARKETPLACE_NAME = 'workbuddy-connector-plugins-official';
export const CONNECTOR_CATALOG_PATH = '/connector-agent-plugins/connector-plugins.zip';
const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
export const CONNECTOR_CATALOG_MAX_BYTES = 64 * 1024 * 1024;
const NAME = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const MANIFEST_PATHS = ['plugin.json', '.codebuddy-plugin/plugin.json', '.workbuddy-plugin/plugin.json', '.claude-plugin/plugin.json'];

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function json(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (object(value)) return value;
  } catch { /* Return a bounded validation error, without package contents. */ }
  throw new Error(`Invalid connector ${label}`);
}
function safeName(value) {
  if (typeof value !== 'string' || !NAME.test(value) || value.includes('..') || value.includes('--')) throw new Error('Invalid connector plugin name');
  return value;
}
function safePath(value) {
  return validatePackageName(value);
}
function packageRoot(names) {
  // Native packages may have one enclosing directory, but never guess among
  // multiple plugins. Preserve the package's own relative resource layout.
  const candidates = names.filter(name => MANIFEST_PATHS.some(candidate => name === candidate || name.endsWith(`/${candidate}`)));
  const roots = new Set(candidates.map(name => {
    const suffix = [...MANIFEST_PATHS].sort((a, b) => b.length - a.length).find(candidate => name === candidate || name.endsWith(`/${candidate}`));
    return name.slice(0, -suffix.length);
  }));
  if (roots.size !== 1) throw new Error('Connector package must contain exactly one plugin root');
  return [...roots][0];
}

async function packageEntries(record, readAsset, budget) {
  const files = record.files;
  if (!Array.isArray(files) || !files.length) throw new Error(`Connector ${record.id} has no package files`);
  const names = files.map(file => safePath(file.name));
  if (new Set(names).size !== names.length) throw new Error(`Connector ${record.id} has duplicate package files`);
  const prefix = packageRoot(names);
  if (names.some(name => !name.startsWith(prefix))) throw new Error(`Connector ${record.id} has files outside its plugin root`);
  const entries = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (typeof file.path !== 'string' || !file.path) throw new Error(`Connector ${record.id} is missing an immutable asset path`);
    if (++budget.files > PACKAGE_LIMITS.maxFiles || file.size > PACKAGE_LIMITS.maxFileBytes || budget.bytes + file.size > CONNECTOR_CATALOG_MAX_BYTES) throw new Error('Connector catalog exceeds package limits');
    const name = safePath(names[i].slice(prefix.length));
    const data = Buffer.from(await readAsset(file.path));
    budget.bytes += data.length;
    if (data.length > PACKAGE_LIMITS.maxFileBytes || budget.bytes > CONNECTOR_CATALOG_MAX_BYTES) throw new Error('Connector catalog exceeds package limits');
    if (file.size !== undefined && data.length !== file.size) throw new Error(`Connector ${record.id} asset size mismatch`);
    if (file.sha256 && createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error(`Connector ${record.id} asset checksum mismatch`);
    entries.push({ name, data });
  }
  const map = new Map(entries.map(entry => [entry.name, entry.data]));
  const manifestPath = MANIFEST_PATHS.find(name => map.has(name));
  const plugin = json(map.get(manifestPath), 'plugin.json');
  if (safeName(plugin.name) !== record.id) throw new Error(`Connector ${record.id} package name does not match catalog id`);
  if (typeof plugin.version !== 'string' || !plugin.version || plugin.version !== record.version) throw new Error(`Connector ${record.id} package version does not match catalog version`);
  if (manifestPath === 'plugin.json' && plugin.$schema !== PLUGIN_SCHEMA) throw new Error(`Connector ${record.id} root plugin.json has an unsupported schema`);
  if (plugin.$schema === PLUGIN_SCHEMA) {
    const extension = plugin.extensions?.['ai.workbuddy'];
    if (extension && (!object(extension) || extension.schemaVersion !== undefined && extension.schemaVersion !== '1.0.0')) throw new Error(`Connector ${record.id} has an unsupported ai.workbuddy schema`);
    if (map.has('mcp.json')) {
      const mcp = json(map.get('mcp.json'), 'mcp.json');
      if (mcp.$schema !== MCP_SCHEMA || !object(mcp.mcpServers) || Object.keys(mcp).some(key => !['$schema', 'mcpServers'].includes(key))) throw new Error(`Connector ${record.id} has an unsupported mcp.json schema`);
    }
  } else if (plugin.$schema !== undefined) {
    throw new Error(`Connector ${record.id} has an unsupported plugin.json schema`);
  }
  // Keep plugin.json, mcp.json, ai.workbuddy setup/policy, scripts and skills
  // byte-for-byte intact; the native loader is their protocol authority.
  return { plugin, entries };
}

/** Build a native legacy marketplace archive from explicitly public records. */
export async function buildConnectorMarketplace({ records, version, publicUrl, readAsset, buildZip }) {
  if (!Array.isArray(records) || typeof readAsset !== 'function' || typeof buildZip !== 'function') throw new TypeError('Connector catalog requires records, readAsset and buildZip');
  const origin = validatePublicUrl(publicUrl);
  const catalogVersion = String(version ?? '1');
  if (!catalogVersion || catalogVersion.length > 128 || /[\x00-\x1f\x7f]/.test(catalogVersion)) throw new Error('Invalid connector catalog version');
  const selected = records.filter(record => record.kind === 'connector' && record.enabled !== false && record.metadata?.public === true
    && !Object.hasOwn(record, 'allowedUsers') && !Object.hasOwn(record.metadata, 'allowedUsers'))
    .slice().sort((a, b) => String(a.id).localeCompare(String(b.id), 'en'));
  const ids = selected.map(record => safeName(record.id));
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate connector catalog id');
  const plugins = selected.map(record => {
    if (typeof record.version !== 'string' || !record.version || /[\x00-\x1f\x7f]/.test(record.version)) throw new Error(`Connector ${record.id} has an invalid version`);
    if (record.description !== undefined && typeof record.description !== 'string') throw new Error(`Connector ${record.id} has an invalid description`);
    return { name: record.id, source: `./connectors/${record.id}`, version: record.version, description: record.description || '' };
  });
  const manifest = { name: CONNECTOR_MARKETPLACE_NAME, description: 'Private WorkBuddy connector catalog', version: catalogVersion, plugins };
  const manifestEntry = { name: '.codebuddy-plugin/marketplace.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) };
  // Check the complete inventory before reading any immutable objects. A set
  // of individually valid packages can exceed the aggregate download budget.
  let fileCount = 1, zipBytes = 22 + 76 + Buffer.byteLength(manifestEntry.name) * 2 + manifestEntry.data.length;
  for (const record of selected) {
    if (!Array.isArray(record.files) || !record.files.length) throw new Error(`Connector ${record.id} has no package files`);
    const names = record.files.map(file => safePath(file.name));
    const prefix = packageRoot(names);
    if (new Set(names).size !== names.length || names.some(name => !name.startsWith(prefix))) throw new Error(`Connector ${record.id} has invalid package paths`);
    for (const file of record.files) {
      if (typeof file.path !== 'string' || !file.path || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > PACKAGE_LIMITS.maxFileBytes) throw new Error(`Connector ${record.id} has invalid asset metadata`);
      const name = safePath(`connectors/${record.id}/${file.name.slice(prefix.length)}`);
      zipBytes += 76 + Buffer.byteLength(name) * 2 + file.size;
      if (++fileCount > PACKAGE_LIMITS.maxFiles || zipBytes > CONNECTOR_CATALOG_MAX_BYTES) throw new Error('Connector catalog exceeds package limits');
    }
  }
  const entries = [manifestEntry], budget = { files: 1, bytes: manifestEntry.data.length };
  for (const record of selected) {
    const { entries: files } = await packageEntries(record, readAsset, budget);
    entries.push(...files.map(file => ({ name: `connectors/${record.id}/${file.name}`, data: file.data })));
  }
  const buffer = Buffer.from(await buildZip(entries));
  if (buffer.length > CONNECTOR_CATALOG_MAX_BYTES) throw new Error('Connector catalog exceeds package limits');
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  return { buffer, sha256, size: buffer.length, etag: `"${sha256}"`, contentType: 'application/zip', filename: 'connector-plugins.zip', url: `${origin}${CONNECTOR_CATALOG_PATH}`, manifest, recordIds: ids };
}
