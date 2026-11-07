import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { inspectAsar, repackAsar } from './asar.mjs';
import { ORIGINAL_ASAR_SHA256, LEGACY_ORIGINAL_ASAR_SHA256, WORKBUDDY_VERSION, ORIGINAL_RENDERER, REMOVED_ENGINE_TREES, patchMembers, removeEngine } from './patches.mjs';
import branding from '../src/branding.cjs';
import { applyNativePreviewPatch, NATIVE_PREVIEW_MEMBER, NATIVE_PREVIEW_ORIGINAL_SHA256, NATIVE_PREVIEW_PATCHED_SHA256 } from './native-preview-patch.mjs';
import { applyNativeArtifactPreviewPatch, NATIVE_ARTIFACT_PREVIEW_PINS } from './native-artifact-preview-patch.mjs';
import { applyNativeHomeRoutePatch, NATIVE_HOME_ROUTE_PIN } from './native-home-route-patch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.dirname(HERE);
const BUNDLE_NAME = `${branding.DISPLAY_NAME}.app`;
const BUNDLE_ID = 'com.tencent.workbuddy.mac.pi.local';
const SOURCE_TEAM_ID = 'FN2V63AD2J';
const BUILD_KIND = 'workbuddy-pi-dmg';
export const BUILD_VERSION = '0.4.13';
const PREVIEW_PINS = new Map([{ member: NATIVE_PREVIEW_MEMBER, originalSHA256: NATIVE_PREVIEW_ORIGINAL_SHA256,
  patchedSHA256: NATIVE_PREVIEW_PATCHED_SHA256 }, ...NATIVE_ARTIFACT_PREVIEW_PINS].map(pin => [pin.member, pin]));
const RENDERER_PINS = new Map([...PREVIEW_PINS, [NATIVE_HOME_ROUTE_PIN.member, NATIVE_HOME_ROUTE_PIN]]);
export const DOCUMENT_ENGINE_PIN = Object.freeze({
  files: 35, links: 0, sha256: 'd51cc4b9ab35b36efd982e83b37ee4bccbbc13b2194ab9a6afd54743591c38b8',
  lockSHA256: 'c512f02636dd4844e643d8e71875d7c8830dc235252e67f5690243df53529281',
});
const GOLD_ICON_FILE = 'icon.icns';
const GOLD_ICON_ASSET = 'financialbuddy-gold.icns';
export const PI_VERSION = '1.5.0';
export const PI_RELEASE_PIN = Object.freeze({
  version: PI_VERSION, files: 15162, links: 8,
  sha256: 'fc934a74e6c0d0be4cdadd558149933dd19a58f9ebe0130d1c01c181bf4bf4fe',
  packageLockSHA256: '9e057b44ad561fa63a2aba22ad8889a9763d1578a644a05a1b1ae616d0c84c0f',
  provenanceSHA256: 'b31711dd3ee2fe4ccc956736c4f6219af0a7975d2118120dd384fec2c7e4e8d1',
});
export const TOOL_PAYLOAD_PIN = Object.freeze({
  files: 12, links: 0, sha256: 'aa7e9490456a5fd8f1dfbb80f37745a246a2e4d142b636b6eacd542bfef267c3',
  provenanceSHA256: 'e0119f6dc8e77a1b55c3a046c6503d9e9e45906b32eff83cc8ded0d3ee6a1bae',
  rgSHA256: 'a326a1fb48074202e9ad41e4cd1e389eeea372c8c6f7d7e80da81176d5d9430e',
  fdSHA256: 'cf3bde435da174f41cf9589a2efeaf03804df7c250fc15e8b8a1e9bfc66ebc9a',
});
export const DMG_FILENAME = `${branding.DISPLAY_NAME}-${WORKBUDDY_VERSION}-${BUILD_VERSION}-arm64-internal.dmg`;
export const BASE_BUILD_PIN = Object.freeze({
  buildVersion: '0.3.0',
  manifestSHA256: 'fd70ee01b12ed806d9e844f7c35c99dccd244306b2716a200e8b3ac35258d93d',
  dmgFile: `${branding.DISPLAY_NAME}-5.9.1-0.3.0-arm64-internal.dmg`,
  dmgSHA256: 'cfa563d8024dfcd8fc935af00dea65d9832f8286adedc516b1cb1084f5a0973b',
  asarSHA256: '30a2cf892ac73edebc1eea291f8c5f11354724269c13d08274b9115fc143d536',
  rendererFiles: 1958,
  rendererSHA256: '781aea7843d79f21dbed84deb1518a23d0541483186b16e842994df439645740',
  signedNodeSHA256: 'ad41db092a539459e70bdf69556dbd01485c4d40a8cfe0eb482f3c29bd7ebea8',
  piEngineFiles: 14993,
  piEngineLinks: 9,
  piEngineSHA256: 'a547411cfa250993fa1060808fda305f7df80835699d495ab2125b03f36a14ea',
  sourceFiles: 30,
  harnessFiles: 26,
});
export const LEGACY_BASE_BUILD_PINS = Object.freeze({
  '0.3.0': BASE_BUILD_PIN,
  '0.3.1': Object.freeze({
    ...BASE_BUILD_PIN, buildVersion: '0.3.1', sourceFiles: 31, harnessFiles: 27,
    manifestSHA256: 'aaa39d937659668258eaca03938411ea0d5a5ed22df6e2aad5d548e67cf04659',
    dmgFile: `${branding.DISPLAY_NAME}-5.9.1-0.3.1-arm64-internal.dmg`,
    dmgSHA256: '0f582780f1992e9ee8844a5d6e0671be6a9182a09020d2ae35040bc693673048',
  }),
});
const OFFICIAL_SDK = {
  name: '@tencent/tcaicc', version: '1.4.0', member: 'cli/dist/lazy-lite-wb/6951.67f39af7.mjs',
  module: 'src/official-aicc-sdk.mjs',
  sourceSHA256: 'c62e93beba2a2fc16aadfd8120d920883ec79bdd54f72a715c5bdfd1bf959dee', bytes: 114429,
};
const OFFICIAL_SOURCE_FILES = ['official-model-bridge.cjs', 'official-aicc.cjs', 'official-bridge.mjs', 'official-provider-extension.mjs', 'official-provider-extension.ts'];
const ELECTRON_FUSE_BINARY = 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework';
const PINNED_NODE = {
  version: 'v24.21.0',
  binary: 'e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b',
  license: '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace',
};
const MACHO = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
const log = (event, detail = {}) => process.stdout.write(JSON.stringify({ event, ...detail }) + '\n');

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
}
function regular(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`Expected ordinary file: ${filename}`);
  return stat;
}
function directory(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(`Expected ordinary directory: ${filename}`);
  return fs.realpathSync(filename);
}
function inside(root, filename) { return filename === root || filename.startsWith(root + path.sep); }
export function sha256File(filename) {
  regular(filename);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const hash = crypto.createHash('sha256'), bytes = Buffer.alloc(1024 * 1024);
  try { let size; while ((size = fs.readSync(fd, bytes)) > 0) hash.update(bytes.subarray(0, size)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function walk(root, callback) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const filename = path.join(root, entry.name), stat = fs.lstatSync(filename);
    callback(filename, stat);
    if (stat.isDirectory() && !stat.isSymbolicLink()) walk(filename, callback);
  }
}

/** Copyable npm trees may contain only ordinary files, directories and internal relative symlinks. */
export function validateModuleTree(root) {
  const base = directory(root);
  let files = 0, links = 0;
  walk(base, (filename, stat) => {
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(filename);
      if (path.isAbsolute(link)) throw Error(`Absolute npm symlink is not portable: ${path.relative(base, filename)}`);
      const target = fs.realpathSync(filename);
      if (!inside(base, target)) throw Error(`npm symlink escapes release: ${path.relative(base, filename)}`);
      links++;
    } else if (stat.isFile()) files++;
    else if (!stat.isDirectory()) throw Error(`Unsupported npm node type: ${path.relative(base, filename)}`);
  });
  return { files, links };
}

/** Content identity includes empty directories and the relative targets of npm links. */
export function moduleTreeDigest(root) {
  const base = directory(root), stats = validateModuleTree(base), hash = crypto.createHash('sha256');
  walk(base, (filename, stat) => {
    const relative = path.relative(base, filename).split(path.sep).join('/');
    if (stat.isSymbolicLink()) hash.update('link\0').update(relative).update('\0').update(fs.readlinkSync(filename)).update('\0');
    else if (stat.isDirectory()) hash.update('dir\0').update(relative).update('\0');
    else hash.update('file\0').update(relative).update('\0').update(sha256File(filename)).update('\0');
  });
  return { ...stats, sha256: hash.digest('hex') };
}

