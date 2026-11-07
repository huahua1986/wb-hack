import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { resolveNativeContext } from '../src/native-context.mjs';
import { writeExpertFixture } from './helpers/expert-fixtures.mjs';

const source = JSON.parse(await fs.readFile(new URL('./fixtures/native-context-591.source.json', import.meta.url), 'utf8'));
function native() {
  const context = vm.createContext({
    zDe: new WeakMap(), normalizeExpertAvatarUrl: value => value, Mnn: 'skill://', safeDecodeUriValue: decodeURIComponent,
    Zr: (name, uri, { title, description, meta, icon }) => ({ type: 'resource_link', name, uri, title, description, _meta: meta, icon }),
    resolveSkillPreferenceId: s => s.skillId ?? s.name, normalizeSkillSource: s => s,
  });
  vm.runInContext(source.functions.map(f => f.source).join('\n'), context);
  return context;
}
async function fixture(t, content = '# Test skill\nUse the selected fixture context.\n') {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wb-pi-context-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'test-skill', 'SKILL.md');
  await fs.mkdir(path.dirname(filename)); await fs.writeFile(filename, content);
  return { dir, filename, skill: { id: 'test-skill', name: '测试技能', filePath: filename } };
}
async function installedFixture(t, options) {
  const configDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wb-pi-installed-context-')));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  return writeExpertFixture(configDir, options);
}
const isCode = code => error => error.code === code;

test('Expert and skill fixtures are exact bounded 5.9.1 source functions', () => {
  assert.equal(source.artifactSHA256, '1fc0a56ddec5437d4dc55a55ba1c028b291ab29cb17306500827015987424233');
  assert.equal(source.memberSHA256, '139726c975eab852879a97797315df5eb1ce9ef3cd580cf6500804b57cdb25c6');
  for (const f of [...source.functions, ...source.additionalSources]) {
    assert.equal(createHash('sha256').update(f.source).digest('hex'), f.sha256);
    assert.equal(Buffer.byteLength(f.source), f.range.end - f.range.start);
  }
});

test('native desktop skill-content consumer reads the exact filePath as a file', async () => {
  const calls = [], selected = '/fixture/skills/one/SKILL.md';
  const context = vm.createContext({ _: { readFile: async (...args) => { calls.push(args); return 'Actual skill instructions'; } }, r: undefined });
  const consumer = vm.runInContext(`({${source.additionalSources.find(f => f.name === 'getSkillContent').source}})`, context);
  assert.equal((await consumer.getSkillContent({ filePath: selected })).content, 'Actual skill instructions');
  assert.deepEqual(calls, [[selected, 'utf-8']]);
});

test('native Expert projection contains real localized instructions and preserves explicit clear', async () => {
  const context = native();
  const expert = context.mapExpertInfo({ id: 'expert-one', displayName: { zh: '财务专家', en: 'Finance' }, prompt: { zh: '请核对现金流。', en: 'Review cash flow.' }, locale: 'zh', defaultInitPrompt: { zh: '你好' }, token: 'excluded-fixture-token' }, 'zh');
  const result = await resolveNativeContext({ expert });
  assert.equal(result.expert.name, '财务专家'); assert.equal(result.expert.prompt, '请核对现金流。');
  assert.match(result.message, /请核对现金流/); assert.doesNotMatch(result.message, /你好|excluded-fixture-token/);
  assert.deepEqual(await resolveNativeContext({ expert: null, skills: [] }), { message: '', expert: null, skills: [], summary: '' });
});

