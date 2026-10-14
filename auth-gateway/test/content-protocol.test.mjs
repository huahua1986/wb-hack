import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createContentProtocol } from '../src/content-protocol.mjs';

const publicUrl = 'https://private.example';
const account = { uid: 'local-test-account', type: 'personal' };
const originalExpert = JSON.parse(fs.readFileSync(new URL('./fixtures/expert-consumers.json', import.meta.url)));
const originalSkill = JSON.parse(fs.readFileSync(new URL('./fixtures/skill-consumers.json', import.meta.url)));
const plain = value => JSON.parse(JSON.stringify(value));

function record(kind, id, options = {}) {
  return { kind, id, name: id, description: `${id} description`, version: '1.0.0', categoryId: 'writing', tags: ['private'],
    enabled: true, publishedAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T01:00:00.000Z',
    packagePath: `objects/${id}.pkg`, sha256: 'a'.repeat(64), size: 100, files: [], metadata: {}, ...options };
}

function setup(records, options = {}) {
  const signed = [];
  const latest = new Map(records.map(record => [`${record.kind}:${record.id}`, record]));
  const catalog = {
    list(kind, { keyword, categoryId, enabledOnly } = {}) {
      assert.equal(enabledOnly, true);
      return [...latest.values()].filter(record => record.kind === kind && record.enabled !== false
        && (!keyword || `${record.name} ${record.description}`.toLowerCase().includes(keyword.toLowerCase()))
        && (!categoryId || record.categoryId === categoryId));
    },
    get(kind, id, { version } = {}) {
      const value = version ? records.find(record => record.kind === kind && record.id === id && record.version === version) : latest.get(`${kind}:${id}`);
      return value?.enabled === false ? undefined : value;
    },
    categories() { return [{ id: 'writing', name: { zh: '写作', en: 'Writing' } }, { id: 'development', name: 'Development' }]; },
  };
  const protocol = createContentProtocol({ catalog, publicUrl,
    signDownload: (record, actor) => { signed.push({ id: record.id, version: record.version, actor }); return { url: `${publicUrl}/content/download?object=${record.id}&version=${record.version}&ticket=inert-test`, expiresAt: 1791800000 }; },
    staticAssetUrl: path => `${publicUrl}/content/static/${path}`, ...options });
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const response = await protocol.dispatch({ method: options.method ?? 'GET', path: parsed.pathname,
      query: parsed.searchParams, body: options.body ? JSON.parse(options.body) : {}, account });
    assert.ok(response, `unhandled original client path: ${parsed.pathname}`);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
  };
  return { protocol, fetch, signed };
}

function expertVm() {
  const context = vm.createContext({ console: { warn() {}, error() {} },
    attachExpertAssistantIdentity: value => value,
    rememberExpertIsCloud() {}, rememberExpertPayMode() {}, resolveExpertPayModeWithFallback: () => 0,
    js: '/operation-platform/market/expert/get-by-ids' });
  vm.runInContext(`${originalExpert.marketMapper}${originalExpert.featuredMapper}${originalExpert.byIdsConsumer}`, context);
  return context;
}

function skillVm() {
  const context = vm.createContext({ console: { warn() {}, error() {} },
    builtinMarketUrl: (base, path) => `${base}/v2/operation-platform/market${path}`,
    G: '[builtin-market]', mr: value => String(value.skill_id ?? value.id),
    locale: 'zh', yc: value => value, xc: () => context.locale,
    okStep: value => ({ ok: true, value }), failStep: (_record, code, error) => ({ ok: false, error: { code, error } }) });
  vm.runInContext(`${originalSkill.dtoConsumer}${originalSkill.requestConsumer}${originalSkill.downloadConsumer}${originalSkill.featuredConsumer}${originalSkill.installProtocol}${originalSkill.cardTitleConsumer}${originalSkill.cardDescriptionConsumer}`, context);
  return context;
}