function copyTree(source, destination) {
  if (fs.existsSync(destination)) throw Error(`Copy target exists: ${destination}`);
  // ditto preserves source extended attributes and relative links; quarantine is never stripped.
  run('/usr/bin/ditto', [source, destination]);
}
function atomicJson(filename, value) {
  const temp = filename + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, filename); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function plistJson(filename) { return JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', filename])); }
function writeBundleInfo(filename, bundleId, headerHash) {
  const data = plistJson(filename);
  data.CFBundleIdentifier = bundleId;
  data.CFBundleName = branding.DISPLAY_NAME;
  data.CFBundleDisplayName = branding.DISPLAY_NAME;
  data.CFBundleIconFile = GOLD_ICON_FILE;
  const integrity = data.ElectronAsarIntegrity?.['Resources/app.asar'];
  if (integrity?.algorithm !== 'SHA256') throw Error('Unsupported Electron ASAR integrity declaration');
  integrity.hash = headerHash;
  const temp = filename + '.' + crypto.randomUUID() + '.json';
  try {
    fs.writeFileSync(temp, JSON.stringify(data), { flag: 'wx', mode: 0o644 });
    run('/usr/bin/plutil', ['-convert', 'xml1', '-o', filename, temp]);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function infoChanges(original, candidate) {
  const before = structuredClone(original), after = structuredClone(candidate);
  if (after.CFBundleName !== branding.DISPLAY_NAME || after.CFBundleDisplayName !== branding.DISPLAY_NAME) throw Error('Candidate display name differs');
  delete before.CFBundleName; delete after.CFBundleName;
  delete before.CFBundleDisplayName; delete after.CFBundleDisplayName;
  delete before.CFBundleIdentifier; delete after.CFBundleIdentifier;
  if (after.CFBundleIconFile !== before.CFBundleIconFile) {
    if (after.CFBundleIconFile !== GOLD_ICON_FILE) throw Error('Unexpected application icon');
    delete before.CFBundleIconFile; delete after.CFBundleIconFile;
  }
  delete before.ElectronAsarIntegrity['Resources/app.asar'].hash;
  delete after.ElectronAsarIntegrity['Resources/app.asar'].hash;
  if (!isDeepStrictEqual(before, after)) throw Error('Unexpected Info.plist changes');
}
function isMachO(filename) {
  const fd = fs.openSync(filename, 'r'), bytes = Buffer.alloc(4);
  try { return fs.readSync(fd, bytes, 0, 4, 0) === 4 && MACHO.has(bytes.toString('hex')); }
  finally { fs.closeSync(fd); }
}

export function validateHelperLayout(app, internalName) {
  if (typeof internalName !== 'string' || !/^[^/\\\x00-\x1f]{1,128}$/.test(internalName)) throw Error('Invalid internal application name');
  for (const suffix of ['', ' (Renderer)', ' (GPU)', ' (Plugin)']) {
    const name = `${internalName} Helper${suffix}`;
    const contents = path.join(app, 'Contents/Frameworks', name + '.app', 'Contents');
    regular(path.join(contents, 'MacOS', name));
    if (plistJson(path.join(contents, 'Info.plist')).CFBundleExecutable !== name) throw Error('Electron helper executable differs');
  }
  return { internalName, helpers: 4 };
}

export function renameCandidateHelpers(app, originalName) {
  const root = directory(app), info = plistJson(path.join(root, 'Contents/Info.plist'));
  if (path.basename(root) !== BUNDLE_NAME || info.CFBundleIdentifier !== BUNDLE_ID || info.CFBundleName !== branding.DISPLAY_NAME) throw Error('Only a branded Pi candidate may rename helpers');
  validateHelperLayout(root, originalName);
  const changes = [];
  for (const suffix of ['', ' (Renderer)', ' (GPU)', ' (Plugin)']) {
    const before = `${originalName} Helper${suffix}`, after = `${branding.DISPLAY_NAME} Helper${suffix}`;
    const previous = path.join(root, 'Contents/Frameworks', before + '.app'), next = path.join(root, 'Contents/Frameworks', after + '.app');
    directory(previous);
    const contents = path.join(previous, 'Contents'), oldExecutable = path.join(contents, 'MacOS', before), newExecutable = path.join(contents, 'MacOS', after);
    if (fs.existsSync(next) || fs.existsSync(newExecutable)) throw Error('Branded helper target already exists');
    const executableSHA256 = sha256File(oldExecutable), plist = path.join(contents, 'Info.plist'), data = plistJson(plist);
    data.CFBundleExecutable = after; data.CFBundleName = after; data.CFBundleDisplayName = after;
    const temporary = plist + '.' + crypto.randomUUID() + '.brand.json';
    try {
      fs.writeFileSync(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o644 });
      run('/usr/bin/plutil', ['-convert', 'xml1', '-o', plist, temporary]);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    fs.renameSync(oldExecutable, newExecutable);
    if (sha256File(newExecutable) !== executableSHA256) throw Error('Helper code changed during rename');
    fs.renameSync(previous, next);
    changes.push({ before, after, originalExecutableSHA256: executableSHA256 });
  }
  validateHelperLayout(root, branding.DISPLAY_NAME);
  return changes;
}
function signed(filename) {
  try { run('/usr/bin/codesign', ['-d', filename], { stdio: ['ignore', 'pipe', 'pipe'] }); return true; }
  catch { return false; }
}

/** Inside-out signing of the candidate only. Existing DER entitlements/flags are preserved. */
export function signCandidateApp(app) {
  const root = directory(app);
  if (!root.endsWith(path.sep + BUNDLE_NAME)) throw Error('Only a staged branded Pi application may be signed');
  const info = plistJson(path.join(root, 'Contents/Info.plist'));
  if (info.CFBundleIdentifier !== BUNDLE_ID) throw Error('Refusing to sign a non-Pi bundle');
  validateModuleTree(root);
  const targets = [];
  walk(root, (filename, stat) => {
    if (stat.isFile() && isMachO(filename)) targets.push(filename);
    else if (stat.isDirectory() && /\.(?:app|framework|xpc|appex)$/.test(filename)) targets.push(filename);
  });
  targets.push(root);
  targets.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || a.localeCompare(b, 'en'));
  let preserved = 0;
  for (const target of targets) {
    const metadata = signed(target) ? ['--preserve-metadata=entitlements,flags,runtime'] : [];
    if (metadata.length) preserved++;
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', ...metadata, target], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { method: 'ad-hoc-not-notarized', targets: targets.length, metadataPreservedTargets: preserved, strictDeepVerified: true };
}

function fuseBytes(filename) {
  const bytes = fs.readFileSync(filename), sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const at = bytes.indexOf(sentinel);
  if (at < 0 || bytes.indexOf(sentinel, at + sentinel.length) >= 0) throw Error('Electron fuse sentinel missing or ambiguous');
  const start = at + sentinel.length, count = bytes[start + 1];
  if (!count || count > 64 || start + 2 + count > bytes.length) throw Error('Invalid Electron fuse wire');
  return bytes.subarray(start, start + 2 + count).toString('hex');
}
export function rendererTreeDigest(archive, { sourceHashes = {} } = {}) {
  const rows = archive.entries.filter(({ path: name, entry }) => name.startsWith('renderer/') && !entry.files && !entry.link).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  for (const [name, value] of Object.entries(sourceHashes)) if (!rows.some(row => row.path === name) || !/^[a-f0-9]{64}$/.test(value)) throw Error('Invalid renderer source hash override');
  const hash = crypto.createHash('sha256');
  for (const { path: name } of rows) hash.update(name).update('\0').update(Object.hasOwn(sourceHashes, name)
    ? Buffer.from(sourceHashes[name], 'hex') : crypto.createHash('sha256').update(archive.read(name)).digest());
  return { files: rows.length, sha256: hash.digest('hex') };
}

/** Prove all unpatched renderer members still equal the pinned source tree. */
export function validateRendererTree(archive, sourceTree, rendererPatch) {
  if (!rendererPatch) {
    const tree = rendererTreeDigest(archive);
    if (!isDeepStrictEqual(tree, sourceTree)) throw Error('Original renderer assets changed');
    return tree;
  }
  const patches = Array.isArray(rendererPatch) ? rendererPatch : [rendererPatch], sourceHashes = {};
  if (!patches.length) throw Error('Renderer patch provenance is empty');
  for (const patch of patches) {
    const pin = RENDERER_PINS.get(patch?.member);
    if (!pin || Object.hasOwn(sourceHashes, patch.member) || patch.originalSHA256 !== pin.originalSHA256
      || patch.patchedSHA256 !== pin.patchedSHA256
      || crypto.createHash('sha256').update(archive.read(pin.member)).digest('hex') !== pin.patchedSHA256) throw Error('Renderer patch differs from its audited pin');
    sourceHashes[pin.member] = pin.originalSHA256;
  }
  const reconstructed = rendererTreeDigest(archive, { sourceHashes });
  if (!isDeepStrictEqual(reconstructed, sourceTree)) throw Error('Renderer changes extend beyond the audited patch set');
  return reconstructed;
}

function snapshot(app) {
  const resources = path.join(app, 'Contents/Resources'), asar = path.join(resources, 'app.asar');
  const archive = inspectAsar(asar);
  const products = {};
  for (const { path: filename, entry } of archive.entries) {
    if (!entry.files && !entry.link && /^cli\/product[^/]*\.json$/.test(filename)) products[filename] = crypto.createHash('sha256').update(archive.read(filename)).digest('hex');
  }
  return {
    asarSHA256: sha256File(asar), headerSHA256: archive.headerHash,
    rendererTree: rendererTreeDigest(archive),
    executableSHA256: sha256File(path.join(app, 'Contents/MacOS/Electron')),
    fuseBinary: ELECTRON_FUSE_BINARY,
    fuseWireHex: fuseBytes(path.join(app, ELECTRON_FUSE_BINARY)),
    productFiles: products,
  };
}
export function parseArgs(args) {
  const result = {};
  const valued = new Map([['--source-app', 'sourceApp'], ['--base-build', 'baseBuild'], ['--node-runtime', 'nodeRuntime'], ['--pi-release', 'piRelease'], ['--output', 'output'], ['--finalize', 'finalize']]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--stage-only') { if (result.stageOnly) throw Error('Repeated --stage-only'); result.stageOnly = true; }
    else if (arg === '--help') result.help = true;
    else if (valued.has(arg)) {
      const key = valued.get(arg), value = args[++i];
      if (!value || value.startsWith('--') || result[key]) throw Error(`Missing or repeated ${arg}`);
      result[key] = path.resolve(value);
    } else throw Error(`Unknown argument: ${arg}`);
  }
  if (result.help) return result;
  if (result.finalize) {
    if (Object.keys(result).some((key) => key !== 'finalize')) throw Error('--finalize accepts only an existing output directory');
  } else if (result.baseBuild) {
    throw Error('WorkBuddy 5.11.1 / 0.4.13 requires a verified original --source-app; legacy --base-build cannot produce this release');
  } else {
    if (!result.output || !result.nodeRuntime || !result.piRelease) throw Error('--output, --node-runtime and --pi-release are required');
    result.sourceApp ??= '/Applications/WorkBuddy.app';
  }
  return result;
}

function newOutput(filename, sourceApp) {
  const parent = directory(path.dirname(filename)), target = path.join(parent, path.basename(filename));
  if (inside(sourceApp, target) || inside(target, sourceApp) || target === path.parse(target).root) throw Error('Output conflicts with source application');
  fs.mkdirSync(target, { mode: 0o700 });
  return target;
}
function validateRuntime(runtime) {
  directory(runtime);
  if (!isDeepStrictEqual(fs.readdirSync(runtime).sort(), ['LICENSE', 'node'])) throw Error('Node runtime contains unexpected files');
  if (sha256File(path.join(runtime, 'node')) !== PINNED_NODE.binary || sha256File(path.join(runtime, 'LICENSE')) !== PINNED_NODE.license) {
    throw Error('Node runtime differs from the verified Node 24.21.0 payload');
  }
  const version = run(path.join(runtime, 'node'), ['--version']).trim();
  if (version !== PINNED_NODE.version) throw Error('Unexpected Node runtime version');
  return { version, originalSHA256: PINNED_NODE.binary, licenseSHA256: PINNED_NODE.license };
}

export function validatePiReleaseIdentity(pkg, digest, packageLockSHA256, provenanceSHA256) {
  if (pkg.name !== '@earendil-works/pi-coding-agent' || pkg.version !== PI_VERSION) throw Error('Pi release must be 1.5.0');
  if (!isDeepStrictEqual(digest, { files: PI_RELEASE_PIN.files, links: PI_RELEASE_PIN.links, sha256: PI_RELEASE_PIN.sha256 }) ||
      packageLockSHA256 !== PI_RELEASE_PIN.packageLockSHA256 || provenanceSHA256 !== PI_RELEASE_PIN.provenanceSHA256) throw Error('Pi 1.5.0 release content/provenance pin mismatch');
  return { version: PI_VERSION, files: digest.files, links: digest.links, sourceTreeSHA256: digest.sha256, packageLockSHA256, provenanceSHA256 };
}

export function validateToolPayloadIdentity(digest, provenanceSHA256) {
  if (!isDeepStrictEqual(digest, { files: TOOL_PAYLOAD_PIN.files, links: TOOL_PAYLOAD_PIN.links, sha256: TOOL_PAYLOAD_PIN.sha256 }) ||
      provenanceSHA256 !== TOOL_PAYLOAD_PIN.provenanceSHA256) throw Error('Offline tool payload content/provenance pin mismatch');
  return { sourceTree: digest, provenanceSHA256, sourceBinaries: { rg: TOOL_PAYLOAD_PIN.rgSHA256, fd: TOOL_PAYLOAD_PIN.fdSHA256 } };
}

export function validateToolPayload(toolsPath) {
  const tools = directory(toolsPath), result = validateToolPayloadIdentity(moduleTreeDigest(tools), sha256File(path.join(tools, 'provenance.json')));
  for (const binary of ['rg', 'fd']) {
    const filename = path.join(tools, binary);
    if (!(regular(filename).mode & 0o111) || sha256File(filename) !== result.sourceBinaries[binary]) throw Error(`Offline ${binary} source differs or is not executable`);
  }
  return result;
}

export function validatePiRelease(releasePath) {
  const release = directory(releasePath), npm = path.join(release, 'node_modules');
  const provenanceFile = path.join(path.dirname(release), 'runtime-provenance.json');
  const digest = moduleTreeDigest(npm);
  const pkg = JSON.parse(fs.readFileSync(path.join(npm, '@earendil-works/pi-coding-agent/package.json'), 'utf8'));
  regular(path.join(npm, '@earendil-works/pi-coding-agent/dist/bundle/cli.js'));
  const result = validatePiReleaseIdentity(pkg, digest, sha256File(path.join(release, 'package-lock.json')), sha256File(provenanceFile));
  const provenance = JSON.parse(fs.readFileSync(provenanceFile, 'utf8'));
  return { ...result, dependencyVerification: provenance.dependencyVerification, licenseAddition: provenance.licenseAddition, tools: validateToolPayload(path.join(release, 'tools')) };
}

export function validateSourceIdentity(info, original) {
  if (info.CFBundleShortVersionString !== WORKBUDDY_VERSION || info.CFBundleIdentifier !== 'com.tencent.workbuddy.mac') throw Error('Expected official WorkBuddy 5.11.1');
  if (original.asarSHA256 !== ORIGINAL_ASAR_SHA256 || info.ElectronAsarIntegrity?.['Resources/app.asar']?.hash !== original.headerSHA256 ||
      !isDeepStrictEqual(original.rendererTree, ORIGINAL_RENDERER)) throw Error('Source WorkBuddy ASAR/renderer is not the verified 5.11.1 artifact');
}
function copyHarness(destination, sdkChunk) {
  fs.mkdirSync(destination);
  fs.copyFileSync(path.join(HARNESS, 'package.json'), path.join(destination, 'package.json'));
  // This is repository source only: no tests, delivery evidence, user config or sessions.
  walk(path.join(HARNESS, 'src'), (filename, stat) => {
    if (path.relative(HARNESS, filename) === OFFICIAL_SDK.module && !stat.isDirectory()) return;
    const relative = path.relative(path.join(HARNESS, 'src'), filename), target = path.join(destination, 'src', relative);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw Error('Harness source contains a nonordinary entry');
    if (stat.isDirectory()) fs.mkdirSync(target, { recursive: true });
    else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(filename, target); }
  });
  fs.mkdirSync(path.join(destination, 'package-dmg'));
  fs.copyFileSync(path.join(HERE, 'approval-extension.mjs'), path.join(destination, 'package-dmg/approval-extension.mjs'));
  fs.writeFileSync(path.join(destination, OFFICIAL_SDK.module), sdkChunk, { flag: 'wx' });
}
function sourceFileHashes() {
  const files = ['package-dmg/build.mjs', 'package-dmg/asar.mjs', 'package-dmg/patches.mjs', 'package-dmg/native-preview-patch.mjs', 'package-dmg/native-artifact-preview-patch.mjs', 'package-dmg/native-home-route-patch.mjs', 'package-dmg/bootstrap.cjs', 'package-dmg/approval-extension.mjs', 'package.json'];
  walk(path.join(HARNESS, 'src'), (filename, stat) => {
    const relative = path.relative(HARNESS, filename);
    if (stat.isFile() && relative !== OFFICIAL_SDK.module) files.push(relative);
  });
  for (const name of ['financialbuddy-gold.png', GOLD_ICON_ASSET, 'gold-icon.provenance.json']) files.push(`package-dmg/assets/${name}`);
  files.push('native/pdf-parser.swift', 'document-engine/package.json', 'document-engine/package-lock.json');
  files.push(OFFICIAL_SDK.module);
  return Object.fromEntries(files.sort().map((filename) => [filename,
    filename === OFFICIAL_SDK.module ? OFFICIAL_SDK.sourceSHA256 : sha256File(path.join(HARNESS, filename))]));
}

export function validateDocumentEngine(root, manifest) {
  directory(root); validateModuleTree(root);
  if (sha256File(path.join(root, 'package-lock.json')) !== DOCUMENT_ENGINE_PIN.lockSHA256 ||
    !isDeepStrictEqual(moduleTreeDigest(path.join(root, 'node_modules')), {
      files: DOCUMENT_ENGINE_PIN.files, links: DOCUMENT_ENGINE_PIN.links, sha256: DOCUMENT_ENGINE_PIN.sha256,
    })) throw Error('Document engine dependencies differ from their pinned offline tree');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  if (!isDeepStrictEqual(pkg.dependencies, { saxes: '6.0.0', yauzl: '3.4.0' })) throw Error('Unexpected document dependencies');
  if (manifest) {
    if (!isDeepStrictEqual(fs.readdirSync(root).sort(), ['node_modules', 'package-lock.json', 'package.json', 'pdf-parser']) ||
      sha256File(path.join(root, 'pdf-parser')) !== manifest.pdfHelperSHA256 ||
      sha256File(path.join(root, 'package.json')) !== manifest.packageSHA256 ||
      manifest.lockSHA256 !== DOCUMENT_ENGINE_PIN.lockSHA256 ||
      manifest.dependenciesSHA256 !== DOCUMENT_ENGINE_PIN.sha256 || !isMachO(path.join(root, 'pdf-parser'))) throw Error('Bundled document engine differs from manifest');
  }
  return true;
}

function stageDocumentEngine(resources, output) {
  const source = path.join(HARNESS, 'document-engine'); validateDocumentEngine(source);
  const root = path.join(resources, 'DocumentEngine'); fs.mkdirSync(root);
  for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(source, name), path.join(root, name));
  copyTree(path.join(source, 'node_modules'), path.join(root, 'node_modules'));
  const swift = path.join(HARNESS, 'native/pdf-parser.swift');
  run('/usr/bin/xcrun', ['swiftc', '-O', '-target', 'arm64-apple-macos12.0', '-module-cache-path', path.join(output, 'document-swift-cache'),
    '-o', path.join(root, 'pdf-parser'), swift, '-framework', 'PDFKit', '-framework', 'Vision', '-framework', 'AppKit']);
  return { packageSHA256: sha256File(path.join(root, 'package.json')), lockSHA256: DOCUMENT_ENGINE_PIN.lockSHA256,
    dependenciesSHA256: DOCUMENT_ENGINE_PIN.sha256, swiftSourceSHA256: sha256File(swift), pdfHelperSHA256: sha256File(path.join(root, 'pdf-parser')),
    target: 'arm64-apple-macos12.0', formats: ['pdf', 'docx', 'xlsx', 'pptx'], pdfOCR: 'macOS-Vision-local', externalServiceRequired: false };
}

export function validateHarnessSources(root = HARNESS) {
  let checked = 0;
  const base = directory(root);
  walk(path.join(base, 'src'), (filename, stat) => {
    if (path.relative(base, filename) === OFFICIAL_SDK.module && stat.isFile()) return;
    if (stat.isSymbolicLink()) throw Error('Harness source contains a symlink');
    if (stat.isFile() && /\.(?:cjs|mjs|js)$/.test(filename)) {
      run(process.execPath, ['--check', filename], { stdio: ['ignore', 'pipe', 'pipe'] });
      checked++;
    }
  });
  return { javascriptFilesChecked: checked };
}

/** The one allowed SDK chunk is protocol/crypto only, never a recovered CLI subtree. */
export function validateOfficialSdk(harnessRoot, sourceChunk, sourceVersion = WORKBUDDY_VERSION) {
  const sourceSHA256 = sourceVersion === WORKBUDDY_VERSION ? ORIGINAL_ASAR_SHA256 : sourceVersion === '5.9.1' ? LEGACY_ORIGINAL_ASAR_SHA256 : undefined;
  if (!sourceSHA256) throw Error('Unsupported official SDK source version');
  const provenanceFile = path.join(harnessRoot, 'src/official-aicc-sdk.provenance.json');
  if (regular(provenanceFile).size > 16384) throw Error('Official SDK provenance is oversized');
  const provenance = JSON.parse(fs.readFileSync(provenanceFile, 'utf8'));
  const dependencies = ['node:crypto', 'node:util', 'node:http', 'node:https'];
  if (provenance.name !== OFFICIAL_SDK.name || provenance.sdkVersion !== OFFICIAL_SDK.version ||
      provenance.sourceArtifactSHA256 !== sourceSHA256 || provenance.sourceMember !== OFFICIAL_SDK.member ||
      provenance.sourceSHA256 !== OFFICIAL_SDK.sourceSHA256 || provenance.bytes !== OFFICIAL_SDK.bytes ||
      provenance.buildModule !== 'official-aicc-sdk.mjs' || !isDeepStrictEqual(provenance.runtimeDependencies, dependencies) ||
      typeof provenance.licenseStatus !== 'string' || !provenance.licenseStatus.includes('No standalone')) throw Error('Official SDK provenance differs from the audited chunk');
  if (sourceChunk !== undefined) {
    if (!Buffer.isBuffer(sourceChunk) || sourceChunk.length !== OFFICIAL_SDK.bytes ||
        crypto.createHash('sha256').update(sourceChunk).digest('hex') !== OFFICIAL_SDK.sourceSHA256) throw Error('Official SDK source chunk differs');
  } else {
    const moduleFile = path.join(harnessRoot, OFFICIAL_SDK.module);
    if (regular(moduleFile).size !== OFFICIAL_SDK.bytes || sha256File(moduleFile) !== OFFICIAL_SDK.sourceSHA256) throw Error('Official SDK module differs from the original protocol chunk');
  }
  return {
    name: OFFICIAL_SDK.name, version: OFFICIAL_SDK.version, sourceArtifactSHA256: sourceSHA256,
    sourceMember: OFFICIAL_SDK.member, sourceSHA256: OFFICIAL_SDK.sourceSHA256,
    bundledModule: `pi-harness/${OFFICIAL_SDK.module}`, bundledModuleSHA256: OFFICIAL_SDK.sourceSHA256,
    bytes: OFFICIAL_SDK.bytes, runtimeDependencies: dependencies, licenseStatus: provenance.licenseStatus,
    provenanceFile: 'pi-harness/src/official-aicc-sdk.provenance.json', provenanceSHA256: sha256File(provenanceFile),
  };
}

export function validateBaseBuildIdentity(manifest, hashes) {
  const pin = LEGACY_BASE_BUILD_PINS[manifest.buildVersion];
  if (!pin || hashes.manifestSHA256 !== pin.manifestSHA256) throw Error('Base manifest pin mismatch');
  if (hashes.dmgSHA256 !== pin.dmgSHA256) throw Error('Base DMG pin mismatch');
  if (hashes.asarSHA256 !== pin.asarSHA256) throw Error('Base ASAR pin mismatch');
  if (manifest.kind !== BUILD_KIND || manifest.formatVersion !== 1 ||
      manifest.workbuddyVersion !== '5.9.1' || manifest.bundle !== `staging/${BUNDLE_NAME}` || manifest.bundleIdentifier !== BUNDLE_ID ||
      manifest.signature !== 'ad-hoc-not-notarized' || manifest.userDataIncluded !== false || manifest.status !== 'packaged' ||
      manifest.runtimeAcceptance?.allChecksPassed !== true || manifest.signing?.strictDeepVerified !== true) throw Error('Base is not an accepted legacy Pi build');
  const renderer = { files: pin.rendererFiles, sha256: pin.rendererSHA256 };
  if (manifest.original?.asarSHA256 !== LEGACY_ORIGINAL_ASAR_SHA256 || manifest.candidate?.asarSHA256 !== pin.asarSHA256 ||
      !isDeepStrictEqual(manifest.original.rendererTree, renderer) || !isDeepStrictEqual(manifest.candidate.rendererTree, renderer) ||
      manifest.dmg?.file !== pin.dmgFile || manifest.dmg?.sha256 !== pin.dmgSHA256 || manifest.dmg?.hdiutilVerified !== true ||
      !isDeepStrictEqual(manifest.removedEngineTrees, REMOVED_ENGINE_TREES) || Object.keys(manifest.buildSources ?? {}).length !== pin.sourceFiles) throw Error('Base provenance differs from the pinned legacy build');
  return { buildVersion: pin.buildVersion, ...hashes };
}

/** Deployed harness sources must match the complete manifest file set, with no runtime data. */
export function validateBundledHarness(harnessRoot, buildSources) {
  const root = directory(harnessRoot), expected = {};
  for (const [filename, digest] of Object.entries(buildSources)) {
    if (filename !== 'package.json' && filename !== 'package-dmg/approval-extension.mjs' && !filename.startsWith('src/')) continue;
    if (filename.split('/').some(part => !part || part === '.' || part === '..') || filename.includes('\\') || !/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid harness source manifest entry');
    expected[filename] = digest;
  }
  if (!Object.keys(expected).length) throw Error('Harness source manifest is empty');
  const actual = {}, allowedDirectories = new Set();
  for (const filename of Object.keys(expected)) {
    for (let parent = path.posix.dirname(filename); parent !== '.'; parent = path.posix.dirname(parent)) allowedDirectories.add(parent);
  }
  walk(root, (filename, stat) => {
    const relative = path.relative(root, filename).split(path.sep).join('/');
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw Error('Bundled harness contains a nonordinary entry');
    if (stat.isDirectory()) {
      if (!allowedDirectories.has(relative)) throw Error(`Bundled harness contains an unexpected directory: ${relative}`);
    } else actual[relative] = sha256File(filename);
  });
  if (!isDeepStrictEqual(actual, expected)) throw Error('Bundled harness differs from its source manifest');
  return { files: Object.keys(actual).length, hashes: actual };
}

function verifyAdHocSignature(app) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: ['ignore', 'pipe', 'pipe'] });
  const result = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  const detail = result.stdout + result.stderr;
  if (result.status !== 0 || !detail.split('\n').includes('Signature=adhoc') || !detail.split('\n').includes(`Identifier=${BUNDLE_ID}`)) throw Error('Base application does not have the expected ad-hoc Pi signature');
  return { method: 'ad-hoc-not-notarized', strictDeepVerified: true };
}