test('installed native Expert retains package and opaque identities while loading only its persona and resource catalog', async t => {
  const f = await installedFixture(t);
  const runtimeIdentity = '  expert-v2:{"opaque":"' + 'x'.repeat(2000) + '"}  ';
  const skillSource = await fs.readFile(f.skillPath, 'utf8');
  await fs.writeFile(f.skillPath, skillSource.replace('allowed-tools: Read', 'allowed-tools: PACKAGE_CANNOT_GRANT_NEW_TOOLS'));
  const result = await resolveNativeContext({ expert: { ...f.selection, runtimeIdentity,
    defaultInitPrompt: 'GREETING_CANNOT_REPLACE_PERSONA', bearerToken: 'SECRET_MUST_NOT_FORWARD' } }, { expertConfigDir: f.configDir });
  assert.equal(result.expert.id, f.selection.id); assert.equal(result.expert.source, 'builtin');
  assert.equal(result.expert.marketExpertId, f.selection.marketExpertId); assert.equal(result.expert.runtimeIdentity, runtimeIdentity);
  assert.equal(result.expert.marketplace, 'experts'); assert.equal(result.expert.pluginName, f.manifest.name);
  assert.equal(result.expert.agentName, 'qa-agent'); assert.equal(result.expert.version, '1.0.0');
  assert.equal(result.expert.localPath, f.root); assert.equal(result.expert.expertRootDir, f.root);
  assert.equal(result.expert.prompt, f.body); assert.ok(result.message.includes(f.body));
  assert.ok(result.message.includes(f.skillPath)); assert.ok(result.message.includes(path.dirname(f.skillPath)));
  assert.match(result.message, /Read this synthetic resource only if the task requires it\./);
  assert.match(result.message, /仅目录|尚未执行/); assert.match(result.message, /不授予新工具权限/);
  assert.deepEqual(result.expert.package.skills[0].requirements, ['allowed-tools']);
  assert.equal(result.expert.package.skills[0].catalogOnly, true);
  assert.deepEqual(result.skills, []); assert.equal(result.tools, undefined); assert.equal(result.expert.tools, undefined);
  assert.equal(result.expert.bearerToken, undefined);
  for (const omitted of [f.skillBody, 'PACKAGE_CANNOT_GRANT_NEW_TOOLS', 'GREETING_CANNOT_REPLACE_PERSONA', 'SECRET_MUST_NOT_FORWARD']) {
    assert.ok(!JSON.stringify(result).includes(omitted), omitted + ' must not enter resolved context');
  }
});

test('serialized installed Expert restores from the same trusted package rather than saved persona or catalog fields', async t => {
  const f = await installedFixture(t), first = await resolveNativeContext({ expert: f.selection }, { expertConfigDir: f.configDir });
  const expert = JSON.parse(JSON.stringify(first.expert));
  expert.prompt = 'SAVED_PROMPT_IS_NOT_AUTHORITATIVE';
  expert.package.skills[0].description = 'SAVED_RESOURCE_DESCRIPTION_IS_NOT_AUTHORITATIVE';
  const restored = await resolveNativeContext({ expert }, { expertConfigDir: f.configDir });
  assert.deepEqual(restored, first);
  assert.ok(!restored.message.includes('SAVED_'));
});

test('installed Expert rejects changed agent, skill and manifest bytes after selection', async t => {
  for (const resource of ['agentPath', 'skillPath', 'manifestPath']) {
    await t.test(resource, async child => {
      const f = await installedFixture(child), first = await resolveNativeContext({ expert: f.selection }, { expertConfigDir: f.configDir });
      const saved = JSON.parse(JSON.stringify(first.expert));
      const original = await fs.readFile(f[resource], 'utf8');
      await fs.writeFile(f[resource], resource === 'manifestPath' ? JSON.stringify({ ...f.manifest, version: '2.0.0' }) : original + '\nCHANGED_SYNTHETIC_RESOURCE');
      await assert.rejects(resolveNativeContext({ expert: saved }, { expertConfigDir: f.configDir }), isCode('PI_EXPERT_PACKAGE_CHANGED'));
    });
  }
});

test('saved Expert packages cannot fall back to an unverified inline prompt without a config root', async t => {
  const f = await installedFixture(t), first = await resolveNativeContext({ expert: f.selection }, { expertConfigDir: f.configDir });
  await assert.rejects(resolveNativeContext({ expert: JSON.parse(JSON.stringify(first.expert)) }), isCode('PI_EXPERT_PACKAGE_UNAVAILABLE'));
  await assert.rejects(resolveNativeContext({ expert: first.expert }, { expertConfigDir: null }), isCode('PI_EXPERT_PACKAGE_UNAVAILABLE'));
});

test('default Expert greetings cannot become persona instructions', async t => {
  const f = await installedFixture(t), greeting = 'SYNTHETIC_DEFAULT_GREETING';
  for (const expert of [{ id: 'unresolved', defaultInitPrompt: greeting }, { id: 'unresolved', prompt: greeting, defaultInitPrompt: greeting }]) {
    await assert.rejects(resolveNativeContext({ expert }), isCode('PI_EXPERT_UNRESOLVED'));
  }
  const result = await resolveNativeContext({ expert: { ...f.selection, prompt: greeting, defaultInitPrompt: greeting } }, { expertConfigDir: f.configDir });
  assert.equal(result.expert.prompt, f.body); assert.ok(!result.message.includes(greeting));
});

test('clearing an installed Expert removes the package persona and progressive catalog together', async t => {
  const f = await installedFixture(t), first = await resolveNativeContext({ expert: f.selection }, { expertConfigDir: f.configDir });
  assert.ok(first.message.includes(f.skillPath));
  const cleared = await resolveNativeContext({ expert: null, skills: [] }, { expertConfigDir: f.configDir });
  assert.deepEqual(cleared, { message: '', expert: null, skills: [], summary: '' });
  const replacement = await resolveNativeContext({ expert: { id: 'inline-next', prompt: 'NEXT_PERSONA_ONLY' } }, { expertConfigDir: f.configDir });
  assert.match(replacement.message, /NEXT_PERSONA_ONLY/);
  for (const stale of [f.body, f.skillPath, 'qa-skill', '资源目录']) assert.ok(!replacement.message.includes(stale));
});

