import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveInstalledExpert, EXPERT_PACKAGE_LIMITS } from '../src/expert-package.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const code = expected => error => error.code === 'PI_EXPERT_PACKAGE_' + expected;
const baseSelection = { id: 'SeniorDeveloper', marketExpertId: 'ex_aG1kvKbq8lPx', name: '吴八哥', source: 'builtin', expertType: 'agent',
  pluginName: 'senior-developer', agentName: 'senior-developer', marketplace: 'experts', locale: 'zh',
  runtimeIdentity: 'expert-v2:{"v":2,"kind":"expert","expertId":"SeniorDeveloper","marketExpertId":"ex_aG1kvKbq8lPx","agentName":"senior-developer","source":"builtin"}' };
async function fixture(t, { marketplace = 'experts', bundle = 'senior-developer', agent = '---\nname: senior-developer\ndescription: Synthetic agent\n---\n\nACTUAL_SYNTHETIC_EXPERT_BODY\n', skills } = {}) {
  const configDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-expert-package-')));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  const root = path.join(configDir, 'plugins/marketplaces', marketplace, 'plugins', bundle);
  const manifestPath = path.join(root, '.codebuddy-plugin/plugin.json'), agentPath = path.join(root, 'agents/senior-developer.md');
  const mapPath = path.join(configDir, 'app/cache/experts/expert-bundle-map.json');
  const skillTexts = skills ?? { 'browser-use': '---\nname: browser-use\ndescription: Read browser references when needed.\nallowed-tools: Bash\n---\n\nSKILL_BODY_MUST_NOT_BE_INLINED\n', 'frontend-dev': '---\nname: frontend-dev\ndescription: >\n  Synthetic frontend\n  resource catalog.\n---\n\nFRONTEND_BODY_NOT_INLINED\n' };
  const manifest = { name: bundle, version: '1.1.1', expertType: 'agent', agentName: 'senior-developer', displayName: 'Synthetic Developer',
    agents: ['./agents/senior-developer.md'], skills: Object.keys(skillTexts).map(name => './skills/' + name) };
  for (const filename of [manifestPath, agentPath, mapPath]) await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.writeFile(manifestPath, JSON.stringify(manifest)); await fs.writeFile(agentPath, agent);
  await fs.writeFile(mapPath, JSON.stringify({ SeniorDeveloper: 'senior-developer', ex_aG1kvKbq8lPx: 'senior-developer' }));
  for (const [name, text] of Object.entries(skillTexts)) {
    const filename = path.join(root, 'skills', name, 'SKILL.md'); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, text);
  }
  return { configDir, root, manifestPath, agentPath, mapPath, manifest, skillTexts,
    resolve: (selection = baseSelection, options = {}) => resolveInstalledExpert(selection, { configDir, ...options }),
    writeManifest: value => fs.writeFile(manifestPath, JSON.stringify(value)) };
}

test('installed builtin identity resolves actual agent instructions and progressive resource descriptors', async t => {
  const f = await fixture(t), value = await f.resolve({ ...baseSelection, defaultInitPrompt: 'GREETING_MUST_NOT_BE_PERSONA', bearerToken: 'DO_NOT_FORWARD' });
  assert.equal(value.id, 'SeniorDeveloper'); assert.equal(value.name, '吴八哥'); assert.equal(value.source, 'builtin');
  assert.equal(value.marketExpertId, baseSelection.marketExpertId); assert.equal(value.runtimeIdentity, baseSelection.runtimeIdentity);
  assert.equal(value.prompt, 'ACTUAL_SYNTHETIC_EXPERT_BODY'); assert.equal(value.localPath, f.root);
  assert.equal(value.expertRootDir, f.root); assert.equal(value.version, '1.1.1');
  assert.equal(value.package.agentPath, f.agentPath); assert.equal(value.package.manifestSha256, hash(await fs.readFile(f.manifestPath)));
  assert.equal(value.package.agentSha256, hash(await fs.readFile(f.agentPath))); assert.equal(value.package.skills.length, 2);
  const resource = value.package.skills[0];
  assert.equal(resource.filePath, path.join(f.root, 'skills/browser-use/SKILL.md'));
  assert.equal(resource.sha256, hash(await fs.readFile(resource.filePath))); assert.equal(resource.catalogOnly, true);
  assert.deepEqual(resource.requirements, ['allowed-tools']);
  assert.equal(value.package.skills[1].description, 'Synthetic frontend resource catalog.');
  assert.doesNotMatch(JSON.stringify(value), /SKILL_BODY|FRONTEND_BODY|GREETING|DO_NOT_FORWARD|Bearer/);
});