test('WorkBuddy 5.8.1 expert by-id, DTO, categories and featured consumers accept private records', async () => {
  const writer = record('expert', 'private-writer', { name: '写作专家', metadata: { pluginName: 'private-writer', agentName: 'writer', featured: true } });
  const { protocol, fetch, signed } = setup([writer]);
  const client = expertVm();
  const http = {
    post: async (path, body) => (await fetch(publicUrl + path, { method: 'POST', body: JSON.stringify(body) })).json(),
    get: async path => (await fetch(publicUrl + path)).json(),
  };
  const items = await client.fetchOperationPlatformExpertsByIds(http, { routePrefix: '/portal', ids: [writer.id] });
  const mapped = client.mapMarketItemToExpertInfo(items[0]);
  assert.equal(mapped.sourceId, writer.id);
  assert.equal(mapped.name.zh, writer.name);
  assert.equal(mapped.plugin, writer.metadata.pluginName);
  assert.equal(mapped.version, writer.version);
  assert.equal(new URL(mapped.downloadUrl).origin, publicUrl);
  assert.equal(mapped.payMode, 0);
  assert.equal(mapped.isCloud, undefined);
  const featured = await client.fetchOpenPlatformFeatured(http);
  assert.equal(featured.items[0].experts[0].id, writer.id);
  vm.runInContext(`globalThis.categoryClient={routePrefix:'/portal',http:null,${originalExpert.categoriesConsumer}}`, client);
  client.categoryClient.http = http;
  const categories = await client.categoryClient.fetchPublicCategories();
  assert.deepEqual(plain(categories.categories[0].name), { zh: '写作', en: 'Writing' });
  assert.ok(signed.every(call => call.actor === account));
  assert.equal(await protocol.dispatch({ method: 'POST', path: '/portal/operation-platform/market/expert/list/get-by-ids', body: {} }), undefined);
});

test('published list supports actual pagination, search, categories and disabling without fake counts', async () => {
  const records = [record('expert', 'writer', { name: 'Writer' }), record('expert', 'coder', { categoryId: 'development' }), record('expert', 'hidden', { enabled: false })];
  const { protocol } = setup(records);
  const send = body => protocol.dispatch({ method: 'POST', path: '/portal/operation-platform/market/expert/list', body, account });
  const first = await send({ page: 1, page_size: 1 });
  const second = await send({ page: 2, page_size: 1 });
  assert.equal(first.body.data.total, 2);
  assert.equal(first.body.data.items.length, 1);
  assert.equal(second.body.data.items[0].expert_id, 'coder');
  assert.equal((await send({ keyword: 'writer' })).body.data.total, 1);
  assert.equal((await send({ categories: ['development'] })).body.data.items[0].expert_id, 'coder');
  assert.equal((await send({ page: -1 })).status, 400);
  assert.equal((await send({ page_size: 501 })).status, 400);
});

test('original recommended skill DTO and numeric featured filtering preserve version and technical name', async () => {
  const skill = record('skill', 'private-review', { name: '代码审查', description: '检查真实代码问题', metadata: { skillName: 'code-review', nameEn: 'Code review', descriptionEn: 'Review real code', featured: 2, featuredOrder: 5, examplesZh: ['审查代码'] } });
  const { fetch } = setup([skill]);
  const client = skillVm();
  const response = await client.builtinMarketGetByIds(fetch, publicUrl, {}, [skill.id]);
  assert.equal(response.code, 0);
  const mapped = client.mapBuiltinSkill(response.data.skills[0], 'zh');
  assert.equal(mapped.name, 'code-review');
  assert.equal(mapped.displayName, '代码审查');
  assert.equal(mapped.metadata.version, '1.0.0');
  assert.equal(mapped.source, 'marketplace');
  assert.equal(client.getBuiltinMarketDisplayName(response.data.skills[0]), '代码审查');
  assert.equal(client.getLocalizedDescription(response.data.skills[0]), '检查真实代码问题');
  client.locale = 'en';
  assert.equal(client.getBuiltinMarketDisplayName(response.data.skills[0]), 'Code review');
  assert.equal(client.getLocalizedDescription(response.data.skills[0]), 'Review real code');
  assert.equal(client.applyFeaturedFilterAndSort(response.data.skills, [2]).length, 1);
  assert.equal(client.applyFeaturedFilterAndSort(response.data.skills, [1]).length, 0);
});

test('original skill by-id requests can carry valid numeric legacy ids without swallowing malformed structures', async () => {
  const { fetch, protocol } = setup([record('skill', '123')]);
  const client = skillVm();
  const response = await client.builtinMarketGetByIds(fetch, publicUrl, {}, [123, 'unknown-legacy-id', 999]);
  assert.equal(response.code, 0);
  assert.equal(response.data.skills.length, 1);
  assert.equal(response.data.skills[0].skill_id, '123');
  const empty = await client.builtinMarketGetByIds(fetch, publicUrl, {}, [999]);
  assert.equal(empty.code, 0);
  assert.equal(empty.data.total_count, 0);
  const send = skill_ids => protocol.dispatch({ method: 'POST', path: '/v2/operation-platform/market/skill/get-by-ids', body: { skill_ids }, account });
  for (const invalid of [null, '123', [null], [{ id: '123' }], [-1], [1.5], ['../../bad'], [Number.MAX_SAFE_INTEGER + 1]]) {
    assert.equal((await send(invalid)).status, 400);
  }
});

