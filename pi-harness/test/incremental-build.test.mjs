import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BASE_BUILD_PIN, LEGACY_BASE_BUILD_PINS, parseArgs, sha256File, moduleTreeDigest,
  validateBaseBuildIdentity, validateBaseBuild, validateBundledHarness,
  copyIncrementalCandidate, stageIncrementalBuild,
} from '../package-dmg/build.mjs';
import { LEGACY_ORIGINAL_ASAR_SHA256, REMOVED_ENGINE_TREES } from '../package-dmg/patches.mjs';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-legacy-build-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}
function acceptedIdentity(version = '0.3.0') {
  const pin = LEGACY_BASE_BUILD_PINS[version];
  const rendererTree = { files: pin.rendererFiles, sha256: pin.rendererSHA256 };
  return {
    kind: 'workbuddy-pi-dmg', formatVersion: 1, buildVersion: version, workbuddyVersion: '5.9.1',
    bundle: 'staging/金融buddy.app', bundleIdentifier: 'com.tencent.workbuddy.mac.pi.local',
    signature: 'ad-hoc-not-notarized', userDataIncluded: false, status: 'packaged',
    runtimeAcceptance: { allChecksPassed: true }, signing: { strictDeepVerified: true },
    original: { asarSHA256: LEGACY_ORIGINAL_ASAR_SHA256, rendererTree },
    candidate: { asarSHA256: pin.asarSHA256, rendererTree },
    dmg: { file: pin.dmgFile, sha256: pin.dmgSHA256, hdiutilVerified: true },
    removedEngineTrees: REMOVED_ENGINE_TREES,
    buildSources: Object.fromEntries(Array.from({ length: pin.sourceFiles }, (_, index) => [`src/file-${index}.mjs`, 'a'.repeat(64)])),
  };
}
const pinnedHashes = (version = '0.3.0') => {
  const pin = LEGACY_BASE_BUILD_PINS[version];
  return { manifestSHA256: pin.manifestSHA256, dmgSHA256: pin.dmgSHA256, asarSHA256: pin.asarSHA256 };
};

test('legacy base modes cannot create a WorkBuddy 5.11.1 release through CLI or exported mutation APIs', t => {
  const root = temporary(t), output = path.join(root, 'must-not-exist');
  const args = ['--base-build', '/accepted/base', '--output', output, '--stage-only'];
  assert.throws(() => parseArgs(args), /5.11.1.*original.*legacy --base-build/);
  for (const flag of ['--source-app', '--node-runtime', '--pi-release', '--finalize']) {
    assert.throws(() => parseArgs([...args, flag, '/other']), /5.11.1.*original|accepts only/);
  }
  assert.throws(() => stageIncrementalBuild({ baseBuild: '/accepted/base', output, stageOnly: true }), /5.11.1.*original/);
  assert.throws(() => copyIncrementalCandidate('/accepted/base', output), /5.11.1.*original/);
  assert.equal(fs.existsSync(output), false);
});

test('both accepted historical deliveries remain separately pinned for read-only recovery verification', () => {
  assert.equal(BASE_BUILD_PIN, LEGACY_BASE_BUILD_PINS['0.3.0']);
  assert.equal(LEGACY_BASE_BUILD_PINS['0.3.1'].manifestSHA256, 'aaa39d937659668258eaca03938411ea0d5a5ed22df6e2aad5d548e67cf04659');
  assert.equal(LEGACY_BASE_BUILD_PINS['0.3.1'].dmgSHA256, '0f582780f1992e9ee8844a5d6e0671be6a9182a09020d2ae35040bc693673048');
  for (const version of ['0.3.0', '0.3.1']) {
    assert.equal(validateBaseBuildIdentity(acceptedIdentity(version), pinnedHashes(version)).buildVersion, version);
    for (const [key, message] of [['manifestSHA256', /manifest pin/], ['dmgSHA256', /DMG pin/], ['asarSHA256', /ASAR pin/]]) {
      assert.throws(() => validateBaseBuildIdentity(acceptedIdentity(version), { ...pinnedHashes(version), [key]: '0'.repeat(64) }), message);
    }
    const sourceUpgrade = acceptedIdentity(version); sourceUpgrade.workbuddyVersion = '5.11.1';
    assert.throws(() => validateBaseBuildIdentity(sourceUpgrade, pinnedHashes(version)), /legacy Pi build/);
    const changedUi = acceptedIdentity(version); changedUi.candidate.rendererTree = { ...changedUi.candidate.rendererTree, files: 1957 };
    assert.throws(() => validateBaseBuildIdentity(changedUi, pinnedHashes(version)), /provenance/);
  }
});

