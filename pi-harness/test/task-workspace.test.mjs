import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { allocateTaskWorkspace, defaultTaskWorkspaceRoot, formatTaskWorkspaceTimestamp } from '../src/task-workspace.mjs';

const native = JSON.parse(fs.readFileSync(new URL('./fixtures/native-task-workspace-592.source.json', import.meta.url), 'utf8'));
const nativeSource = name => native.slices.find(slice => slice.name === name).source;
const instant = () => new Date(2026, 9, 26, 10, 11, 12);
function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-task-workspace-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const codeIs = code => error => error.code === code;

test('task-workspace source fixture belongs to the actual WorkBuddy 5.9.2 artifact', () => {
  assert.equal(native.workbuddyVersion, '5.9.2');
  assert.equal(native.artifactSHA256, '0b79c0358c129749bc3355f52bbae13f115577ab37c082a76dfdc54f66fd3f79');
  assert.equal(native.settingsKey, 'defaultWorkspacePath');
  assert.equal(native.slices.length, 8);
  for (const slice of native.slices) {
    assert.equal(slice.member, 'main/server.js');
    assert.equal(slice.memberSHA256, 'a471fc017f34ac8d18b7cdea7e0072232e476543b4244c9649556c690be07bba');
    assert.equal(createHash('sha256').update(slice.source).digest('hex'), slice.sha256);
    assert.equal(Buffer.byteLength(slice.source), slice.range.end - slice.range.start);
  }
});

test('date formatting matches the exact native local-time YYYY-MM-DD-HH-mm-ss consumer', () => {
  const context = vm.createContext({ K: path });
  vm.runInContext(nativeSource('formatDefaultCwdTimestamp') + nativeSource('generateDefaultCwd') + ';globalThis.api={formatDefaultCwdTimestamp,generateDefaultCwd}', context);
  for (const date of [instant(), new Date(2028, 1, 29, 0, 1, 2), new Date(2026, 11, 31, 23, 59, 59)]) {
    assert.equal(formatTaskWorkspaceTimestamp(date), context.api.formatDefaultCwdTimestamp(date));
    assert.equal(context.api.generateDefaultCwd('/fixture', date), path.join('/fixture', formatTaskWorkspaceTimestamp(date)));
  }
});

test('native collision retry advances the timestamp by one second rather than adding a suffix', async () => {
  const date = new Date(2026, 9, 26, 23, 59, 59), attempts = [];
  const context = vm.createContext({
    K: path, ensureDirReady: async () => true,
    q: { mkdir: async filename => { attempts.push(filename); if (attempts.length < 3) throw Object.assign(new Error('fixture collision'), { code: 'EEXIST' }); } },
  });
  vm.runInContext(nativeSource('formatDefaultCwdTimestamp') + nativeSource('generateDefaultCwd') + nativeSource('createDefaultCwd') + ';globalThis.create=createDefaultCwd', context);
  assert.equal(await context.create('/fixture', date), '/fixture/2026-10-27-00-00-01');
  assert.deepEqual(attempts, ['/fixture/2026-10-26-23-59-59', '/fixture/2026-10-27-00-00-00', '/fixture/2026-10-27-00-00-01']);
});

test('native default root uses defaultWorkspacePath and the central root resolver', async () => {
  const context = vm.createContext({
    K: path, Ue: { homedir: () => '/fixture/home' }, ys: 'defaultWorkspacePath',
    ensureDirReady: async () => true, getDefaultBrandFolderName: () => 'WorkBuddy',
  });
  vm.runInContext(nativeSource('getUnexpandedPlaceholderReason') + nativeSource('resolveWorkspaceRoot') + ';globalThis.resolve=resolveWorkspaceRoot', context);
  const options = { services: { config: { get: async key => { assert.equal(key, 'defaultWorkspacePath'); return '/fixture/configured'; } } } };
  assert.equal(await context.resolve(options), '/fixture/configured');
  assert.equal(await context.resolve({ ...options, resolveDefaultWorkspaceRoot: async () => '/fixture/central' }), '/fixture/central');
  assert.equal(await context.resolve(options, undefined, '/fixture/requested'), '/fixture/requested');
});