/** Historical verification is read-only; legacy applications cannot supply a 5.11.1 build. */
export function validateBaseBuild(baseBuild) {
  if (!path.isAbsolute(baseBuild)) throw Error('--base-build must be an absolute path');
  const root = directory(baseBuild), manifestFile = path.join(root, 'manifest.json'), manifestSHA256 = sha256File(manifestFile);
  // Pin the bytes before reading any path or provenance supplied by the manifest.
  const pin = Object.values(LEGACY_BASE_BUILD_PINS).find(value => value.manifestSHA256 === manifestSHA256);
  if (!pin) throw Error('Base manifest pin mismatch');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const appPath = path.join(root, 'staging', BUNDLE_NAME), app = directory(appPath);
  if (app !== appPath) throw Error('Base application path escapes the build directory');
  const resources = path.join(app, 'Contents/Resources');
  const identity = validateBaseBuildIdentity(manifest, {
    manifestSHA256,
    dmgSHA256: sha256File(path.join(root, pin.dmgFile)),
    asarSHA256: sha256File(path.join(resources, 'app.asar')),
  });
  validateModuleTree(app);
  const harness = validateBundledHarness(path.join(resources, 'pi-harness'), manifest.buildSources);
  if (harness.files !== pin.harnessFiles) throw Error('Base harness file count differs');
  const runtime = path.join(resources, 'PiEngine/runtime');
  if (!isDeepStrictEqual(fs.readdirSync(path.join(resources, 'PiEngine')).sort(), ['node_modules', 'runtime']) ||
      !isDeepStrictEqual(fs.readdirSync(runtime).sort(), ['LICENSE', 'node']) ||
      !isDeepStrictEqual(manifest.node, { version: PINNED_NODE.version, originalSHA256: PINNED_NODE.binary, licenseSHA256: PINNED_NODE.license }) ||
      sha256File(path.join(runtime, 'node')) !== pin.signedNodeSHA256 || sha256File(path.join(runtime, 'LICENSE')) !== PINNED_NODE.license) throw Error('Base Node runtime/provenance differs');
  const piEngine = moduleTreeDigest(path.join(resources, 'PiEngine'));
  if (!isDeepStrictEqual(piEngine, { files: pin.piEngineFiles, links: pin.piEngineLinks, sha256: pin.piEngineSHA256 })) throw Error('Base PiEngine content pin mismatch');
  const npmStats = validateModuleTree(path.join(resources, 'PiEngine/node_modules'));
  if (!isDeepStrictEqual(manifest.pi, { version: '1.1.0', ...npmStats })) throw Error('Base Pi release provenance differs');
  const candidate = verifyCandidate(app, manifest);
  if (!isDeepStrictEqual(candidate, manifest.candidate)) throw Error('Base application differs from its candidate manifest');
  const signing = verifyAdHocSignature(app);
  return { root, app, manifest, identity, harness, piEngine, signing };
}

