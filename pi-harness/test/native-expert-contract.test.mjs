import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { inspectAsar } from '../package-dmg/asar.mjs';
import { createNativeExpertReplay, nativeExpertFixture as fixture } from './fixtures/native-expert-592.replay.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const role = values => ({ id: 'SeniorDeveloper', marketExpertId: 'ex_synthetic', name: 'Synthetic Developer',
  source: 'builtin', marketplace: 'experts', locale: 'zh', expertType: 'agent',
  pluginName: 'synthetic-developer', agentName: 'synthetic-developer', localPath: '/synthetic/experts/developer',
  updatedAt: '2026-10-28T00:00:00Z', version: '1.0.0', ...values });

test('fixture pins original 5.9.2 Expert methods and the shipped recommendation identity', () => {
  assert.equal(fixture.workbuddyVersion, '5.9.2');
  assert.equal(fixture.artifactSHA256, '0b79c0358c129749bc3355f52bbae13f115577ab37c082a76dfdc54f66fd3f79');
  assert.equal(fixture.curatedSeniorDeveloper.candidate.id, 'SeniorDeveloper');
  const key = {}; vm.runInNewContext(fixture.slices.find(slice => slice.name === 'pendingExpertKeyAssignment').source, key);
  assert.equal(key.PENDING_EXPERT_SESSION_KEY, fixture.constants.pendingExpertKey);
  assert.equal(fixture.slices.find(slice => slice.name === 'homeMapperImportSpecifier').source, 'ea as or');
  assert.equal(fixture.slices.find(slice => slice.name === 'homeMapperExportSpecifier').source, 'mapInputExpertSelection as ea');
  for (const slice of fixture.slices) {
    assert.equal(createHash('sha256').update(slice.source).digest('hex'), slice.sha256);
    assert.equal(Buffer.byteLength(slice.source), slice.range.end - slice.range.start);
  }
});

test('actual mapExpertInfo preserves market/source/plugin/local-runtime fields and localizes the persona', () => {
  const native = createNativeExpertReplay(), raw = role({ displayName: { zh: '合成专家', en: 'Synthetic Expert' },
    prompt: { zh: 'SYNTHETIC PERSONA', en: 'SYNTHETIC ENGLISH PERSONA' }, defaultInitPrompt: { zh: 'Synthetic starter' },
    enterpriseId: 'synthetic-enterprise', pluginRegisteredName: 'synthetic-registered', runtimeIdentity: 'opaque-original-identity', applicationId: 'synthetic-app' });
  const result = native.mapExpertInfo(raw, 'zh');
  assert.equal(result.name, '合成专家'); assert.equal(result.prompt, 'SYNTHETIC PERSONA');
  for (const key of ['id', 'marketExpertId', 'source', 'marketplace', 'locale', 'expertType', 'pluginName', 'agentName', 'localPath',
    'enterpriseId', 'pluginRegisteredName', 'runtimeIdentity', 'applicationId', 'version', 'updatedAt']) assert.equal(result[key], raw[key], key);
});

test('native Home and Embed create objects carry the real params.expert DTO rather than invented prefixed fields', () => {
  const native = createNativeExpertReplay(), selected = native.mapExpertInfo(role({ prompt: { zh: 'SYNTHETIC PERSONA' } }), 'zh');
  for (const make of ['homeCreateParams', 'embedCreateParams']) {
    const params = native[make](selected, { cwd: '/synthetic/new-task', title: 'Synthetic task' });
    assert.equal(params.expertId, selected.id); assert.equal(params.locale, 'zh'); assert.equal(params.cwd, '/synthetic/new-task');
    assert.equal(params.expert.id, selected.id); assert.equal(params.expert.marketExpertId, selected.marketExpertId);
    assert.equal(params.expert.source, 'builtin'); assert.equal(params.expert.marketplace, 'experts');
    assert.equal(native.readRuntimeField(params.expert.runtimeIdentity, 'pluginRegisteredName'), 'synthetic-developer');
    assert.equal(native.readRuntimeField(params.expert.runtimeIdentity, 'agentName'), 'synthetic-developer');
    assert.equal(native.readRuntimeField(params.expert.runtimeIdentity, 'marketExpertId'), 'ex_synthetic');
    assert.equal(native.readRuntimeField(params.expert.runtimeIdentity, 'source'), 'builtin');
    assert.equal(params.expertMarketExpertId, undefined); assert.equal(params.expertSource, undefined);
    assert.equal(params.expertRuntimeIdentity, undefined); assert.equal(params.expert.localPath, undefined);
  }
  assert.equal(native.homeCreateParams(selected).tags.expert, selected.id);
});

