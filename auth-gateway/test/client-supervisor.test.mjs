import test from 'node:test';
import assert from 'node:assert/strict';
import { createLaunchController, ownedProcess } from '../../client-distribution/supervisor.mjs';

const settings = { appPath: '/Applications/WorkBuddy.app', gateway: 'https://auth.example.test', mode: 'development', productName: '企业AI工作台', welcomeTitle: '企业AI工作台，我帮你' };
const ownerFor = pid => ({ pid, processFingerprint: `start-${pid}`, executable: settings.appPath + '/Contents/MacOS/Electron', gateway: settings.gateway, mode: settings.mode,
  runtimeBranding: { inspectorClosed: true, productName: settings.productName, welcomeTitle: settings.welcomeTitle } });
function fixture(overrides = {}) {
  const calls = [], events = []; let owner = null, pids = [], clock = 100000;
  const controller = createLaunchController({ settings, readOwner: () => owner, fingerprint: pid => `start-${pid}`, now: () => clock,
    findProcesses: () => pids, verify: () => calls.push('verify'), handoff: async app => { calls.push(['handoff', app.pid]); pids = []; },
    launch: async autostart => { calls.push(['launch', autostart]); owner = ownerFor(30); pids = [30]; },
    report: (event, details) => events.push([event, details]), wait: async ms => { clock += ms; }, ...overrides });
  return { controller, calls, events, setOwner: v => { owner = v; }, setPids: v => { pids = v; }, setClock: v => { clock = v; } };
}

test('a fresh original icon launch is normally handed off once and its controlled launch event cannot loop', async () => {
  const f = fixture(); f.setPids([20]);
  await f.controller.handle({ pid: 20, launchedAt: 99900 });
  await f.controller.handle({ pid: 20, launchedAt: 99900 });
  await f.controller.handle({ pid: 30, launchedAt: 100000 });
  assert.deepEqual(f.calls, ['verify', ['handoff', 20], ['launch', false]]);
  assert.ok(f.events.some(([event]) => event === 'handoff-complete'));
});

test('monitor startup preserves existing unmanaged work, and quitting does not itself relaunch the app', async () => {
  const f = fixture(); f.setPids([20]);
  await f.controller.start([{ pid: 20, launchedAt: 1000 }]);
  f.setPids([]); await f.controller.idle();
  assert.deepEqual(f.calls, []);
  assert.equal(f.events[0][0], 'existing-unmanaged');
  f.setPids([21]); await f.controller.handle({ pid: 21, launchedAt: 99900 });
  assert.deepEqual(f.calls, ['verify', ['handoff', 21], ['launch', false]]);
});

test('an own startup notification waits for the launch receipt before classification', async () => {
  let release, started;
  const running = new Promise(resolve => { started = resolve; });
  let owner = null, pids = [];
  const f = fixture({ readOwner: () => owner, findProcesses: () => pids,
    launch: async () => { pids = [30]; started(); await new Promise(resolve => { release = resolve; }); owner = ownerFor(30); } });
  const initial = f.controller.start([]); await running;
  const event = f.controller.handle({ pid: 30, launchedAt: 99900 });
  release(); await initial; await event;
  assert.deepEqual(f.calls, ['verify']);
  assert.ok(!f.events.some(([event]) => event === 'handoff-requested'));
});

test('stale events, malformed identities, conflicting processes and changed PID identity cannot terminate an app', async () => {
  for (const app of [{ pid: 20, launchedAt: 0 }, { pid: -1, launchedAt: 99900 }, { pid: 20, launchedAt: 100001 }, {}]) {
    const f = fixture(); f.setPids([20]); await f.controller.handle(app); assert.deepEqual(f.calls, []);
  }
  const conflicting = fixture(); conflicting.setPids([20, 21]);
  await conflicting.controller.handle({ pid: 20, launchedAt: 99900 }); assert.deepEqual(conflicting.calls, []);
  let reads = 0;
  const changed = fixture({ fingerprint: () => ++reads === 1 ? 'before' : 'after' }); changed.setPids([20]);
  await changed.controller.handle({ pid: 20, launchedAt: 99900 }); assert.deepEqual(changed.calls, ['verify']);
});

test('version verification and refused normal termination fail without starting another instance or retrying', async () => {
  const mismatched = fixture({ verify: () => { throw new Error('version mismatch'); } }); mismatched.setPids([20]);
  await mismatched.controller.handle({ pid: 20, launchedAt: 99900 });
  assert.deepEqual(mismatched.calls, []); assert.equal(mismatched.events.at(-1)[0], 'error');
  const refused = fixture({ handoff: () => { throw new Error('normal quit refused'); } }); refused.setPids([20]);
  await refused.controller.handle({ pid: 20, launchedAt: 99900 });
  await refused.controller.handle({ pid: 20, launchedAt: 99900 });
  assert.deepEqual(refused.calls, ['verify']); assert.equal(refused.events.at(-1)[0], 'error');
});

test('background survivors and shutdown stop handoff without forced kills or extra app startup', async () => {
  const survivor = fixture({ handoff: async () => {} }); survivor.setPids([20]);
  await survivor.controller.handle({ pid: 20, launchedAt: 99900 });
  assert.deepEqual(survivor.calls, ['verify']); assert.equal(survivor.events.at(-1)[0], 'error');
  const closed = fixture(); closed.setPids([20]); closed.controller.close();
  await closed.controller.handle({ pid: 20, launchedAt: 99900 }); assert.deepEqual(closed.calls, []);
});

test('ownership requires the same birth fingerprint, gateway, mode, names and closed Inspector', () => {
  const owner = ownerFor(20), fingerprint = () => 'start-20';
  assert.equal(ownedProcess(20, settings, owner, fingerprint), true);
  for (const patch of [{ processFingerprint: 'other' }, { gateway: 'https://other.example.test' }, { mode: 'production' },
    { executable: '/other.app/Contents/MacOS/Electron' }, { runtimeBranding: { ...owner.runtimeBranding, inspectorClosed: false } },
    { runtimeBranding: { ...owner.runtimeBranding, welcomeTitle: 'other' } }]) {
    assert.ok(!ownedProcess(20, settings, { ...owner, ...patch }, fingerprint));
  }
  assert.ok(!ownedProcess(21, settings, owner, fingerprint));
});


test('verification delays and shutdown during verification cannot turn a fresh event into an unsafe handoff', async () => {
  let f;
  f = fixture({ verify: async () => { f.setClock(108000); } }); f.setPids([20]);
  await f.controller.handle({ pid: 20, launchedAt: 99900 });
  assert.deepEqual(f.calls, []); assert.equal(f.events.at(-1)[0], 'ignored-changed');
  let stop;
  stop = fixture({ verify: async () => { stop.controller.close(); } }); stop.setPids([20]);
  await stop.controller.handle({ pid: 20, launchedAt: 99900 });
  assert.deepEqual(stop.calls, []);
});


test('gateway settings refresh precedes ownership checks and preserves a newly configured controlled instance', async () => {
  const current = { ...settings }; let owner = ownerFor(30);
  const calls = [];
  const controller = createLaunchController({ settings: current, readOwner: () => owner, fingerprint: pid => `start-${pid}`,
    findProcesses: () => [30], refresh: () => { current.gateway = 'https://new.example.test'; owner.gateway = current.gateway; },
    now: () => 100000, verify: () => calls.push('verify'), launch: () => calls.push('launch'), handoff: () => calls.push('handoff') });
  await controller.handle({ pid: 30, launchedAt: 99900 });
  assert.deepEqual(calls, []);
});