/** The former 5.9.1 incremental mutation entry point fails closed for this release. */
export function copyIncrementalCandidate() {
  throw Error('WorkBuddy 5.11.1 / 0.4.13 requires an original source; legacy base applications are verification-only');
}

function verifyCandidate(app, manifest) {
  const legacy = manifest.workbuddyVersion === '5.9.1' && ['0.3.0', '0.3.1'].includes(manifest.buildVersion);
  const expectedVersion = legacy ? '5.9.1' : WORKBUDDY_VERSION, piVersion = legacy ? '1.1.0' : PI_VERSION;
  const root = directory(app), info = plistJson(path.join(root, 'Contents/Info.plist'));
  if (info.CFBundleIdentifier !== BUNDLE_ID || info.CFBundleShortVersionString !== expectedVersion) throw Error('Candidate bundle identity/version differs');
  infoChanges(manifest.originalInfo, info);
  validateHelperLayout(root, info.CFBundleName);
  const resources = path.join(root, 'Contents/Resources'), asarFile = path.join(resources, 'app.asar'), archive = inspectAsar(asarFile);
  if (manifest.icon) {
    if (info.CFBundleIconFile !== GOLD_ICON_FILE || sha256File(path.join(resources, GOLD_ICON_FILE)) !== manifest.icon.icnsSHA256) throw Error('Candidate gold icon differs');
  } else if (manifest.buildVersion === BUILD_VERSION) throw Error('Candidate icon provenance is missing');
  const pkg = JSON.parse(archive.read('package.json'));
  if (pkg.main !== 'main/pi-entry.cjs' || pkg.version !== expectedVersion || pkg.dependencies?.['@genie/agent-harness']) throw Error('Candidate main/engine metadata mismatch');
  if (archive.entries.some((item) => removeEngine(item.path))) throw Error('Candidate still contains a native engine ASAR tree');
  for (const removed of REMOVED_ENGINE_TREES) {
    if (fs.existsSync(path.join(`${asarFile}.unpacked`, removed))) throw Error(`Candidate still contains removed engine files: ${removed}`);
  }
  archive.read('main/pi-entry.cjs');
  for (const { path: filename, entry } of archive.entries) if (!entry.files && !entry.link && !entry.unpacked) archive.read(filename);
  if (manifest.original.fuseBinary !== ELECTRON_FUSE_BINARY || fuseBytes(path.join(root, ELECTRON_FUSE_BINARY)) !== manifest.original.fuseWireHex) throw Error('Electron fuses changed');
  const current = snapshot(root);
  const previewPatches = manifest.nativePreviewPatches ?? manifest.nativePreviewPatch;
  const rendererPatches = manifest.nativeHomeRoutePatch
    ? [...(Array.isArray(previewPatches) ? previewPatches : [previewPatches]), manifest.nativeHomeRoutePatch]
    : previewPatches;
  const sourceRenderer = validateRendererTree(archive, manifest.original.rendererTree, rendererPatches);
  if (manifest.buildVersion === BUILD_VERSION && (!Array.isArray(manifest.nativePreviewPatches)
    || manifest.nativePreviewPatches.length !== PREVIEW_PINS.size
    || manifest.nativePreviewPatches.some(patch => !PREVIEW_PINS.has(patch?.member))
    || manifest.nativeHomeRoutePatch?.member !== NATIVE_HOME_ROUTE_PIN.member)) throw Error('Renderer patch set provenance is incomplete');
  if (!isDeepStrictEqual(current.productFiles, manifest.original.productFiles)) throw Error('Built-in product configuration changed');
  if (!legacy && (manifest.baseBuild || manifest.original.asarSHA256 !== ORIGINAL_ASAR_SHA256 || !isDeepStrictEqual(sourceRenderer, ORIGINAL_RENDERER))) throw Error('A 5.11.1 candidate must derive from the verified original 5.11.1 source');
  if (manifest.baseBuild) {
    if (manifest.baseBuild.manifestSHA256 !== BASE_BUILD_PIN.manifestSHA256 || manifest.baseBuild.asarSHA256 !== BASE_BUILD_PIN.asarSHA256 || current.asarSHA256 !== BASE_BUILD_PIN.asarSHA256) throw Error('Incremental build changed the inherited ASAR');
    const inheritedEngine = moduleTreeDigest(path.join(resources, 'PiEngine'));
    if (!isDeepStrictEqual(inheritedEngine, { files: BASE_BUILD_PIN.piEngineFiles, links: BASE_BUILD_PIN.piEngineLinks, sha256: BASE_BUILD_PIN.piEngineSHA256 })) throw Error('Incremental build changed the inherited PiEngine');
    validateBundledHarness(path.join(resources, 'pi-harness'), manifest.buildSources);
  }
  if (manifest.documentEngine) validateDocumentEngine(path.join(resources, 'DocumentEngine'), manifest.documentEngine);
  else if (manifest.buildVersion === BUILD_VERSION) throw Error('Document engine is missing');
  const nodeModules = path.join(resources, 'PiEngine/node_modules');
  validateModuleTree(nodeModules);
  const pi = JSON.parse(fs.readFileSync(path.join(nodeModules, '@earendil-works/pi-coding-agent/package.json')));
  if (pi.version !== piVersion || manifest.pi.version !== piVersion) throw Error(`Bundled Pi is not ${piVersion}`);
  if (!legacy) {
    if (!isDeepStrictEqual(fs.readdirSync(path.join(resources, 'PiEngine')).sort(), ['node_modules', 'package-lock.json', 'release-provenance.json', 'runtime', 'tools'])) throw Error('PiEngine contains unexpected resources');
    const embedded = moduleTreeDigest(nodeModules);
    if (embedded.files !== PI_RELEASE_PIN.files || embedded.links !== PI_RELEASE_PIN.links ||
        manifest.pi.sourceTreeSHA256 !== PI_RELEASE_PIN.sha256 || manifest.pi.provenanceSHA256 !== PI_RELEASE_PIN.provenanceSHA256 ||
        sha256File(path.join(resources, 'PiEngine/package-lock.json')) !== PI_RELEASE_PIN.packageLockSHA256 ||
        sha256File(path.join(resources, 'PiEngine/release-provenance.json')) !== PI_RELEASE_PIN.provenanceSHA256) throw Error('Bundled Pi release provenance differs');
    const expectedTree = manifest.pi.embeddedTree ?? { files: PI_RELEASE_PIN.files, links: PI_RELEASE_PIN.links, sha256: PI_RELEASE_PIN.sha256 };
    if (!isDeepStrictEqual(embedded, expectedTree)) throw Error('Bundled Pi resources differ from the verified source or signed snapshot');
    const tools = path.join(resources, 'PiEngine/tools'), toolTree = moduleTreeDigest(tools);
    const expectedTools = manifest.pi.tools.embeddedTree ?? { files: TOOL_PAYLOAD_PIN.files, links: TOOL_PAYLOAD_PIN.links, sha256: TOOL_PAYLOAD_PIN.sha256 };
    if (manifest.pi.tools.provenanceSHA256 !== TOOL_PAYLOAD_PIN.provenanceSHA256 ||
        sha256File(path.join(tools, 'provenance.json')) !== TOOL_PAYLOAD_PIN.provenanceSHA256 ||
        !isDeepStrictEqual(toolTree, expectedTools)) throw Error('Bundled offline tools differ from their verified source or signed snapshot');
    const runtime = path.join(resources, 'PiEngine/runtime');
    if (!isDeepStrictEqual(fs.readdirSync(runtime).sort(), ['LICENSE', 'node']) ||
        sha256File(path.join(runtime, 'LICENSE')) !== PINNED_NODE.license ||
        sha256File(path.join(runtime, 'node')) !== (manifest.node.signedSHA256 ?? PINNED_NODE.binary)) throw Error('Bundled Node runtime differs from its verified source or signed snapshot');
    validateBundledHarness(path.join(resources, 'pi-harness'), manifest.buildSources);
  }
  for (const filename of OFFICIAL_SOURCE_FILES) regular(path.join(resources, 'pi-harness/src', filename));
  if (!isDeepStrictEqual(validateOfficialSdk(path.join(resources, 'pi-harness'), undefined, expectedVersion), manifest.officialSDK)) throw Error('Candidate official SDK/provenance differs from manifest');
  if (info.ElectronAsarIntegrity['Resources/app.asar'].hash !== current.headerSHA256) throw Error('Candidate ASAR header does not match Info.plist');
  return current;
}

