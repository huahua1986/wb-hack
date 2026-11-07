import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs, validateModuleTree, sha256File, signCandidateApp, validateOfficialSdk, validateHelperLayout, renameCandidateHelpers, rendererTreeDigest, validateRendererTree, validateHarnessSources, validateSourceIdentity, validatePiReleaseIdentity, validateToolPayloadIdentity, TOOL_PAYLOAD_PIN, PI_RELEASE_PIN, PI_VERSION, BUILD_VERSION, DMG_FILENAME } from '../package-dmg/build.mjs';
import { ORIGINAL_ASAR_SHA256, LEGACY_ORIGINAL_ASAR_SHA256, ORIGINAL_RENDERER } from '../package-dmg/patches.mjs';
import { inspectAsar } from '../package-dmg/asar.mjs';
import { applyNativePreviewPatch, NATIVE_PREVIEW_MEMBER } from '../package-dmg/native-preview-patch.mjs';
import { applyNativeArtifactPreviewPatch } from '../package-dmg/native-artifact-preview-patch.mjs';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dmg-build-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('new source build contract is WorkBuddy 5.11.1 and Pi 1.5.0, release 0.4.13', () => {
  assert.equal(BUILD_VERSION, '0.4.13'); assert.equal(PI_VERSION, '1.5.0');
  assert.equal(DMG_FILENAME, '金融buddy-5.11.1-0.4.13-arm64-internal.dmg');
});

const nativeSource = process.env.WORKBUDDY_TEST_SOURCE_ASAR ?? '/Applications/WorkBuddy.app/Contents/Resources/app.asar';
const hasCurrentSource = fs.existsSync(nativeSource) && sha256File(nativeSource) === ORIGINAL_ASAR_SHA256;
test('one pinned preview fix reconstructs the complete original renderer tree and rejects any additional mutation', { skip: !hasCurrentSource }, () => {
  const original = inspectAsar(nativeSource), preview = applyNativePreviewPatch(original);
  const patched = { entries: original.entries, read: name => name === preview.member ? preview.bytes : original.read(name) };
  assert.deepEqual(validateRendererTree(patched, ORIGINAL_RENDERER, preview.metadata), ORIGINAL_RENDERER);
  assert.notDeepEqual(rendererTreeDigest(patched), ORIGINAL_RENDERER);
  const another = original.entries.find(e => e.path.startsWith('renderer/') && e.path !== NATIVE_PREVIEW_MEMBER && !e.entry.files && !e.entry.link).path;
  const drift = { entries: original.entries, read: name => name === another ? Buffer.concat([patched.read(name), Buffer.from('unexpected')]) : patched.read(name) };
  assert.throws(() => validateRendererTree(drift, ORIGINAL_RENDERER, preview.metadata), /beyond the audited/);
  assert.throws(() => validateRendererTree(patched, ORIGINAL_RENDERER, { ...preview.metadata, originalSHA256: '0'.repeat(64) }), /audited pin/);
  assert.throws(() => validateRendererTree(original, ORIGINAL_RENDERER, preview.metadata), /audited pin/);
  assert.deepEqual(validateRendererTree(original, ORIGINAL_RENDERER), ORIGINAL_RENDERER);
  assert.throws(() => rendererTreeDigest(original, { sourceHashes: { 'renderer/missing.js': '0'.repeat(64) } }), /Invalid renderer source hash/);
});

test('complete atomic preview patch set is audited per member and cannot hide an omitted or duplicate member', { skip: !hasCurrentSource }, () => {
  const original = inspectAsar(nativeSource);
  const patches = [applyNativePreviewPatch(original), ...applyNativeArtifactPreviewPatch(original).patches];
  assert.equal(patches.length, 6);
  const replacements = new Map(patches.map(p => [p.member, p.bytes]));
  const archive = { entries: original.entries, read: name => replacements.get(name) ?? original.read(name) };
  const metadata = patches.map(p => p.metadata);
  assert.deepEqual(validateRendererTree(archive, ORIGINAL_RENDERER, metadata), ORIGINAL_RENDERER);
  assert.throws(() => validateRendererTree(archive, ORIGINAL_RENDERER, metadata.slice(1)), /beyond the audited/);
  assert.throws(() => validateRendererTree(archive, ORIGINAL_RENDERER, [...metadata, metadata[0]]), /audited pin/);
  assert.throws(() => validateRendererTree(archive, ORIGINAL_RENDERER, metadata.map((p, i) => i === 2 ? { ...p, patchedSHA256: '0'.repeat(64) } : p)), /audited pin/);
});

