import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildClientProduct, clientEnvironment, prepareClientProfile, prepareManagedConnectorSource, inspectConnectorCatalogSource } from '../src/client-profile.mjs';
import { validatePublicUrl } from '../src/config.mjs';

test('client overlay disables remote configuration and defaults without touching supplied product', () => {
  const base = { endpoint: 'https://www.workbuddy.cn', authentication: { id: 'workbuddy-desktop', type: 'account-scoped-external-link' }, config: { keep: true }, models: [{ id: 'auto', disabled: false }], productFeatures: { Existing: true, TencentNetDriveKnowledge: true, KnowledgeBase: true, Claw: true } };
  const result = buildClientProduct(base, 'https://auth.example.test');
  assert.equal(result.authentication.id, 'workbuddy-desktop'); assert.equal(result.authentication.type, base.authentication.type);
  assert.equal(result.endpoint, 'https://auth.example.test'); assert.equal(result.config.disabled, true); assert.equal(result.config.keep, true);
  assert.ok(result.models.every(model => model.disabled)); assert.equal(base.models[0].disabled, false);
  assert.equal(result.productFeatures.Existing, true); assert.equal(result.productFeatureExperiment.enabled, false);
  assert.equal(result.productFeatures.TencentNetDriveKnowledge, false);
  assert.equal(result.productFeatures.DisableCloudAssistantUpgradeBanner, true);
  assert.equal(result.productFeatures.DisableTeamsProject, true);
  assert.equal(result.productFeatures.UseEnterpriseDownloadSource, true);
  assert.equal(result.productFeatures.DisableSkillHub, true);
  assert.equal(result.productFeatures.ConnectorMarketApiEnabled, false);
  assert.equal(result.productFeatures.KnowledgeBase, true); assert.equal(result.productFeatures.Claw, false);
  assert.equal(base.productFeatures.TencentNetDriveKnowledge, true);
});

test('profile creation is explicit, private and refuses to overwrite; launch env clears stale V3', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-profile-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { baseProduct: { models: [] }, gateway: 'http://127.0.0.1:8787', profileDir: dir, executable: '/example/workbuddy' };
  const filename = prepareClientProfile(options), profile = JSON.parse(fs.readFileSync(filename));
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.throws(() => prepareClientProfile(options), /exists/);
  const env = clientEnvironment(profile, { ACC_PRODUCT_CONFIG_V3: 'stale', NODE_OPTIONS: '--bad', LOCAL_MODEL_API_KEY: 'test-model-key', WORKBUDDY_CONNECTOR_MARKET_API: '1', WORKBUDDY_BUILTIN_MARKET_BASE_URL: 'https://old.example.test' });
  assert.equal(env.ACC_PRODUCT_CONFIG_V3, undefined); assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_ENV, 'development'); assert.equal(env.CODEBUDDY_REMOTE_CONFIG_DISABLED, '1');
  assert.equal(env.ACC_PRODUCT_CONFIG_PATH, profile.productPath); assert.equal(env.LOCAL_MODEL_API_KEY, 'test-model-key');
  assert.equal(env.WORKBUDDY_DEV_ENDPOINT_OVERRIDE, options.gateway);
  assert.equal(env.WORKBUDDY_CONNECTOR_MARKET_API, '0'); assert.equal(env.WORKBUDDY_BUILTIN_MARKET_BASE_URL, undefined);
  const connectorSource = JSON.parse(fs.readFileSync(path.join(profile.configDir, 'connectors', 'connector-marketplace.json')));
  assert.equal(connectorSource.connectorPluginMarketplaceUrl, options.gateway + '/connector-agent-plugins/connector-plugins.zip');
});