test('original skill install download consumer selects immutable requested versions and latest checks', async () => {
  const old = record('skill', 'private-review', { version: '1.0.0' });
  const current = { ...old, version: '1.1.0', packagePath: 'objects/review-new.zip' };
  const { fetch, signed } = setup([old, current]);
  const client = skillVm();
  const latest = await client.builtinMarketGetByIds(fetch, publicUrl, {}, [old.id]);
  assert.equal(latest.data.skills[0].version, '1.1.0');
  const install = await client.resolveBuiltinMarketDownload(fetch, publicUrl, {}, { skillId: old.id, version: '1.0.0' });
  assert.equal(install.ok, true);
  assert.equal(install.value.resolvedVersion, '1.0.0');
  assert.equal(signed.at(-1).version, '1.0.0');
  const download = await client.builtinMarketGetDownloadUrl(fetch, publicUrl, {}, old.id, 'latest');
  assert.equal(download.data.version, '1.1.0');
  assert.equal(download.data.filename, 'private-review-1.1.0.zip');
  const missing = await client.builtinMarketGetDownloadUrl(fetch, publicUrl, {}, old.id, '9.9.9');
  assert.notEqual(missing.code, 0);
  assert.equal(missing.data.download_url, '');
  const invalid = await client.builtinMarketGetDownloadUrl(fetch, publicUrl, {}, old.id, '../../invalid');
  assert.notEqual(invalid.code, 0);
});

test('unauthenticated manifest only exposes explicitly public safe catalogue and never signs packages', async () => {
  const privateExpert = record('expert', 'confidential', { name: 'Restricted name', metadata: { secret: 'metadata-private', categoryName: 'Restricted category label' } });
  const publicExpert = record('expert', 'public-writer', { metadata: { public: true, pluginName: 'public-writer', agentName: 'writer' } });
  const conflicting = record('expert', 'restricted-public-flag', { metadata: { public: true, allowedUsers: ['one-user'] } });
  const { protocol, signed } = setup([privateExpert, publicExpert, conflicting]);
  const manifest = await protocol.getExpertManifest();
  assert.equal(manifest.experts.length, 1);
  assert.equal(manifest.experts[0].plugin, 'public-writer');
  assert.equal(manifest.statistics.totalExperts, 1);
  assert.equal(manifest.categories.length, 1);
  const serialized = JSON.stringify(manifest);
  for (const sensitive of ['confidential', 'Restricted name', 'Restricted category label', 'restricted-public-flag', 'one-user', 'metadata-private', 'packagePath', 'objects/', 'downloadUrl', 'ticket=']) assert.ok(!serialized.includes(sensitive));
  assert.equal(signed.length, 0);
  assert.equal((await protocol.getExpertManifest()).version, manifest.version);
  const empty = await setup([privateExpert]).protocol.getExpertManifest();
  assert.deepEqual(empty.experts, []);
});

test('a failed or foreign download signer cannot fabricate successful install metadata', async () => {
  const records = [record('skill', 'private-review')];
  const dispatch = protocol => protocol.dispatch({ method: 'POST', path: '/v2/operation-platform/market/skill/download-url', body: { skill_id: 'private-review' }, account });
  await assert.rejects(dispatch(setup(records, { signDownload: () => undefined }).protocol), { code: 'CONTENT_DOWNLOAD_NOT_CONFIGURED' });
  await assert.rejects(dispatch(setup(records, { signDownload: () => 'https://foreign.example/package.zip' }).protocol), { code: 'CONTENT_DOWNLOAD_ORIGIN' });
  await assert.rejects(dispatch(setup(records, { signDownload: () => { throw new Error('signer unavailable'); } }).protocol), /signer unavailable/);
});