test('an unpinned historical base fails before application access or filesystem mutation', t => {
  const root = temporary(t), base = path.join(root, 'base'); fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'manifest.json'), JSON.stringify(acceptedIdentity('0.3.1')));
  assert.throws(() => validateBaseBuild(base), /Base manifest pin mismatch/);
  assert.deepEqual(fs.readdirSync(base), ['manifest.json']);
  assert.throws(() => validateBaseBuild('./base'), /absolute/);
});

test('bundled harness verifies the complete file set and rejects undeclared data or links', t => {
  const root = temporary(t), harness = path.join(root, 'harness');
  fs.mkdirSync(path.join(harness, 'src'), { recursive: true }); fs.mkdirSync(path.join(harness, 'package-dmg'));
  fs.writeFileSync(path.join(harness, 'package.json'), '{}');
  fs.writeFileSync(path.join(harness, 'src/main.mjs'), 'export {};');
  fs.writeFileSync(path.join(harness, 'package-dmg/approval-extension.mjs'), 'export {};');
  const names = ['package.json', 'src/main.mjs', 'package-dmg/approval-extension.mjs'];
  const sources = Object.fromEntries(names.map(name => [name, sha256File(path.join(harness, name))]));
  sources['package-dmg/build.mjs'] = 'a'.repeat(64);
  assert.equal(validateBundledHarness(harness, sources).files, 3);
  fs.writeFileSync(path.join(harness, 'src/main.mjs'), 'changed');
  assert.throws(() => validateBundledHarness(harness, sources), /differs/);
  fs.writeFileSync(path.join(harness, 'src/main.mjs'), 'export {};');
  fs.writeFileSync(path.join(harness, 'pi-config.json'), 'private');
  assert.throws(() => validateBundledHarness(harness, sources), /differs/);
  fs.unlinkSync(path.join(harness, 'pi-config.json')); fs.mkdirSync(path.join(harness, 'sessions'));
  assert.throws(() => validateBundledHarness(harness, sources), /unexpected directory/);
  fs.rmdirSync(path.join(harness, 'sessions')); fs.symlinkSync('main.mjs', path.join(harness, 'src/link.mjs'));
  assert.throws(() => validateBundledHarness(harness, sources), /nonordinary/);
  fs.unlinkSync(path.join(harness, 'src/link.mjs'));
  assert.throws(() => validateBundledHarness(harness, { ...sources, 'src/../account.json': 'a'.repeat(64) }), /Invalid/);
});

test('PiEngine identity covers file bytes, relative links and empty directories', t => {
  const root = temporary(t), engine = path.join(root, 'engine');
  fs.mkdirSync(path.join(engine, 'empty'), { recursive: true });
  fs.writeFileSync(path.join(engine, 'one'), 'one'); fs.writeFileSync(path.join(engine, 'two'), 'two');
  fs.symlinkSync('one', path.join(engine, 'link'));
  const original = moduleTreeDigest(engine); assert.equal(original.files, 2); assert.equal(original.links, 1);
  fs.writeFileSync(path.join(engine, 'one'), 'changed'); assert.notEqual(moduleTreeDigest(engine).sha256, original.sha256);
  fs.writeFileSync(path.join(engine, 'one'), 'one');
  fs.unlinkSync(path.join(engine, 'link')); fs.symlinkSync('two', path.join(engine, 'link'));
  assert.notEqual(moduleTreeDigest(engine).sha256, original.sha256);
  fs.unlinkSync(path.join(engine, 'link')); fs.symlinkSync('one', path.join(engine, 'link')); fs.rmdirSync(path.join(engine, 'empty'));
  assert.notEqual(moduleTreeDigest(engine).sha256, original.sha256);
});
