import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, X509Certificate } from 'node:crypto';
import { localProductOverlay } from './compatibility.mjs';
import { validatePublicUrl } from './config.mjs';
import { CONNECTOR_CATALOG_PATH, CONNECTOR_MARKETPLACE_NAME } from './connector-catalog.mjs';

const CONNECTOR_OWNER_KEY = '_workbuddyPrivateConnectorSource';
const CONNECTOR_OWNER_KIND = 'workbuddy-private-connector-source';
const CONNECTOR_URL_FIELDS = ['connectorPluginMarketplaceUrl', 'connectorPluginMarketplaceInternalUrl'];

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function readObject(filename, label) {
  try { const value = JSON.parse(fs.readFileSync(filename, 'utf8')); if (object(value)) return value; }
  catch { /* Never include configuration contents in an error. */ }
  throw new Error(`${label} is not a valid JSON object`);
}
function rejectLink(filename, label = 'Connector catalog configuration') {
  try { if (fs.lstatSync(filename).isSymbolicLink()) throw new Error(`${label} contains a symbolic link`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function prepareClientCaBundle(profile) {
  if (!profile.caCertificate) return;
  rejectLink(profile.configDir, 'Certificate bundle directory');
  const filename = path.join(profile.configDir, 'system-ca-bundle.pem');
  rejectLink(filename, 'Certificate bundle');
  const certificate = new X509Certificate(fs.readFileSync(profile.caCertificate));
  let previous = '';
  if (fs.existsSync(filename)) {
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('Certificate bundle must be an ordinary bounded PEM file');
    previous = fs.readFileSync(filename, 'utf8');
    const entries = previous.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
    if (!entries.length) throw new Error('Existing certificate bundle contains no PEM certificates');
    if (entries.some(pem => new X509Certificate(pem).fingerprint256 === certificate.fingerprint256)) return filename;
  }
  // The original daemon drops inherited NODE_EXTRA_CA_CERTS and reads this
  // profile cache instead. Preserve every existing certificate when adding CA.
  fs.mkdirSync(profile.configDir, { recursive: true, mode: 0o700 });
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, previous + (previous && !previous.endsWith('\n') ? '\n' : '') + certificate.toString(), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, filename);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return filename;
}

export function prepareManagedConnectorSource(profile) {
  const gateway = validatePublicUrl(profile.gateway);
  const directory = path.join(path.resolve(profile.configDir), 'connectors');
  const filename = path.join(directory, 'connector-marketplace.json');
  rejectLink(profile.configDir); rejectLink(directory); rejectLink(filename);
  const previous = fs.existsSync(filename) ? readObject(filename, 'Connector catalog configuration') : {};
  if (fs.existsSync(filename)) {
    const owner = previous[CONNECTOR_OWNER_KEY];
    if (owner?.kind !== CONNECTOR_OWNER_KIND || owner.version !== 1 || !object(owner.fields)) throw new Error('Existing connector catalog override is not owned by this launcher; preserve it and resolve the source conflict explicitly');
    for (const field of CONNECTOR_URL_FIELDS) {
      if (typeof owner.fields[field] !== 'string' || previous[field] !== owner.fields[field]) throw new Error(`Managed connector source field ${field} was changed externally; resolve the source conflict explicitly`);
    }
  }
  const url = `${gateway}${CONNECTOR_CATALOG_PATH}`;
  const fields = Object.fromEntries(CONNECTOR_URL_FIELDS.map(field => [field, url]));
  const next = { ...previous, ...fields, [CONNECTOR_OWNER_KEY]: { kind: CONNECTOR_OWNER_KIND, version: 1, fields } };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, filename);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { filename, url, sourceKey: `${CONNECTOR_MARKETPLACE_NAME}\n${url}` };
}

// The native loader first reads cached entries and updates them asynchronously.
// This check proves source adoption; it does not claim a connector is installed.
export function inspectConnectorCatalogSource(profile, { expectedSha256 } = {}) {
  const url = `${validatePublicUrl(profile.gateway)}${CONNECTOR_CATALOG_PATH}`;
  const metadataPath = path.join(profile.configDir, 'connectors', 'marketplace-meta', `${CONNECTOR_MARKETPLACE_NAME}.json`);
  const marketplaceDir = path.join(profile.configDir, 'plugins', 'marketplaces', CONNECTOR_MARKETPLACE_NAME);
  const manifestPath = path.join(marketplaceDir, '.codebuddy-plugin', 'marketplace.json');
  let metadata;
  try { metadata = readObject(metadataPath, 'Native connector catalog metadata'); }
  catch { return { adopted: false, reason: 'metadata-missing-or-invalid', metadataPath, marketplaceDir, manifestPath }; }
  let manifest;
  try { manifest = readObject(manifestPath, 'Native connector catalog manifest'); } catch { /* Native download has not completed or the cache is absent. */ }
  const validCatalog = manifest?.name === CONNECTOR_MARKETPLACE_NAME && Array.isArray(manifest.plugins);
  const sourceMatches = metadata.sourceKey === `${CONNECTOR_MARKETPLACE_NAME}\n${url}`;
  const validHash = typeof metadata.sha256 === 'string' && /^[a-f0-9]{64}$/.test(metadata.sha256);
  const hashMatches = expectedSha256 === undefined || metadata.sha256 === expectedSha256;
  return { adopted: sourceMatches && validHash && hashMatches && validCatalog, reason: !sourceMatches ? 'source-mismatch' : !validHash ? 'hash-missing-or-invalid' : !hashMatches ? 'hash-mismatch' : !validCatalog ? 'catalog-missing-or-invalid' : 'source-matched', metadataPath, marketplaceDir, manifestPath, sha256: validHash ? metadata.sha256 : undefined, etag: metadata.etag, catalogVersion: validCatalog ? manifest.version : undefined, catalogPluginCount: validCatalog ? manifest.plugins.length : undefined };
}

export { inspectConnectorCatalogSource as verifyConnectorCatalogSource };

export function buildClientProduct(baseProduct, gateway) {
  const overlay = localProductOverlay(validatePublicUrl(gateway));
  return {
    ...structuredClone(baseProduct), ...overlay,
    mergeStrategy: 'override',
    config: { ...baseProduct.config, ...overlay.config },
    productFeatures: { ...baseProduct.productFeatures, ...overlay.productFeatures },
    // Default entries remain inert compatibility objects; they are not served
    // by the auth gateway. Select an enabled custom model in WorkBuddy.
    models: (baseProduct.models || []).map(model => ({ ...model, disabled: true })),
  };
}

export function prepareClientProfile({ baseProduct, gateway, profileDir, executable, mode = 'development' }) {
  gateway = validatePublicUrl(gateway);
  if (!['development', 'production'].includes(mode)) throw new Error('Invalid client mode');
  const directory = path.resolve(profileDir);
  rejectLink(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const productPath = path.join(directory, 'product.local.json');
  const profilePath = path.join(directory, 'launch.json');
  if (fs.existsSync(productPath) || fs.existsSync(profilePath)) throw new Error('Profile already exists; choose a new directory');
  const profile = { version: 1, gateway, configDir: path.join(directory, 'config'), userDataDir: path.join(directory, 'user-data'), productPath, executable: path.resolve(executable), mode };
  prepareManagedConnectorSource(profile);
  fs.writeFileSync(productPath, `${JSON.stringify(buildClientProduct(baseProduct, gateway), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return profilePath;
}

export function clientEnvironment(profile, parent = process.env) {
  validatePublicUrl(profile.gateway);
  if (!['development', 'production'].includes(profile.mode)) throw new Error('Invalid client mode');
  const env = { ...parent,
    NODE_ENV: profile.mode,
    WORKBUDDY_DEV_ENDPOINT_OVERRIDE: profile.gateway,
    WORKBUDDY_CONFIG_DIR: profile.configDir,
    CODEBUDDY_CONFIG_DIR: profile.configDir,
    WORKBUDDY_USER_DATA_DIR: profile.userDataDir,
    ACC_PRODUCT_CONFIG_PATH: profile.productPath,
    CODEBUDDY_REMOTE_CONFIG_DISABLED: '1',
    WORKBUDDY_CONNECTOR_MARKET_API: '0',
  };
  if (profile.caCertificate) env.NODE_EXTRA_CA_CERTS = path.resolve(profile.caCertificate);
  // Inline V3 overrides the path provider, so never inherit a previous profile.
  for (const name of ['ACC_PRODUCT_CONFIG', 'ACC_PRODUCT_CONFIG_V2', 'ACC_PRODUCT_CONFIG_V3', 'ACC_PRODUCT_CONFIG_V3_FILE', 'ELECTRON_RENDERER_URL', 'VITE_DEV_SERVER_URL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_API_KEY', 'CODEBUDDY_BASE_URL', 'WORKBUDDY_BUILTIN_MARKET_BASE_URL']) delete env[name];
  return env;
}