test('source identity rejects older applications, repackaged bases and altered native renderer assets', () => {
  const original = { asarSHA256: ORIGINAL_ASAR_SHA256, headerSHA256: 'header', rendererTree: ORIGINAL_RENDERER };
  const info = { CFBundleShortVersionString: '5.11.1', CFBundleIdentifier: 'com.tencent.workbuddy.mac', ElectronAsarIntegrity: { 'Resources/app.asar': { hash: 'header' } } };
  assert.doesNotThrow(() => validateSourceIdentity(info, original));
  assert.throws(() => validateSourceIdentity({ ...info, CFBundleShortVersionString: '5.9.1' }, original), /official WorkBuddy 5.11.1/);
  assert.throws(() => validateSourceIdentity({ ...info, CFBundleIdentifier: 'com.tencent.workbuddy.mac.pi.local' }, original), /official WorkBuddy 5.11.1/);
  assert.throws(() => validateSourceIdentity(info, { ...original, asarSHA256: LEGACY_ORIGINAL_ASAR_SHA256 }), /verified 5.11.1/);
  assert.throws(() => validateSourceIdentity(info, { ...original, rendererTree: { ...ORIGINAL_RENDERER, files: 1957 } }), /verified 5.11.1/);
  assert.throws(() => validateSourceIdentity(info, { ...original, headerSHA256: 'changed' }), /verified 5.11.1/);
});

test('Pi release pins every module and the reviewed lock/provenance without accepting version-only matches', () => {
  const pkg = { name: '@earendil-works/pi-coding-agent', version: '1.5.0' };
  const digest = { files: PI_RELEASE_PIN.files, links: PI_RELEASE_PIN.links, sha256: PI_RELEASE_PIN.sha256 };
  assert.equal(validatePiReleaseIdentity(pkg, digest, PI_RELEASE_PIN.packageLockSHA256, PI_RELEASE_PIN.provenanceSHA256).version, '1.5.0');
  assert.throws(() => validatePiReleaseIdentity({ ...pkg, version: '1.1.0' }, digest), /must be 1.5.0/);
  assert.throws(() => validatePiReleaseIdentity(pkg, { ...digest, sha256: '0'.repeat(64) }, PI_RELEASE_PIN.packageLockSHA256, PI_RELEASE_PIN.provenanceSHA256), /pin mismatch/);
  assert.throws(() => validatePiReleaseIdentity(pkg, digest, '0'.repeat(64), PI_RELEASE_PIN.provenanceSHA256), /pin mismatch/);
  assert.throws(() => validatePiReleaseIdentity(pkg, digest, PI_RELEASE_PIN.packageLockSHA256, '0'.repeat(64)), /pin mismatch/);
});

test('offline grep/find tools are separately pinned with their license/provenance files', () => {
  const digest = { files: TOOL_PAYLOAD_PIN.files, links: TOOL_PAYLOAD_PIN.links, sha256: TOOL_PAYLOAD_PIN.sha256 };
  const result = validateToolPayloadIdentity(digest, TOOL_PAYLOAD_PIN.provenanceSHA256);
  assert.equal(result.sourceBinaries.rg, TOOL_PAYLOAD_PIN.rgSHA256); assert.equal(result.sourceBinaries.fd, TOOL_PAYLOAD_PIN.fdSHA256);
  assert.throws(() => validateToolPayloadIdentity({ ...digest, files: 11 }, TOOL_PAYLOAD_PIN.provenanceSHA256), /tool payload.*pin/);
  assert.throws(() => validateToolPayloadIdentity({ ...digest, sha256: '0'.repeat(64) }, TOOL_PAYLOAD_PIN.provenanceSHA256), /tool payload.*pin/);
  assert.throws(() => validateToolPayloadIdentity(digest, '0'.repeat(64)), /tool payload.*pin/);
});