const INSTRUCTIONS = `# 金融buddy 5.11.1 / 0.4.13 内部测试包

这是基于 WorkBuddy 5.11.1 和 Pi 1.5.0 的独立执行器构建。应用显示名称为“金融buddy”，保留官方登录和原声明许可；不含 CodeBuddy 的 bin/dist/node_modules 与 agent-harness SDK。现有 WorkBuddy 安装不受构建过程影响。本包不会携带构建者的账号、令牌、Pi 配置、历史或运行数据。

0.4.13 仅接受经完整校验的原版 WorkBuddy 5.11.1，保留原生页面布局和金色图标；首页预建及发送只接受已就绪的 Pi 会话。首页路由和 Markdown 预览补丁按固定哈希校验，其余界面成员逐项保持来源一致；不会将旧版 5.9.1 测试包标成 5.11.1。构建和签名检查完成后仍需独立运行验收，不继承旧包的运行验收结论。

保留原版首页、侧栏、导航、模型菜单和输入组件；Pi 只在新本地对话的服务边界执行任务。支持明确选择的本地图片、UTF-8文本及选区、PDF/DOCX/XLSX/PPTX文档、指令型Expert与已安装单agent专家包、已安装SKILL.md和原生已授权MCP映射。文档在本机提取文字后随对话发送给所选模型，没有额外解析服务；无文字层的PDF页面使用本机Vision OCR。单文档25MiB、文档合计64MiB、最多200页PDF，单文档提取文字512KiB、整轮文字1MiB；超限明确报错，不静默截断。扫描件OCR可能有误；Office图表、图片和内嵌对象不识别，公式仅读保存的缓存值，单元格保留地址与原始值。旧DOC/XLS/PPT、加密文件需另存为支持格式或解除保护。无需另装Python、Office或OCR服务。

本版修复专家选择时丢失原生身份的问题：保留marketExpertId、source、marketplace及原样runtimeIdentity；优先按可信安装目录和声明manifest读取agent主指令及渐进技能目录，无需每次重新查询云端专家正文。包版本及文件哈希在绑定、发送和重启恢复后校验；发生变化需重新选择，不静默降级为无专家。技能正文按需读取，不自动执行脚本或授予新工具；多agent编排、Hook和插件级MCP尚未映射时明确拒绝。

首页原生scene://场景标记单独验证并映射为场景分类上下文，不再作为附件读取。场景选择不自动安装、授权或执行连接器；command://形式的已安装技能仍按技能目录校验。真实远端附件和未知资源仍保留本地路径校验，不自动下载URL。每个新Host回合仅记录有界的资源分类、固定协议、短指纹及有效场景ID，便于定位输入错误；诊断不保存正文、完整URL、路径、场景名称或凭据。历史失败任务不自动重试。

技能不自动加载脚本/扩展，凭据留在daemon。无本地路径的粘贴图片、团队/插件Expert编排、Buddy专属能力、CLI型连接器、分享、旧轮次检查点、重发及原生OS沙箱仍有限制，未覆盖的操作明确报错。已有Pi会话保留，旧原生本地历史只读。完整功能和限制以验收记录为准。

本版补齐任务终态完整列表info，并分别适配文件树与产物卡的Markdown预览。本地Pi会话不再暴露原版专用于云沙箱识别的runtimeId，防止原生预览误走cloud分支；保留原版真正云会话和项目的环境判定。产物预览必须通过原生Host/guest/core原子clean与expected-content检查后提交；脏编辑、未知状态、切换、超时与异步竞争均跳过，不使用非原子fallback。仅对已打开Markdown处理真实文件变化，正文不从事件载荷读取，大小未知或超过1MiB跳过；复用原生读取与探测，瞬时IO分配仍受原生readFile实现约束。诊断只存原因计数，不含正文或凭据。原版WorkBuddy未改。

本版新增P0适配：推理档位按模型真实能力校验，设置在每会话私有runtime中生效；支持原生/compact、/总结或压缩命令。压缩阈值空值恢复80%默认，0仅关闭预消息阈值压缩、保留overflow自动恢复，正数按百分比配置。项目设置覆盖冲突会明确拒绝，不能静默忽略。模型能力变化不支持的档位需重新选择。

写入/编辑前和Bash工作目录范围内记录文件快照，提供原生产物、文件树、变更和文本Diff。单文件快照25MiB、每轮128MiB、总快照1GiB；扫描最多2048文件/10000项/32层/5秒。超限明确标记范围不完整，不允许假装完整回退。Bash目录外、网络和外部系统的副作用不属于文件回退范围。新版本轮次具有会话前缀检查点；原生回退会同时还原可验证文件和Pi/Host历史，拒绝覆盖外部修改。旧轮次没有快照时明确不可回退；中断事务保留备份并阻断该任务，避免状态错位继续执行。

原生Diff列表为各路径的最新小文本变化直接附带真实hunks，避免组件借用旧创建补丁。每次资源读取的内联Diff上限为256KiB、64个最新路径，并在1秒预算后停止继续取详情（单次已有原生diff调用仍受其2秒上限约束）；优先最近更新的路径。单文件差异过大使用原生不可预览提示；二进制、快照不可用、无文本差异及全局预算不足的路径不进入当前line-Diff投影，diffOmissions保留真实原因。普通产物与文件树可照常打开；原始journal、逐轮详情、快照和回退记录保留。不会将当前整份文件或上一轮patch伪装成最新差异。

未选择工作空间的新任务会在 ~/WorkBuddy/YYYY-MM-DD-HH-mm-ss 分配独立目录，使用本机当地时间；同秒重名时顺延一秒，不覆盖已有目录。手动选择的项目目录照常使用，旧任务继续使用原保存目录，不搬动文件。恢复会话不会重新分配目录。

按此次需求，默认使用自动执行：Pi 的写入、编辑、Bash 和本次任务已授权的 MCP 无需每条命令再确认，仍保留调用记录、取消和 MCP 一次性调用校验。首次升级把原生权限偏好设为“允许完全访问”；如账号显示权限菜单，可切换到“默认权限”恢复逐次确认。也可在退出应用后，把独立数据目录内 pi/pi-config.json 的 approvalMode 改为 manual（auto 为自动）；下次启动会同步原生偏好，后续菜单选择保留。自动执行具备当前 macOS 用户权限，任务目录不是文件系统沙箱；系统权限弹窗、MCP 首次信任和连接配置仍需按原有流程处理。

将 金融buddy.app 拖到 Applications；图标直接启动，无额外启动 App 或注入脚本。应用继续使用 Pi 版的独立 Bundle ID 和独立数据目录 ~/Library/Application Support/WorkBuddy-Pi-5.9.1，沿用此前 Pi 版官方登录与会话，不导入原版登录缓存。官方 WorkBuddy 登录仍需官方服务可达。外部官方登录网页及版权声明保留原文。

已内置 Pi 1.5.0、Node 24.21.0 和 grep/find 所需的 rg/fd，其他电脑无需另装 Pi 或 Node；业务 MCP 的外部程序依赖仍取决于具体连接器。模型通过隔离应用内的官方模型桥访问，复用当前 WorkBuddy 官方登录与令牌刷新，默认 hy4；可用模型目录和调用权限以该账号实际权益及官方服务返回为准。无需本机模型服务，不配置自定义模型直连，不导出官方登录凭据给 Pi。桥只在本机回环地址监听，locator 仅含短期本地 ticket，不含官方令牌。

首次运行会生成独立 pi/pi-config.json、pi/agent/models.json 和 settings.json。旧版本的三个文件会先原样备份到 pi/migration-backups 下的私有目录，再迁移为官方模型模式；原账号和 thread/session 文件保留。备份只在使用者数据目录，不在 DMG 内。关闭后重启会保留官方模式下的模型选择，原直连模型配置不会继续生效。完整功能以本次实机验收记录为准，打包/签名检查不能代替运行验收。

此包为 ad hoc 签名、未通过 Developer ID 公证的内部验证包。系统可能阻止从互联网下载的应用；请按组织的软件分发/安全审核流程处理，不要关闭 Gatekeeper 或删除隔离属性。正式客户分发需权利授权、正式签名和公证。该包禁用了会覆盖 Pi 引擎的原版自动升级，应通过独立构建包升级。

原版和 Pi 的版权及依赖许可证保留在应用 Resources 中。官方模型桥仅保留最小传输/协议 SDK，不恢复 CodeBuddy CLI 或 agent loop；提取来源和可确认的许可状态记录在 SDK provenance 与 manifest 中，未能确认独立许可的部分需在正式分发前审核。SHA256SUMS 用于传输完整性校验，manifest.json 记录源包、新包、Pi/Node、ASAR 和签名信息。卸载可删除独立应用；如需清理数据，先确认需要保留的会话，再处理上述独立数据目录。
`;