test('original Node/facade, renderer install parameters and native meta builder preserve fresh title across update', async () => {
  const current = record('skill', 'private-review', { name: '私有测试技能', description: '新版真实摘要', version: '1.1.0', metadata: { skillName: 'private-review' } });
  const { fetch } = setup([current]);
  const client = skillVm();
  client.CloudSkillsMarketplaceRepo = class { constructor() { this.skillhub = {}; this.builtin = {}; } };
  client.assertFacadeSuccess = (_method, value) => assert.equal(value.code, 0);
  client.X = key => key;
  vm.runInContext(`var ${originalSkill.nodeRepo};${originalSkill.builtinFacade}
    ${originalSkill.normalizeStringDependency}${originalSkill.normalizeInstallParams}${originalSkill.installedMetaNameBuilder}${originalSkill.installedCardTitle};
    globalThis.Ai='marketplace';
    globalThis.controllerMethods={${originalSkill.installParameterConsumer},${originalSkill.updateSelectionConsumer}}`, client);
  const domain = {
    getBuiltinMarketList: async () => (await fetch(`${publicUrl}/v2/operation-platform/market/skill/list`, { method: 'POST', body: '{}' })).json(),
    installBuiltinMarketSkill: async params => {
      client.lastInstallParams = params;
      const normalized = client.normalizeBuiltinMarketInstallRequest(params);
      client.installedMeta = client.baseBuiltinMarketInstallMeta({
        existingMetaSnapshot: { name: '旧缓存错误摘要标题', userModified: false }, existingInstalledAt: 1,
      }, normalized, params.version);
      return { success: true, version: params.version, installedPath: '/inert-fixture/SKILL.md' };
    },
  };
  const repo = new client.NodeSkillsMarketplaceRepo(domain);
  const wire = (await repo.builtin.list({ page: 1 })).data.skills[0];
  const sdkFacade = client.createBuiltinMarket(repo.builtin);
  assert.equal((await sdkFacade.list({ page: 1 })).items[0].description, current.name);
  assert.equal(wire.description_zh, current.description);
  assert.equal(wire.description, current.name);

  let state = { remoteVersionMap: { [current.id]: current.version }, localVersionMap: { [current.id]: '1.0.1' } };
  const controller = {
    ...client.controllerMethods,
    facade: { builtin: repo.builtin },
    store: { getState: () => state, setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; } },
    deps: { mode: 'inert-fixture', telemetry: { reportEvent() {}, Events: {} } },
    markRecentlyInstalled() {},
    services: { installedSkillsService: { notifySkillInstalled(value) { client.notifiedSkill = value; } } },
  };
  client.resolveMarketPayMode = () => 0;
  client.resolveBuiltinRoute = () => 'legacy';
  const result = await controller.installOrUpdate(wire, true);
  assert.equal(result.success, true);
  assert.equal(client.lastInstallParams.name, current.name);
  assert.equal(client.lastInstallParams.description_zh, current.description);
  assert.equal(client.installedMeta.name, current.name);
  assert.equal(client.installedMeta.version, '1.1.0');
  assert.equal(client.installedMeta.source, 'marketplace');
  assert.equal(client.getInstalledSkillDisplayName(client.installedMeta), current.name);
  assert.equal(client.getInstalledSkillDisplayName(client.notifiedSkill), current.name);

  const cached = { ...wire, description: '旧缓存错误摘要标题', version: '1.0.1' };
  controller.resolveUpdateInfo = () => ({ skillId: current.id });
  controller.findInCollections = () => cached;
  assert.equal(await controller.resolveSkillForUpdate({ skillId: current.id, name: current.name }), cached);
  await controller.installOrUpdate(cached, true);
  assert.equal(client.installedMeta.version, '1.1.0');
  assert.equal(client.installedMeta.name, '旧缓存错误摘要标题');
  await controller.installOrUpdate(wire, true);
  assert.equal(client.installedMeta.name, current.name);
});

test('the shared _skillhub_meta filename does not make marketplace content a SkillHub source', () => {
  const client = skillVm();
  const meta = { source: 'marketplace', name: '私有测试技能', version: '1.1.0', skillId: 'private-review', installedAt: 1, iconSource: 'https://private.example/inert-icon' };
  let fetches = 0;
  client.readJsonObject = () => meta;
  client.listSkillHubMetaFiles = () => [{ entryName: 'private-review', metaPath: '/inert-fixture/_skillhub_meta.json' }];
  vm.runInContext(`${originalSkill.skillHubInstalledScanner}${originalSkill.skillHubSourceGuard}${originalSkill.builtinSourceGuard}`, client);
  assert.equal(client.isBuiltinMarketSource(meta), true);
  assert.deepEqual(plain(client.skillHubGetInstalledMetas('/inert-fixture', () => { fetches++; })), []);
  assert.equal(fetches, 0);
});