test('default root stays WorkBuddy independently of application branding without creating it', () => {
  assert.equal(defaultTaskWorkspaceRoot('/fixture/home'), '/fixture/home/WorkBuddy');
  assert.equal(defaultTaskWorkspaceRoot(), path.join(os.homedir(), 'WorkBuddy'));
  assert.throws(() => defaultTaskWorkspaceRoot('relative'), codeIs('TASK_WORKSPACE_INVALID'));
});

test('new tasks receive private independent directories under the selected root', async t => {
  const temp = temporary(t), rootDir = path.join(temp, 'WorkBuddy');
  const first = await allocateTaskWorkspace({ rootDir, now: instant });
  const second = await allocateTaskWorkspace({ rootDir, now: instant });
  assert.equal(first.cwd, path.join(rootDir, '2026-10-26-10-11-12'));
  assert.equal(second.cwd, path.join(rootDir, '2026-10-26-10-11-13'));
  for (const item of [first, second]) {
    assert.equal(item.created, true); assert.equal(item.workspaceAutoGenerated, true);
    assert.equal(fs.statSync(item.cwd).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(item.cwd), []);
  }
});

test('collision allocation crosses local midnight and never overwrites prior content', async t => {
  const rootDir = temporary(t), date = () => new Date(2026, 9, 26, 23, 59, 59);
  const first = await allocateTaskWorkspace({ rootDir, now: date });
  fs.writeFileSync(path.join(first.cwd, 'retained.txt'), 'retained fixture');
  const second = await allocateTaskWorkspace({ rootDir, now: date });
  assert.equal(path.basename(second.cwd), '2026-10-27-00-00-00');
  assert.equal(fs.readFileSync(path.join(first.cwd, 'retained.txt'), 'utf8'), 'retained fixture');
});

test('same-clock concurrent calls allocate unique paths using atomic mkdir', async t => {
  const rootDir = temporary(t);
  const results = await Promise.all(Array.from({ length: 40 }, () => allocateTaskWorkspace({ rootDir, now: instant })));
  assert.equal(new Set(results.map(item => item.cwd)).size, 40);
  assert.equal(fs.readdirSync(rootDir).length, 40);
});

test('independent Node processes cannot select the same task path', async t => {
  const rootDir = temporary(t), moduleUrl = new URL('../src/task-workspace.mjs', import.meta.url).href;
  const script = `import {allocateTaskWorkspace} from ${JSON.stringify(moduleUrl)};const results=[];for(let i=0;i<10;i++)results.push((await allocateTaskWorkspace({rootDir:process.argv[1],now:()=>new Date(${instant().getTime()})})).cwd);process.stdout.write(JSON.stringify(results));`;
  const worker = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, rootDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => { if (status !== 0) reject(new Error(stderr)); else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } } });
  });
  const results = (await Promise.all([worker(), worker(), worker()])).flat();
  assert.equal(results.length, 30); assert.equal(new Set(results).size, 30);
  assert.equal(fs.readdirSync(rootDir).length, 30);
});

test('explicit workspace is unchanged and bypasses the root and clock allocator', async t => {
  const rootDir = temporary(t), cwd = path.join(rootDir, 'existing'); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'retained.txt'), 'retained');
  const supplied = cwd + path.sep;
  const result = await allocateTaskWorkspace({ cwd: supplied, rootDir: 'invalid-unused-root', now: () => { throw Error('must not allocate'); } });
  assert.deepEqual(result, { cwd: supplied, workspaceAutoGenerated: false, created: false });
  assert.deepEqual(fs.readdirSync(rootDir), ['existing']);
  assert.equal(fs.readFileSync(path.join(cwd, 'retained.txt'), 'utf8'), 'retained');
});