test('legacy launch recovers a matched pending Expert and writes runtimeIdentity/locale in the config layer', () => {
  const native = createNativeExpertReplay(), selected = role(), options = { requestedMode: 'craft', expertId: selected.id, locale: 'zh' };
  const launch = native.legacyLaunchConfig(options, { pendingExpert: selected });
  assert.equal(launch.expertId, selected.id); assert.equal(launch.expertMarketplace, 'experts'); assert.equal(launch.locale, 'zh');
  assert.equal(native.readRuntimeField(launch.runtimeIdentity, 'marketExpertId'), 'ex_synthetic');
  assert.equal(native.readRuntimeField(launch.runtimeIdentity, 'agentName'), 'synthetic-developer');
  const desired = native.legacyDesiredConfig(options, { pendingExpert: selected });
  assert.equal(desired.runtimeIdentity, launch.runtimeIdentity); assert.equal(desired.expertRuntimeIdentity, undefined);
  const unrelated = native.legacyLaunchConfig({ requestedMode: 'craft', expertId: 'AnotherExpert' }, { pendingExpert: selected });
  assert.equal(unrelated.runtimeIdentity, 'expert:AnotherExpert');
  const ask = native.legacyLaunchConfig({ requestedMode: 'ask' }, { pendingExpert: selected }); assert.equal(ask.expertId, undefined);
});

test('native bind options preserve identity and use the actual setExpertId option names', async () => {
  const native = createNativeExpertReplay(), selected = role();
  const result = await native.bindOptions({ expertId: selected.id, locale: 'zh', marketplace: selected.marketplace,
    marketExpertId: selected.marketExpertId, expertType: selected.expertType, source: selected.source,
    pluginRegisteredName: selected.pluginName, agentName: selected.agentName });
  assert.equal(result.expertId, selected.id); assert.equal(result.options.marketExpertId, 'ex_synthetic');
  assert.equal(result.options.source, 'builtin'); assert.equal(result.options.marketplace, 'experts');
  assert.equal(native.readRuntimeField(result.options.runtimeIdentity, 'pluginRegisteredName'), 'synthetic-developer');
  assert.deepEqual(result.modes, ['craft']);
});

test('persisted session detail restores expertRuntimeIdentity/expertLocale without confusing create config names', () => {
  const native = createNativeExpertReplay(), selection = native.inputSelection(role());
  const restored = native.fromSessionDetail({ expertId: selection.id, expertMarketplace: selection.marketplace,
    expertLocale: selection.locale, expertRuntimeIdentity: selection.runtimeIdentity });
  assert.equal(restored.marketExpertId, 'ex_synthetic'); assert.equal(restored.runtimeIdentity, selection.runtimeIdentity);
  assert.equal(restored.locale, 'zh'); assert.equal(restored.marketplace, 'experts');
  const patch = native.persistPatch(restored.id, restored); assert.equal(patch.expertRuntimeIdentity, selection.runtimeIdentity);
  assert.equal(patch.locale, 'zh'); assert.equal(patch.expertLocale, undefined);
});

test('native official get forwards the canonical market identity and visibility/source query fields', async () => {
  const native = createNativeExpertReplay(), request = await native.officialGetQuery({ expertId: 'SeniorDeveloper', marketExpertId: 'ex_synthetic',
    locale: 'zh', source: 'builtin', isIncludeInvisible: true, allowStaleManifestFallback: true, pluginName: 'not-an-official-query-field' });
  assert.deepEqual(plain(request), { expertId: 'SeniorDeveloper', marketExpertId: 'ex_synthetic', locale: 'zh', source: 'builtin',
    isIncludeInvisible: true, allowStaleManifestFallback: true });
});

test('native enterprise lookup tries real market ID before the alias and maps enterprise to backend custom', async () => {
  const result = await createNativeExpertReplay().enterpriseQuery({ expertId: 'SeniorDeveloper', marketExpertId: 'ex_synthetic', locale: 'zh', source: 'builtin' });
  assert.equal(result.path, '/portal/enterprises/synthetic-enterprise/expert-market/get-by-ids');
  assert.deepEqual(plain(result.body.experts), [{ id: 'ex_synthetic', source: 'builtin' }, { id: 'ex_synthetic', source: 'custom' },
    { id: 'SeniorDeveloper', source: 'builtin' }, { id: 'SeniorDeveloper', source: 'custom' }]);
});