test('managed connector source updates only owned fields and preserves custom data', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-source-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = { configDir: root, gateway: 'https://one.example.test' }, first = prepareManagedConnectorSource(profile);
  const source = JSON.parse(fs.readFileSync(first.filename)); source.customSettings = { keep: true };
  fs.writeFileSync(first.filename, JSON.stringify(source));
  profile.gateway = 'https://two.example.test'; const second = prepareManagedConnectorSource(profile);
  const updated = JSON.parse(fs.readFileSync(second.filename));
  assert.deepEqual(updated.customSettings, { keep: true });
  assert.equal(updated.connectorPluginMarketplaceUrl, profile.gateway + '/connector-agent-plugins/connector-plugins.zip');
  assert.equal(updated.connectorPluginMarketplaceInternalUrl, updated.connectorPluginMarketplaceUrl);
  assert.equal(fs.statSync(second.filename).mode & 0o777, 0o600);
  updated.connectorPluginMarketplaceUrl = 'https://user.example.test/catalog.zip'; fs.writeFileSync(second.filename, JSON.stringify(updated));
  assert.throws(() => prepareManagedConnectorSource(profile), /changed externally/);
  assert.equal(JSON.parse(fs.readFileSync(second.filename)).connectorPluginMarketplaceUrl, updated.connectorPluginMarketplaceUrl);
});

test('foreign connector overrides and symlinks are rejected without changing their contents', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-source-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'connectors'); fs.mkdirSync(dir); const filename = path.join(dir, 'connector-marketplace.json');
  const original = '{"connectorMarketplaceUrl":"https://user.example.test/own.zip","keep":true}'; fs.writeFileSync(filename, original);
  assert.throws(() => prepareManagedConnectorSource({ configDir: root, gateway: 'https://private.example.test' }), /not owned/);
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
  fs.unlinkSync(filename); const target = path.join(root, 'foreign.json'); fs.writeFileSync(target, original); fs.symlinkSync(target, filename);
  assert.throws(() => prepareManagedConnectorSource({ configDir: root, gateway: 'https://private.example.test' }), /symbolic link/);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
});

test('native source adoption rejects stale public hashes without modifying caches or credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-native-source-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = { configDir: root, gateway: 'https://private.example.test' }, expected = 'a'.repeat(64);
  const source = prepareManagedConnectorSource(profile), before = inspectConnectorCatalogSource(profile, { expectedSha256: expected });
  assert.equal(before.adopted, false);
  fs.mkdirSync(path.dirname(before.metadataPath), { recursive: true });
  fs.writeFileSync(before.metadataPath, JSON.stringify({ sourceKey: 'public\nhttps://static.workbuddy.cn/old.zip', sha256: expected }));
  assert.equal(inspectConnectorCatalogSource(profile, { expectedSha256: expected }).reason, 'source-mismatch');
  fs.writeFileSync(before.metadataPath, JSON.stringify({ sourceKey: source.sourceKey, sha256: 'b'.repeat(64) }));
  assert.equal(inspectConnectorCatalogSource(profile, { expectedSha256: expected }).reason, 'hash-mismatch');
  fs.writeFileSync(before.metadataPath, JSON.stringify({ sourceKey: source.sourceKey, sha256: expected }));
  assert.equal(inspectConnectorCatalogSource(profile, { expectedSha256: expected }).reason, 'catalog-missing-or-invalid');
  fs.mkdirSync(path.dirname(before.manifestPath), { recursive: true });
  fs.writeFileSync(before.manifestPath, JSON.stringify({ name: 'workbuddy-connector-plugins-official', version: '2', plugins: [] }));
  assert.equal(inspectConnectorCatalogSource(profile, { expectedSha256: expected }).adopted, true);
});

test('public origin validation rejects credential-bearing, HTTP remote and malformed base URLs', () => {
  for (const value of ['http://auth.example.test', 'https://u:p@auth.example.test', 'https://auth.example.test/subpath', 'https://auth.example.test/?a=b']) assert.throws(() => validatePublicUrl(value));
  assert.equal(validatePublicUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(validatePublicUrl('https://auth.example.test'), 'https://auth.example.test');
});