test('a persisted task cwd is reusable on another day without allocating a new directory', async t => {
  const rootDir = temporary(t), first = await allocateTaskWorkspace({ rootDir, now: instant });
  const record = JSON.parse(JSON.stringify({ cwd: first.cwd, workspaceAutoGenerated: true }));
  const restored = await allocateTaskWorkspace({ cwd: record.cwd, rootDir, now: () => new Date(2030, 0, 1) });
  assert.equal(restored.cwd, first.cwd); assert.equal(restored.created, false);
  assert.equal(record.workspaceAutoGenerated, true);
  assert.deepEqual(fs.readdirSync(rootDir), ['2026-10-26-10-11-12']);
});

test('existing root permissions and blocking files are preserved', async t => {
  const temp = temporary(t), rootDir = path.join(temp, 'root'); fs.mkdirSync(rootDir, { mode: 0o755 });
  const before = fs.statSync(rootDir).mode & 0o777;
  await allocateTaskWorkspace({ rootDir, now: instant });
  assert.equal(fs.statSync(rootDir).mode & 0o777, before);
  const blocked = path.join(temp, 'blocked'); fs.writeFileSync(blocked, 'do not rename');
  await assert.rejects(allocateTaskWorkspace({ rootDir: blocked, now: instant }), codeIs('TASK_WORKSPACE_UNSAFE'));
  assert.equal(fs.readFileSync(blocked, 'utf8'), 'do not rename');
});

test('root or ancestor symlinks cannot redirect automatic allocation', async t => {
  const temp = temporary(t), outside = path.join(temp, 'outside'); fs.mkdirSync(outside);
  const linked = path.join(temp, 'linked'); fs.symlinkSync(outside, linked);
  for (const rootDir of [linked, path.join(linked, 'nested')]) {
    await assert.rejects(allocateTaskWorkspace({ rootDir, now: instant }), codeIs('TASK_WORKSPACE_UNSAFE'));
  }
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('a symlink or file at a timestamp is skipped without following or replacing it', async t => {
  const temp = temporary(t), rootDir = path.join(temp, 'root'), outside = path.join(temp, 'outside');
  fs.mkdirSync(rootDir); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(rootDir, '2026-10-26-10-11-12'));
  fs.writeFileSync(path.join(rootDir, '2026-10-26-10-11-13'), 'collision file');
  const result = await allocateTaskWorkspace({ rootDir, now: instant });
  assert.equal(path.basename(result.cwd), '2026-10-26-10-11-14');
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.readFileSync(path.join(rootDir, '2026-10-26-10-11-13'), 'utf8'), 'collision file');
});

test('one hundred native timestamp collisions fail without overwriting an existing directory', async t => {
  const rootDir = temporary(t);
  for (let i = 0; i < 100; i++) fs.mkdirSync(path.join(rootDir, formatTaskWorkspaceTimestamp(new Date(instant().getTime() + i * 1000))));
  await assert.rejects(allocateTaskWorkspace({ rootDir, now: instant }), codeIs('TASK_WORKSPACE_EXHAUSTED'));
  assert.equal(fs.readdirSync(rootDir).length, 100);
});

test('invalid roots and clocks fail before creating task directories', async t => {
  const temp = temporary(t), missing = path.join(temp, 'missing');
  for (const rootDir of ['relative', '/', path.join(temp, 'a') + '/../escape', path.join(temp, '{user}'), path.join(temp, '%USER%'), path.join(temp, '~'), temp + '\0']) {
    await assert.rejects(allocateTaskWorkspace({ rootDir, now: instant }), codeIs('TASK_WORKSPACE_INVALID'));
  }
  for (const now of [null, () => new Date(NaN), () => 123]) {
    await assert.rejects(allocateTaskWorkspace({ rootDir: missing, now }), codeIs('TASK_WORKSPACE_INVALID'));
  }
  assert.equal(fs.existsSync(missing), false);
});