test('installed Expert persona and resource catalog remain within tightened context budgets', async t => {
  const f = await installedFixture(t, { body: 'BOUNDED_PERSONA'.repeat(30) });
  const input = { expert: f.selection }, expertConfigDir = f.configDir;
  const first = await resolveNativeContext(input, { expertConfigDir }); assert.ok(first.message.includes(f.skillPath));
  await assert.rejects(resolveNativeContext(input, { expertConfigDir, limits: { expertBytes: Buffer.byteLength(f.body) - 1 } }), isCode('PI_CONTEXT_LIMIT'));
  await assert.rejects(resolveNativeContext(input, { expertConfigDir, limits: { totalBytes: Buffer.byteLength(f.body) + 1 } }), isCode('PI_CONTEXT_LIMIT'));
  await assert.rejects(resolveNativeContext(input, { expertConfigDir, limits: { totalBytes: 1024 * 1024 } }), isCode('PI_CONTEXT_INVALID'));
});

test('native selected Expert resolves official identity and local fallback without changing origin', async () => {
  const context = native(), calls = [];
  const official = await context.resolveSelectedExpert({ expertId: 'alias', marketExpertId: 'market-one', locale: 'zh', transport: 'local', getOfficial: async args => { calls.push(args); return { id: 'one', prompt: 'actual prompt' }; }, getLocal: async () => { throw Error('must not be called'); } });
  assert.equal(official.marketExpertId, 'market-one'); assert.equal(calls[0].expertId, 'alias');
  const local = await context.resolveSelectedExpert({ expertId: 'own', transport: 'local', getOfficial: async () => { throw Error('unavailable'); }, getLocal: async () => ({ id: 'own', expertRootDir: '/fixture/experts/own', prompt: 'local prompt' }) });
  assert.equal(local.localPath, '/fixture/experts/own'); assert.equal(local.marketplace, 'my-experts');
  assert.equal(local.runtimeIdentity, 'expert:own:my-experts'); assert.equal(local.source, 'custom');
});

test('native skill constructors select identity while installed metadata resolves actual file path', () => {
  const context = native();
  const block = context.buildSkillBlock({ skillId: 'opaque-id', skillName: 'cashflow', displayText: '现金流分析' });
  assert.equal(block.type, 'resource_link'); assert.equal(block.uri, 'skill://opaque-id');
  assert.equal(block._meta.mentionType, 'skill'); assert.equal(block._meta.skillId, 'opaque-id');
  assert.equal(context.readSkillNameFromBlock(block), 'opaque-id');
  const selected = context.mapSkillInfoToInputItem({ name: 'cashflow', skillId: 'opaque-id', filePath: '/fixture/skills/cashflow/SKILL.md', userInvocable: true, source: 'user' });
  assert.equal(selected.metadata.filePath, '/fixture/skills/cashflow/SKILL.md');
  assert.equal(selected.metadata.userInvocable, true);
  assert.equal(context.readSkillNameFromBlock(context.createSkillBlock('a b')), 'a b');
});