test('bare shipped alias uses the installed cache mapping without fabricating market or source identity', async t => {
  const f = await fixture(t), value = await f.resolve({ id: 'SeniorDeveloper' });
  assert.equal(value.pluginName, 'senior-developer'); assert.equal(value.marketplace, 'experts');
  assert.equal(value.agentName, 'senior-developer'); assert.equal(value.prompt, 'ACTUAL_SYNTHETIC_EXPERT_BODY');
  assert.equal(value.marketExpertId, undefined); assert.equal(value.source, undefined);
  await fs.rm(f.mapPath);
  assert.equal(await f.resolve({ id: 'SeniorDeveloper' }), null);
  assert.ok(await f.resolve({ id: 'explicit', pluginName: 'senior-developer' }));
});

test('missing configuration or installation remains unresolved without creating files', async t => {
  assert.equal(await resolveInstalledExpert(baseSelection), null);
  const f = await fixture(t);
  assert.equal(await resolveInstalledExpert(baseSelection, { configDir: path.join(f.configDir, 'absent') }), null);
  assert.equal(await f.resolve({ id: 'unknown' }), null);
  const before = await fs.readdir(f.configDir);
  assert.equal(await f.resolve({ id: 'unknown', pluginName: 'missing' }), null);
  assert.deepEqual(await fs.readdir(f.configDir), before);
});

test('explicit package paths and market/plugin/cache conflicts are validated instead of guessed', async t => {
  const f = await fixture(t);
  assert.equal((await f.resolve({ ...baseSelection, localPath: f.root })).prompt, 'ACTUAL_SYNTHETIC_EXPERT_BODY');
  for (const selection of [{ ...baseSelection, pluginName: 'different' }, { ...baseSelection, marketplace: 'other', localPath: f.root },
    { ...baseSelection, expertRootDir: path.dirname(f.root), localPath: f.root }]) await assert.rejects(f.resolve(selection), code('IDENTITY'));
  await fs.writeFile(f.mapPath, JSON.stringify({ SeniorDeveloper: 'different', ex_aG1kvKbq8lPx: 'senior-developer' }));
  await assert.rejects(f.resolve(), code('IDENTITY'));
  await assert.rejects(f.resolve({ ...baseSelection, localPath: path.join(f.configDir, 'private') }), code('UNSAFE'));
  await assert.rejects(f.resolve({ ...baseSelection, marketExpertId: 'SeniorDeveloper' }), code('IDENTITY'));
  await assert.rejects(f.resolve({ ...baseSelection, source: 'custom-other' }), code('IDENTITY'));
});

test('true local custom selections cannot use official cache mappings or relabel an official package', async t => {
  const f = await fixture(t);
  assert.equal(await f.resolve({ id: 'SeniorDeveloper', source: 'custom' }), null);
  await assert.rejects(f.resolve({ ...baseSelection, source: 'custom' }), code('IDENTITY'));
  const local = await fixture(t, { marketplace: 'my-experts', bundle: 'own-agent' });
  const value = await local.resolve({ id: 'own', source: 'custom', pluginName: 'own-agent', localPath: local.root });
  assert.equal(value.source, 'custom'); assert.equal(value.marketplace, 'my-experts'); assert.equal(value.id, 'own');
});

test('multiple declared agents require a unique explicit identity, and inactive frontmatter is not activated', async t => {
  const f = await fixture(t);
  const other = path.join(f.root, 'agents/other.md'); await fs.writeFile(other, '---\nname: other\ntools: Bash\n---\n\nOTHER_AGENT_BODY\n');
  await f.writeManifest({ ...f.manifest, agents: [...f.manifest.agents, './agents/other.md'] });
  assert.equal((await f.resolve()).prompt, 'ACTUAL_SYNTHETIC_EXPERT_BODY');
  await f.writeManifest({ ...f.manifest, agentName: undefined, agents: [...f.manifest.agents, './agents/other.md'] });
  await assert.rejects(f.resolve({ id: 'SeniorDeveloper' }), code('IDENTITY'));
  await assert.rejects(f.resolve({ ...baseSelection, agentName: 'other' }), code('UNSUPPORTED'));
  await assert.rejects(f.resolve({ ...baseSelection, agentName: 'not-declared' }), code('IDENTITY'));
});