export function stageBuild(options) {
  if (options.baseBuild) return stageIncrementalBuild(options);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Builder requires macOS Apple Silicon');
  const sourceApp = directory(options.sourceApp), runtime = directory(options.nodeRuntime), release = directory(options.piRelease);
  const harnessSyntax = validateHarnessSources();
  validateModuleTree(sourceApp);
  const originalInfo = plistJson(path.join(sourceApp, 'Contents/Info.plist'));
  if (originalInfo.CFBundleShortVersionString !== WORKBUDDY_VERSION || originalInfo.CFBundleIdentifier !== 'com.tencent.workbuddy.mac') throw Error('Expected official WorkBuddy 5.11.1');
  const original = snapshot(sourceApp);
  validateSourceIdentity(originalInfo, original);
  const sourceRequirement = `anchor apple generic and certificate leaf[subject.OU] = "${SOURCE_TEAM_ID}" and identifier "com.tencent.workbuddy.mac"`;
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${sourceRequirement}`, sourceApp], { stdio: ['ignore', 'pipe', 'pipe'] });
  const node = validateRuntime(runtime), npm = path.join(release, 'node_modules'), piRelease = validatePiRelease(release);
  for (const filename of OFFICIAL_SOURCE_FILES) regular(path.join(HARNESS, 'src', filename));
  const originalAsar = path.join(sourceApp, 'Contents/Resources/app.asar'), archive = inspectAsar(originalAsar);
  const sdkChunk = archive.read(OFFICIAL_SDK.member);
  const officialSDK = validateOfficialSdk(HARNESS, sdkChunk);
  const piPackage = JSON.parse(fs.readFileSync(path.join(npm, '@earendil-works/pi-coding-agent/package.json'), 'utf8'));
  if (piPackage.version !== PI_VERSION) throw Error('Pi release must be 1.5.0');
  regular(path.join(npm, '@earendil-works/pi-coding-agent/dist/bundle/cli.js'));
  const output = newOutput(options.output, sourceApp), staging = path.join(output, 'staging'), app = path.join(staging, BUNDLE_NAME);
  fs.mkdirSync(staging);
  log('copy-source'); copyTree(sourceApp, app);
  const resources = path.join(app, 'Contents/Resources');
  const goldIcon = path.join(HERE, 'assets', GOLD_ICON_ASSET); regular(goldIcon);
  const iconBytes = fs.readFileSync(goldIcon);
  if (iconBytes.toString('ascii', 0, 4) !== 'icns' || iconBytes.readUInt32BE(4) !== iconBytes.length) throw Error('Invalid gold ICNS asset');
  fs.copyFileSync(goldIcon, path.join(resources, GOLD_ICON_FILE));
  const candidateAsar = path.join(resources, 'app.asar'), temporaryAsar = path.join(resources, 'app.new.asar');
  const patch = patchMembers(archive, fs.readFileSync(path.join(HERE, 'bootstrap.cjs')));
  const nativePreviews = [applyNativePreviewPatch(archive), ...applyNativeArtifactPreviewPatch(archive).patches];
  const nativeHomeRoute = applyNativeHomeRoutePatch(archive);
  for (const renderer of [...nativePreviews, nativeHomeRoute]) {
    if (renderer.member !== renderer.metadata.member || patch.replacements.has(renderer.member)) throw Error('Conflicting renderer patch member');
    patch.replacements.set(renderer.member, renderer.bytes);
    patch.report.push({ file: renderer.member, beforeBytes: renderer.metadata.originalBytes, afterBytes: renderer.bytes.length, purpose: renderer.metadata.id });
  }
  log('repack-asar');
  const packed = repackAsar({ input: originalAsar, output: temporaryAsar, replacements: patch.replacements, additions: patch.additions, remove: removeEngine });
  for (const tree of REMOVED_ENGINE_TREES) fs.rmSync(path.join(`${candidateAsar}.unpacked`, tree), { recursive: true, force: true });
  for (const [filename, data] of packed.unpackedWrites) {
    const target = path.join(`${candidateAsar}.unpacked`, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data);
  }
  fs.renameSync(temporaryAsar, candidateAsar);
  copyHarness(path.join(resources, 'pi-harness'), sdkChunk);
  log('compile-document-engine');
  const documentEngine = stageDocumentEngine(resources, output);
  fs.mkdirSync(path.join(resources, 'PiEngine'));
  log('copy-pi', { files: piRelease.files, links: piRelease.links }); copyTree(npm, path.join(resources, 'PiEngine/node_modules'));
  copyTree(runtime, path.join(resources, 'PiEngine/runtime'));
  copyTree(path.join(release, 'tools'), path.join(resources, 'PiEngine/tools'));
  fs.copyFileSync(path.join(release, 'package-lock.json'), path.join(resources, 'PiEngine/package-lock.json'));
  fs.copyFileSync(path.join(path.dirname(release), 'runtime-provenance.json'), path.join(resources, 'PiEngine/release-provenance.json'));
  // Only the verified executable and license belong to the embedded Node runtime.
  const runtimeNames = fs.readdirSync(path.join(resources, 'PiEngine/runtime')).sort();
  if (JSON.stringify(runtimeNames) !== JSON.stringify(['LICENSE', 'node'])) throw Error('Node runtime contains unexpected files');
  writeBundleInfo(path.join(app, 'Contents/Info.plist'), BUNDLE_ID, packed.headerHash);
  const renamedHelpers = renameCandidateHelpers(app, originalInfo.CFBundleName);
  fs.symlinkSync('/Applications', path.join(staging, 'Applications'));
  fs.writeFileSync(path.join(output, '安装说明.md'), INSTRUCTIONS, { flag: 'wx' });
  fs.copyFileSync(path.join(output, '安装说明.md'), path.join(staging, '安装说明.md'));
  const manifest = {
    kind: BUILD_KIND, formatVersion: 1, buildVersion: BUILD_VERSION, createdAt: new Date().toISOString(), workbuddyVersion: WORKBUDDY_VERSION,
    bundle: `staging/${BUNDLE_NAME}`, displayName: branding.DISPLAY_NAME, internalName: branding.DISPLAY_NAME, renamedHelpers, bundleIdentifier: BUNDLE_ID, signature: 'ad-hoc-not-notarized',
    login: 'official-workbuddy-isolated-cache', modelTraffic: 'pi-via-workbuddy-official-bridge', userDataIncluded: false,
    modelMode: { officialOnly: true, provider: 'workbuddy-official', defaultModel: 'hy4', catalog: 'official-account-entitlements', localModelServiceRequired: false },
    uiMode: 'native-chat-only',
    icon: { file: GOLD_ICON_FILE, scheme: 'gold', icnsSHA256: sha256File(goldIcon),
      previewSHA256: sha256File(path.join(HERE, 'assets/financialbuddy-gold.png')), provenanceSHA256: sha256File(path.join(HERE, 'assets/gold-icon.provenance.json')) },
    original, originalInfo, sourceSignature: { teamIdentifier: SOURCE_TEAM_ID, strictDeepVerified: true },
    nativePreviewPatches: nativePreviews.map(preview => preview.metadata), nativeHomeRoutePatch: nativeHomeRoute.metadata,
    patchedMembers: patch.report, addedMembers: [...patch.additions.keys()],
    removedEngineTrees: REMOVED_ENGINE_TREES, removedAsarEntries: packed.removedPaths.length,
    retainedResources: ['cli/product*.json', 'cli/vendor', 'resources/plugins', 'resources/extensions', 'original licenses and copyright notices'],
    pi: piRelease, node, officialSDK, harnessSyntax, documentEngine, buildSources: sourceFileHashes(),
  };
  verifyCandidate(app, manifest);
  log('sign-candidate'); manifest.signing = signCandidateApp(app);
  manifest.pi.embeddedTree = moduleTreeDigest(path.join(resources, 'PiEngine/node_modules'));
  manifest.pi.tools.embeddedTree = moduleTreeDigest(path.join(resources, 'PiEngine/tools'));
  manifest.pi.tools.signedBinaries = Object.fromEntries(['rg', 'fd'].map(binary => [binary, sha256File(path.join(resources, 'PiEngine/tools', binary))]));
  manifest.node.signedSHA256 = sha256File(path.join(resources, 'PiEngine/runtime/node'));
  manifest.documentEngine.pdfHelperSHA256 = sha256File(path.join(resources, 'DocumentEngine/pdf-parser'));
  manifest.candidate = verifyCandidate(app, manifest);
  if (snapshot(sourceApp).asarSHA256 !== original.asarSHA256 || sha256File(path.join(sourceApp, 'Contents/MacOS/Electron')) !== original.executableSHA256) throw Error('Original application changed during build');
  manifest.status = 'staged-not-runtime-accepted';
  atomicJson(path.join(output, 'manifest.json'), manifest);
  log('stage-complete', { output, signature: manifest.signature });
  return { output, app, manifest };
}

export function stageIncrementalBuild() {
  throw Error('WorkBuddy 5.11.1 / 0.4.13 requires a verified original --source-app; legacy --base-build cannot produce this release');
}

export function finalizeBuild(outputPath) {
  if (process.platform !== 'darwin') throw Error('DMG finalization requires macOS');
  const output = directory(outputPath), manifestFile = path.join(output, 'manifest.json');
  regular(manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  if (manifest.kind !== BUILD_KIND || manifest.formatVersion !== 1 || manifest.buildVersion !== BUILD_VERSION || manifest.bundle !== `staging/${BUNDLE_NAME}` || manifest.workbuddyVersion !== WORKBUDDY_VERSION) throw Error('Unrecognized staged build manifest');
  const staging = directory(path.join(output, 'staging')), app = path.join(staging, BUNDLE_NAME);
  if (manifest.status === 'packaged') throw Error('Build was already finalized; use a new output directory for a new release');
  const dmg = path.join(output, DMG_FILENAME);
  if (fs.existsSync(dmg)) throw Error('DMG target already exists');
  log('verify-stage'); verifyCandidate(app, manifest);
  // Packaging must preserve the exact candidate that passed runtime acceptance.
  // A changed candidate must be explicitly re-signed and tested before this step.
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: ['ignore', 'pipe', 'pipe'] });
  manifest.packaging = { preservesCandidateSignature: true, applicationResigned: false };
  manifest.candidate = verifyCandidate(app, manifest);
  if (!fs.lstatSync(path.join(staging, 'Applications')).isSymbolicLink() || fs.readlinkSync(path.join(staging, 'Applications')) !== '/Applications') throw Error('Unexpected Applications shortcut');
  log('create-dmg');
  run('/usr/bin/hdiutil', ['create', '-srcfolder', staging, '-volname', `${branding.DISPLAY_NAME} ${WORKBUDDY_VERSION}`, '-format', 'UDZO', '-imagekey', 'zlib-level=9', dmg], { timeout: 600_000 });
  run('/usr/bin/hdiutil', ['verify', dmg], { timeout: 120_000 });
  manifest.status = 'packaged'; manifest.packagedAt = new Date().toISOString();
  manifest.dmg = { file: path.basename(dmg), sha256: sha256File(dmg), hdiutilVerified: true };
  atomicJson(manifestFile, manifest);
  const checksums = [DMG_FILENAME, 'manifest.json', '安装说明.md']
    .map((filename) => `${sha256File(path.join(output, filename))}  ${filename}\n`).join('');
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), checksums, { flag: 'wx' });
  log('dmg-complete', { file: dmg, sha256: manifest.dmg.sha256 });
  return { output, dmg, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) console.log('node build.mjs --source-app /Applications/WorkBuddy.app --node-runtime /path/to/runtime --pi-release /path/to/verified-1.5.0 --output /new/output [--stage-only]\nnode build.mjs --finalize /existing/output\nLegacy 5.9.1 --base-build inputs are verification-only and cannot create 0.4.13.');
    else if (args.finalize) finalizeBuild(args.finalize);
    else { const staged = stageBuild(args); if (!args.stageOnly) finalizeBuild(staged.output); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