test('renderer asset digest ignores backend changes but detects native interface changes', () => {
  const entries=[{path:'main/index.js',entry:{}},{path:'renderer/index.html',entry:{}},{path:'renderer/assets/app.js',entry:{}}];
  const values={'main/index.js':Buffer.from('main'),'renderer/index.html':Buffer.from('html'),'renderer/assets/app.js':Buffer.from('react')};
  const archive={entries,read:name=>values[name]},before=rendererTreeDigest(archive);
  values['main/index.js']=Buffer.from('pi entry');assert.deepEqual(rendererTreeDigest(archive),before);
  values['renderer/assets/app.js']=Buffer.from('modified UI');assert.notEqual(rendererTreeDigest(archive).sha256,before.sha256);
});

test('harness syntax is checked before a candidate is created without executing source code', t => {
  const root=temporary(t),src=path.join(root,'src');fs.mkdirSync(src);
  fs.writeFileSync(path.join(src,'main.mjs'),'throw new Error("must never execute");');
  assert.deepEqual(validateHarnessSources(root),{javascriptFilesChecked:1});
  fs.writeFileSync(path.join(src,'main.mjs'),'export const = ;');
  assert.throws(()=>validateHarnessSources(root));
});

test('Electron helpers follow the internal bundle name rather than the visible brand', { skip: process.platform !== 'darwin' }, t => {
  const root = temporary(t), app = path.join(root, '金融buddy.app');
  for (const suffix of ['', ' (Renderer)', ' (GPU)', ' (Plugin)']) {
    const name = 'WorkBuddy Helper' + suffix, contents = path.join(app, 'Contents/Frameworks', name + '.app', 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(contents, 'MacOS', name), 'helper fixture');
    fs.writeFileSync(path.join(contents, 'Info.plist'), JSON.stringify({ CFBundleExecutable: name }));
  }
  assert.deepEqual(validateHelperLayout(app, 'WorkBuddy'), { internalName: 'WorkBuddy', helpers: 4 });
  assert.throws(() => validateHelperLayout(app, '金融buddy'), /ENOENT/);
  assert.throws(() => validateHelperLayout(app, '../outside'), /Invalid/);
  fs.writeFileSync(path.join(app,'Contents/Info.plist'),JSON.stringify({CFBundleIdentifier:'com.tencent.workbuddy.mac',CFBundleName:'金融buddy'}));
  assert.throws(()=>renameCandidateHelpers(app,'WorkBuddy'),/Only a branded/);
  fs.writeFileSync(path.join(app,'Contents/Info.plist'),JSON.stringify({CFBundleIdentifier:'com.tencent.workbuddy.mac.pi.local',CFBundleName:'金融buddy'}));
  const result=renameCandidateHelpers(app,'WorkBuddy');
  assert.equal(result.length,4);
  assert.deepEqual(validateHelperLayout(app,'金融buddy'),{internalName:'金融buddy',helpers:4});
  assert.throws(()=>validateHelperLayout(app,'WorkBuddy'),/ENOENT/);
  for(const change of result) assert.equal(sha256File(path.join(app,'Contents/Frameworks',change.after+'.app','Contents/MacOS',change.after)),change.originalExecutableSHA256);
});