test('manifest paths cannot traverse, escape, use URLs or select undeclared file types', async t => {
  const f = await fixture(t);
  for (const value of ['../private.md', '/private/secret.md', 'https://example.invalid/a.md', './agents/../private.md', './agents\\file.md']) {
    await f.writeManifest({ ...f.manifest, agents: [value] }); await assert.rejects(f.resolve(), code('UNSAFE'));
  }
  await f.writeManifest({ ...f.manifest, agents: ['./agents/script.mjs'] }); await assert.rejects(f.resolve(), code('UNSUPPORTED'));
  await f.writeManifest({ ...f.manifest, skills: ['../../private'] }); await assert.rejects(f.resolve(), code('UNSAFE'));
  await f.writeManifest({ ...f.manifest, skills: ['./skills/not-a-skill.md'] }); await assert.rejects(f.resolve(), code('UNSUPPORTED'));
});

test('symlinked configuration, package ancestors or final files and hardlinks are rejected', async t => {
  const f = await fixture(t), link = f.configDir + '-link';
  await fs.symlink(f.configDir, link); t.after(() => fs.rm(link, { force: true }));
  await assert.rejects(resolveInstalledExpert(baseSelection, { configDir: link }), code('UNSAFE'));
  const saved = f.agentPath + '.saved'; await fs.rename(f.agentPath, saved); await fs.symlink(saved, f.agentPath);
  await assert.rejects(f.resolve(), code('UNSAFE')); await fs.unlink(f.agentPath); await fs.link(saved, f.agentPath);
  await assert.rejects(f.resolve(), code('UNSAFE'));
  const other = await fixture(t), assets = path.join(other.root, 'skills/browser-use');
  await fs.rename(assets, assets + '.saved'); await fs.symlink(assets + '.saved', assets);
  await assert.rejects(other.resolve(), code('UNSAFE'));
});

test('unsupported runtime declarations, team graphs and executable activation are not silently ignored', async t => {
  const f = await fixture(t);
  for (const declaration of [{ hooks: { SessionStart: [{ command: 'must-not-run' }] } }, { mcpServers: { remote: { url: 'https://example.invalid' } } },
    { extensions: ['never-run.mjs'] }, { expertType: 'team' }]) {
    await f.writeManifest({ ...f.manifest, ...declaration }); await assert.rejects(f.resolve(), code('UNSUPPORTED'));
  }
  await f.writeManifest(f.manifest);
  for (const entry of ['tools: Bash', 'model: other', 'permissionMode: bypassPermissions', 'hooks: anything', 'team: {}']) {
    await fs.writeFile(f.agentPath, '---\nname: senior-developer\n' + entry + '\n---\n\nNEVER_ACTIVATE\n');
    await assert.rejects(f.resolve(), code('UNSUPPORTED'));
  }
});

test('byte/count/UTF-8 budgets are bounded and cannot be loosened', async t => {
  const f = await fixture(t);
  for (const limits of [{ manifestBytes: 2 }, { expertBytes: 2 }, { skillBytes: 2 }, { totalBytes: 2 }, { skills: 1 }]) await assert.rejects(f.resolve(baseSelection, { limits }), code('LIMIT'));
  for (const limits of [{ expertBytes: EXPERT_PACKAGE_LIMITS.expertBytes + 1 }, { secret: 1 }, { skills: 0 }]) await assert.rejects(f.resolve(baseSelection, { limits }), code('INVALID'));
  await fs.writeFile(f.agentPath, Buffer.from([0xff, 0xfe])); await assert.rejects(f.resolve(), code('INVALID'));
  await fs.writeFile(f.agentPath, 'bad\0content'); await assert.rejects(f.resolve(), code('INVALID'));
  await fs.writeFile(f.agentPath, '---\nname: senior-developer\n---\n'); await assert.rejects(f.resolve(), code('INVALID'));
  await fs.writeFile(f.agentPath, 'SYNTHETIC_AGENT');
  await fs.writeFile(path.join(f.root, 'skills/browser-use/SKILL.md'), '---\nname: browser-use\ndescription: "\\ud800"\n---\n\nresource');
  await assert.rejects(f.resolve(), code('INVALID'));
});

