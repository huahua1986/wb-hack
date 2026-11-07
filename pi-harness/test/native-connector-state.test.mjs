import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/native-connector-state-591.source.json', import.meta.url), 'utf8'));
const slice = name => {
  const found = fixture.slices.find(entry => entry.name === name);
  assert.ok(found, `Missing native source slice: ${name}`);
  return found.source;
};

function nativeProjection(overrides = {}) {
  const state = { bound: true, enabled: true, status: 'connected', inFlight: false, dependency: undefined, ...overrides };
  const host = {
    getStateStore: () => ({
      persistentState: { connectors: { fixture: {} } },
      isBound: () => state.bound,
      isEnabledForSession: () => state.enabled,
      isPluginManaged: () => false,
    }),
    getStates: () => ({ get: () => state.status ? { status: state.status } : undefined, ids: () => ['fixture'] }),
    getMcpManager: () => ({ getDependencySnapshot: id => { assert.equal(id, 'fixture-runtime-id'); return state.dependency; } }),
    getConnectIntents: () => ({ isInFlight: () => state.inFlight }),
    getWecomSkillAccount: () => undefined,
    getServerSideAuth: () => ({ pendingServerSideAuthAborts: new Set() }),
    getGmailLocal: () => ({ isBundled: () => false }),
    getPluginAccount: () => ({ pluginSource: undefined }),
    getConnectorConfigById: () => ({ authMode: 'oauth' }),
  };
  const context = vm.createContext({
    g: {
      sn: { isConnectorAllowed: () => undefined },
      Gn: id => { assert.equal(id, 'fixture'); return 'fixture-runtime-id'; },
    },
    o: { c: () => false },
    host,
  });
  vm.runInContext(`globalThis.api={${slice('projectConnectorState')},${slice('collectProjectedStates')},${slice('buildStateReason')}};api.host=host`, context);
  return { state, api: context.api, project: () => context.api.projectConnectorState('fixture') };
}

test('five exact 5.9.1 connector-state source slices retain hashes and UTF-8 byte boundaries', () => {
  assert.equal(fixture.workbuddyVersion, '5.9.1');
  assert.equal(fixture.artifactSHA256, '1fc0a56ddec5437d4dc55a55ba1c028b291ab29cb17306500827015987424233');
  assert.equal(fixture.slices.length, 5);
  const members = {
    'main/module.app-server.js': '60fbf6fd53b74d53760a0b5d41ed1d17d3622ed92c2df7f184dab847ae8e139c',
    'main/authority-snapshot.js': '15b99c97a1f8c2e0206c2907a7894c5a08db644ccec92bcead376e5c60653a93',
  };
  for (const entry of fixture.slices) {
    assert.equal(entry.memberSHA256, members[entry.member]);
    assert.equal(entry.range.encoding, 'UTF-8');
    assert.equal(createHash('sha256').update(entry.source).digest('hex'), entry.sha256);
    assert.equal(Buffer.byteLength(entry.source), entry.range.end - entry.range.start);
  }
});

test('native connected projection has connected boolean and no internal status field', () => {
  const { project } = nativeProjection();
  const result = project();
  assert.equal(result.connected, true);
  assert.equal(result.bound, true);
  assert.equal(result.enabled, true);
  assert.equal(result.status, undefined);
  assert.deepEqual(Object.keys(result).sort(), ['configId', 'bound', 'enabled', 'connected', 'connecting', 'reason'].sort());
});

test('native dependency readiness overrides a stale internally connected status', () => {
  const { project } = nativeProjection({ dependency: { present: true, ready: false, state: 'error' } });
  const result = project();
  assert.equal(result.connected, false);
  assert.equal(result.connecting, false);
  assert.equal(result.reason.code, 'runtime');
  assert.equal(result.reason.message, 'Connection failed');
});

test('native ready MCP dependency can project connected without internal status', () => {
  const { project } = nativeProjection({ status: undefined, dependency: { present: true, ready: true, state: 'ready' } });
  assert.equal(project().connected, true);
});

test('native connection in flight projects connecting instead of usable connected state', () => {
  const { project } = nativeProjection({ inFlight: true });
  const result = project();
  assert.equal(result.connected, false);
  assert.equal(result.connecting, true);
  assert.equal(result.reason, undefined);
});

test('native unbound connector is not connected despite a ready MCP dependency', () => {
  const { project } = nativeProjection({ bound: false, dependency: { present: true, ready: true, state: 'ready' } });
  const result = project();
  assert.equal(result.bound, false);
  assert.equal(result.connected, false);
});

test('native disabled connector is not connected despite a ready MCP dependency', () => {
  const { project } = nativeProjection({ enabled: false, dependency: { present: true, ready: true, state: 'ready' } });
  const result = project();
  assert.equal(result.enabled, false);
  assert.equal(result.connected, false);
});

test('native state collection preserves configId and projected connected field', () => {
  const { api } = nativeProjection();
  const result = api.collectProjectedStates();
  assert.deepEqual(Object.keys(result), ['fixture']);
  assert.equal(result.fixture.configId, 'fixture');
  assert.equal(result.fixture.connected, true);
  assert.equal(result.fixture.status, undefined);
});

test('native ConnectorService.getStates delegates to the config reader and returns projected states', async () => {
  const { api } = nativeProjection();
  let reads = 0;
  const context = vm.createContext({
    shouldIgnoreBuddyAllowlist: () => false,
    isStatefulConnectorState: () => false,
    host: {
      getMcpDeclarations: () => ({ collectProjectedStates: () => { reads++; return api.collectProjectedStates(); } }),
      getIndustryAllowlist: () => ({ getAllowlist: async () => undefined }),
    },
  });
  vm.runInContext(`globalThis.reader={${slice('configReaderGetStates')}};reader.host=host;globalThis.service={${slice('serviceGetStates')}};service.configReader=reader`, context);
  const result = await context.service.getStates();
  assert.equal(reads, 1);
  assert.equal(result.fixture.connected, true);
  assert.equal(result.fixture.bound, true);
  assert.equal(result.fixture.enabled, true);
});