test('builder arguments require explicit release/runtime/new output and isolate finalize mode', () => {
  const parsed = parseArgs(['--node-runtime', './runtime', '--pi-release', './release', '--output', './output', '--stage-only']);
  assert.equal(parsed.sourceApp, '/Applications/WorkBuddy.app');
  assert.equal(parsed.output, path.resolve('output'));
  assert.equal(parsed.stageOnly, true);
  assert.deepEqual(parseArgs(['--finalize', './output']), { finalize: path.resolve('output') });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  for (const args of [[], ['--output', './output'], ['--finalize'], ['--bogus'],
    ['--finalize', './output', '--stage-only'], ['--finalize', './output', '--output', './other'],
    ['--output', 'a', '--output', 'b'], ['--stage-only', '--stage-only']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('module copying accepts only contained relative symlinks and ordinary filesystem nodes', (t) => {
  const root = temporary(t), modules = path.join(root, 'node_modules');
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
  fs.mkdirSync(path.join(modules, 'package')); fs.writeFileSync(path.join(modules, 'package/cli.js'), 'export {};');
  fs.symlinkSync('../package/cli.js', path.join(modules, '.bin/pi'));
  assert.deepEqual(validateModuleTree(modules), { files: 1, links: 1 });
  fs.symlinkSync(path.join(modules, 'package/cli.js'), path.join(modules, 'absolute'));
  assert.throws(() => validateModuleTree(modules), /Absolute.*not portable/);
  fs.unlinkSync(path.join(modules, 'absolute'));
  fs.writeFileSync(path.join(root, 'private-config.json'), 'never copy this');
  fs.symlinkSync('../private-config.json', path.join(modules, 'escape'));
  assert.throws(() => validateModuleTree(modules), /escapes/);
  fs.unlinkSync(path.join(modules, 'escape'));
  fs.symlinkSync('missing', path.join(modules, 'dangling'));
  assert.throws(() => validateModuleTree(modules), /ENOENT/);
});

test('source digests reject symlink substitution and match known SHA-256', (t) => {
  const root = temporary(t), file = path.join(root, 'file');
  fs.writeFileSync(file, 'fixture'); fs.symlinkSync('file', path.join(root, 'link'));
  assert.equal(sha256File(file), crypto.createHash('sha256').update('fixture').digest('hex'));
  assert.throws(() => sha256File(path.join(root, 'link')), /ordinary file/);
  assert.throws(() => sha256File(root), /ordinary file/);
});

test('signing API refuses an original-named application before invoking codesign', (t) => {
  const root = temporary(t), original = path.join(root, 'WorkBuddy.app');
  fs.mkdirSync(original);
  assert.throws(() => signCandidateApp(original), /Only a staged branded Pi application/);
  assert.deepEqual(fs.readdirSync(original), []);
});

test('official build rejects an altered source SDK and provenance before staging', (t) => {
  const root = temporary(t), src = path.join(root, 'src'); fs.mkdirSync(src);
  const provenanceFile = path.join(src, 'official-aicc-sdk.provenance.json');
  fs.copyFileSync(new URL('../src/official-aicc-sdk.provenance.json', import.meta.url), provenanceFile);
  const provenance = JSON.parse(fs.readFileSync(provenanceFile));
  const altered = Buffer.alloc(provenance.bytes);
  assert.throws(() => validateOfficialSdk(root, altered), /source chunk differs/);
  provenance.sourceMember = 'cli/dist/codebuddy.mjs'; fs.writeFileSync(provenanceFile, JSON.stringify(provenance));
  assert.throws(() => validateOfficialSdk(root, altered), /provenance differs/);
});

test('official build verifies the pinned ASAR chunk without a workspace SDK and verifies the staged copy', { skip: !hasCurrentSource }, (t) => {
  const root = temporary(t), src = path.join(root, 'src'); fs.mkdirSync(src);
  fs.copyFileSync(new URL('../src/official-aicc-sdk.provenance.json', import.meta.url), path.join(src, 'official-aicc-sdk.provenance.json'));
  const module = inspectAsar(nativeSource).read('cli/dist/lazy-lite-wb/6951.67f39af7.mjs');
  const result = validateOfficialSdk(root, module);
  assert.equal(result.name, '@tencent/tcaicc'); assert.equal(result.version, '1.4.0');
  assert.equal(result.bundledModuleSHA256, result.sourceSHA256); assert.match(result.licenseStatus, /No standalone/);
  const moduleFile = path.join(src, 'official-aicc-sdk.mjs');
  fs.writeFileSync(moduleFile, module);
  assert.deepEqual(validateOfficialSdk(root), result);
  const altered = Buffer.from(module); altered[altered.length - 1] ^= 1; fs.writeFileSync(moduleFile, altered);
  assert.throws(() => validateOfficialSdk(root), /differs from the original/);
});