test('persisted package identity restores and detects changed agent, manifest or associated skill', async t => {
  const f = await fixture(t), first = await f.resolve(), restored = await f.resolve(JSON.parse(JSON.stringify(first)));
  assert.deepEqual(restored, first);
  const agent = await fs.readFile(f.agentPath); await fs.writeFile(f.agentPath, agent + '\nChanged');
  await assert.rejects(f.resolve(first), code('CHANGED')); await fs.writeFile(f.agentPath, agent);
  const skill = first.package.skills[0].filePath, content = await fs.readFile(skill); await fs.writeFile(skill, content + '\nChanged skill');
  await assert.rejects(f.resolve(first), code('CHANGED')); await fs.writeFile(skill, content);
  await f.writeManifest({ ...f.manifest, version: '1.1.2' }); await assert.rejects(f.resolve(first), code('CHANGED'));
  await fs.rm(f.manifestPath); await assert.rejects(f.resolve(first), code('CHANGED'));
});

test('atomic replacement during a read is rejected before any content is returned', async t => {
  const f = await fixture(t), original = fs.open; let changed = false;
  fs.open = async (...args) => {
    const handle = await original(...args);
    if (args[0] === f.agentPath && !changed) {
      const read = handle.read.bind(handle);
      handle.read = async (...values) => { const result = await read(...values); changed = true; await fs.rename(f.agentPath, f.agentPath + '.old'); await fs.writeFile(f.agentPath, 'replacement'); return result; };
    }
    return handle;
  };
  t.after(() => { fs.open = original; });
  await assert.rejects(f.resolve(), code('CHANGED')); assert.equal(changed, true);
});

test('earlier manifest changes during later resource reads are detected', async t => {
  const f = await fixture(t), original = fs.open; let changed = false;
  fs.open = async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).endsWith('/SKILL.md') && !changed) {
      changed = true; await f.writeManifest({ ...f.manifest, version: '2.0.0' });
    }
    return handle;
  };
  t.after(() => { fs.open = original; });
  await assert.rejects(f.resolve(), code('CHANGED'));
});

test('catalog-only skill resources do not execute scripts or use network, and descriptions remain valid UTF-8', async t => {
  const f = await fixture(t, { skills: { 'a.b': '---\nname: synthetic\ndescription: "' + '😀'.repeat(600) + '"\nallowed-tools: Bash\nhooks: false\n---\n\n' + 'LARGE_BODY_MUST_NOT_BE_INLINED_'.repeat(3000) } });
  const script = path.join(f.root, 'skills/a.b/never-run.mjs'); await fs.writeFile(script, 'throw Error("MUST_NOT_RUN")');
  const original = globalThis.fetch; globalThis.fetch = () => { throw Error('MUST_NOT_FETCH'); }; t.after(() => { globalThis.fetch = original; });
  const result = await f.resolve(), resource = result.package.skills[0];
  assert.equal(resource.catalogOnly, true); assert.deepEqual(resource.requirements, ['allowed-tools', 'hooks']);
  assert.ok(Buffer.byteLength(resource.description) <= 1024); assert.doesNotMatch(resource.description, /\uFFFD/);
  assert.doesNotMatch(JSON.stringify(result), /LARGE_BODY|MUST_NOT_RUN/);
});

test('cancelled preparation returns a typed cancellation without activation', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.resolve(baseSelection, { signal: controller.signal }), error => error.code === 'PI_CONTEXT_ABORTED');
});

test('legacy prompt lookup remains available while opaque runtime identity is retained exactly', async t => {
  const f = await fixture(t), identity = baseSelection.runtimeIdentity + ' ';
  assert.equal((await f.resolve({ ...baseSelection, runtimeIdentity: identity })).runtimeIdentity, identity);
  await f.writeManifest({ ...f.manifest, expertType: 'prompt', agents: undefined });
  assert.equal(await f.resolve(baseSelection), null);
});