test('selected skills read instruction bytes and expose resource directory without loading scripts', async t => {
  const { filename, skill } = await fixture(t, '---\nname: fixture\ndescription: Test\n---\n\nRead ./reference.md when needed.');
  await fs.writeFile(path.join(path.dirname(filename), 'never-run.mjs'), 'throw Error("must not execute")');
  const result = await resolveNativeContext({ expert: { id: 'one', name: 'Expert', prompt: 'Selected expert instructions.', bearerToken: 'do-not-forward' }, skills: [skill] });
  assert.match(result.message, /Selected expert instructions\./); assert.match(result.message, /Read \.\/reference.md/);
  assert.match(result.message, /现有审批/); assert.equal(result.skills[0].filePath, filename);
  assert.equal(result.skills[0].rootDir, path.dirname(filename)); assert.match(result.skills[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.expert.bearerToken, undefined); assert.equal(result.skills[0].content, undefined);
  assert.doesNotMatch(result.message, /must not execute|do-not-forward/);
});

test('saved skill selection restores from the same file and detects changed instructions', async t => {
  const { filename, skill } = await fixture(t), first = await resolveNativeContext({ skills: [skill] });
  const restored = await resolveNativeContext({ skills: JSON.parse(JSON.stringify(first.skills)) });
  assert.equal(restored.message, first.message);
  await fs.writeFile(filename, '# Replaced instructions\n');
  await assert.rejects(resolveNativeContext({ skills: first.skills }), isCode('PI_SKILL_CHANGED'));
});

test('cleared/replaced Expert has no stale instruction content', async () => {
  const first = await resolveNativeContext({ expert: { id: 'first', prompt: 'first instructions' } });
  const next = await resolveNativeContext({ expert: { id: 'next', name: 'Next', prompt: 'next instructions' } });
  assert.match(first.message, /first instructions/); assert.doesNotMatch(next.message, /first instructions/);
  assert.equal((await resolveNativeContext()).message, '');
  await assert.rejects(resolveNativeContext({ expert: { id: 'only-name', name: 'Not instructions' } }), isCode('PI_EXPERT_UNRESOLVED'));
});

test('duplicate skill paths are loaded once', async t => {
  const { skill } = await fixture(t); const result = await resolveNativeContext({ skills: [skill, { ...skill, name: 'Alias' }] });
  assert.equal(result.skills.length, 1); assert.equal(result.message.split('Use the selected fixture context.').length, 2);
});

test('only normalized absolute local SKILL.md files can be selected', async t => {
  const { filename, dir, skill } = await fixture(t);
  const other = path.join(dir, 'private.txt'); await fs.writeFile(other, 'do not read');
  for (const filePath of ['relative/SKILL.md', 'file://' + filename, 'https://example.test/SKILL.md', other, path.dirname(filename), path.dirname(filename) + '/../test-skill/SKILL.md', filename + '\0']) {
    await assert.rejects(resolveNativeContext({ skills: [{ ...skill, filePath }] }), isCode('PI_SKILL_PATH_INVALID'));
  }
});

test('final symlinks and symlinked ancestors cannot redirect selected skills', async t => {
  const { dir, filename, skill } = await fixture(t);
  await fs.mkdir(path.join(dir, 'link-skill')); await fs.symlink(filename, path.join(dir, 'link-skill', 'SKILL.md'));
  await fs.symlink(path.dirname(filename), path.join(dir, 'linked-directory'));
  for (const filePath of [path.join(dir, 'link-skill', 'SKILL.md'), path.join(dir, 'linked-directory', 'SKILL.md')]) {
    await assert.rejects(resolveNativeContext({ skills: [{ ...skill, filePath }] }), isCode('PI_SKILL_PATH_INVALID'));
  }
});

test('UTF-8, null bytes, surrogate input and empty instructions fail explicitly', async t => {
  const { filename, skill } = await fixture(t);
  for (const content of [Buffer.from([0xff, 0xfe]), Buffer.from('secret\0bytes'), Buffer.from(' \n')]) {
    await fs.writeFile(filename, content);
    await assert.rejects(resolveNativeContext({ skills: [skill] }), isCode('PI_CONTEXT_INVALID'));
  }
  await assert.rejects(resolveNativeContext({ expert: { id: 'x', prompt: 'invalid\ud800' } }), isCode('PI_CONTEXT_INVALID'));
});

test('counts and byte limits reject unbounded context and cannot be loosened', async t => {
  const { skill } = await fixture(t);
  await assert.rejects(resolveNativeContext({ skills: Array(9).fill(skill) }), isCode('PI_CONTEXT_LIMIT'));
  await assert.rejects(resolveNativeContext({ expert: { id: 'x', prompt: '中文'.repeat(5000) } }, { limits: { expertBytes: 20 } }), isCode('PI_CONTEXT_LIMIT'));
  await assert.rejects(resolveNativeContext({ skills: [skill] }, { limits: { skillBytes: 2 } }), isCode('PI_CONTEXT_LIMIT'));
  await assert.rejects(resolveNativeContext({ skills: [skill] }, { limits: { totalBytes: 2 } }), isCode('PI_CONTEXT_LIMIT'));
  await assert.rejects(resolveNativeContext({}, { limits: { skillBytes: 1024 * 1024 } }), isCode('PI_CONTEXT_INVALID'));
  await assert.rejects(resolveNativeContext({}, { limits: { unrecognized: 1 } }), isCode('PI_CONTEXT_INVALID'));
});

test('missing or disabled skills fail and cancellation stops context preparation', async t => {
  const { dir, skill } = await fixture(t);
  await assert.rejects(resolveNativeContext({ skills: [{ ...skill, filePath: path.join(dir, 'missing', 'SKILL.md') }] }), isCode('PI_SKILL_UNAVAILABLE'));
  for (const forbidden of [{ disabled: true }, { enabled: false }, { userInvocable: false }]) {
    await assert.rejects(resolveNativeContext({ skills: [{ ...skill, ...forbidden }] }), isCode('PI_SKILL_UNAVAILABLE'));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolveNativeContext({ skills: [skill], signal: controller.signal }), isCode('PI_CONTEXT_ABORTED'));
});