test('native selector keeps market and local-custom resolution separate and does not disguise a market failure as custom', async () => {
  const native = createNativeExpertReplay(), official = [], local = [];
  const resolved = await native.resolveSelected({ expertId: 'SeniorDeveloper', marketExpertId: 'ex_synthetic', locale: 'zh', transport: 'local',
    getOfficial: async request => { official.push(request); return { id: 'SyntheticCanonical' }; }, getLocal: async request => { local.push(request); } });
  assert.equal(resolved.marketExpertId, 'ex_synthetic'); assert.equal(local.length, 0); assert.equal(official[0].marketExpertId, 'ex_synthetic');
  const custom = await native.resolveSelected({ expertId: 'SyntheticLocal', locale: 'zh', transport: 'local',
    getOfficial: async () => { throw Error('synthetic unavailable'); }, getLocal: async () => ({ id: 'SyntheticLocal', expertRootDir: '/synthetic/custom' }) });
  assert.equal(custom.source, 'custom'); assert.equal(custom.marketplace, 'my-experts'); assert.equal(custom.localPath, '/synthetic/custom');
  const missing = await native.resolveSelected({ expertId: 'SeniorDeveloper', marketExpertId: 'ex_missing', locale: 'zh', transport: 'local',
    getOfficial: async () => { throw Error('synthetic unavailable'); }, getLocal: async () => { throw Error('must not be called'); } });
  assert.equal(missing, undefined);
});

test('native send reuses cached persona or installed local runtime identity without forcing activation', async () => {
  const native = createNativeExpertReplay(), cached = role({ prompt: 'SYNTHETIC PERSONA', defaultInitPrompt: 'Synthetic starter' });
  const reused = await native.sendGate(cached); assert.equal(reused.prompt.prompt, cached.prompt); assert.equal(reused.expert, cached); assert.equal(reused.activationCalls.length, 0);
  const local = role({ prompt: 'Synthetic starter', defaultInitPrompt: 'Synthetic starter' }), runtime = await native.sendGate(local);
  assert.equal(runtime.prompt, undefined); assert.equal(runtime.expert, local); assert.equal(runtime.activationCalls.length, 0); assert.equal(runtime.cleared.length, 0);
});

test('native unavailable fallback is explicit in the replay and is not counted as a working Expert', async () => {
  const result = await createNativeExpertReplay().sendGate({ id: 'SyntheticMissing', name: 'Synthetic Missing', prompt: '', defaultInitPrompt: '' });
  assert.equal(result.expert, null); assert.equal(result.activationCalls.length, 1); assert.deepEqual(result.cleared, ['synthetic-session']);
});

test('native read API supports a pre-session text call scoped to the known plugin root without real I/O', async () => {
  const result = await createNativeExpertReplay().readTextCall('/synthetic/experts/developer/agents/developer.md', { allowedDirs: ['/synthetic/experts/developer'] });
  assert.equal(result.result.success, true); assert.equal(result.result.content, 'synthetic agent body');
  assert.deepEqual(plain(result.args), ['/synthetic/experts/developer/agents/developer.md', null, { allowedDirs: ['/synthetic/experts/developer'] }]);
});

test('every original Expert slice and shipped curated asset matches the retained 5.9.2 ASAR', { skip: !process.env.NATIVE_PREVIEW_TEST_ASAR }, () => {
  const archive = inspectAsar(process.env.NATIVE_PREVIEW_TEST_ASAR), digests = new Map();
  for (const slice of fixture.slices) {
    const bytes = archive.read(slice.member);
    if (!digests.has(slice.member)) digests.set(slice.member, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(digests.get(slice.member), slice.memberSHA256);
    assert.deepEqual(bytes.subarray(slice.range.start, slice.range.end), Buffer.from(slice.source));
  }
  const bytes = archive.read(fixture.curatedSeniorDeveloper.member);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.curatedSeniorDeveloper.memberSHA256);
  assert.deepEqual(JSON.parse(bytes).candidates.find(candidate => candidate.id === 'SeniorDeveloper'), fixture.curatedSeniorDeveloper.candidate);
});
