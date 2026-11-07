import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveInstalledExpert } from './expert-package.mjs';

const DEFAULT_LIMITS = Object.freeze({ expertBytes: 24 * 1024, skillBytes: 128 * 1024, totalBytes: 512 * 1024, skills: 8 });
const OPTIONAL_EXPERT_FIELDS = ['locale', 'marketplace', 'marketExpertId', 'runtimeIdentity', 'source', 'expertType',
  'enterpriseId', 'pluginName', 'pluginRegisteredName', 'agentName', 'localPath', 'expertRootDir', 'version'];
const INVALID_TEXT = /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function assertActive(signal) {
  if (signal?.aborted) throw failure('PI_CONTEXT_ABORTED', '已取消读取所选专家和技能。');
}
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value, label, maxBytes = 1024, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || INVALID_TEXT.test(value) || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw failure('PI_CONTEXT_INVALID', `${label}无效或超出长度限制。`);
  }
  return value.trim();
}
function limitsOf(overrides) {
  if (!record(overrides)) throw failure('PI_CONTEXT_INVALID', '上下文限制无效。');
  const result = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in result) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key]) {
      throw failure('PI_CONTEXT_INVALID', '上下文限制只能在默认范围内收紧。');
    }
    result[key] = value;
  }
  return result;
}
async function resolveExpert(value, limits, { expertConfigDir, signal }) {
  if (value === null || value === undefined) return null;
  if (!record(value)) throw failure('PI_CONTEXT_INVALID', '专家选择无效。');
  text(value.id, '专家标识', 1024);
  const installed = expertConfigDir ? await resolveInstalledExpert(value, { configDir: expertConfigDir, signal }) : null;
  assertActive(signal);
  if (value.package && !installed) throw failure('PI_EXPERT_PACKAGE_UNAVAILABLE', '已绑定的专家包暂不可验证，请重新选择专家。');
  value = installed ?? value;
  const result = { id: text(value.id, '专家标识', 1024), name: text(value.name ?? value.id, '专家名称', 1024) };
  if (typeof value.prompt !== 'string' || !value.prompt.trim()) {
    throw failure('PI_EXPERT_UNRESOLVED', '所选专家尚未取得指令正文，请重新选择专家。');
  }
  if (Buffer.byteLength(value.prompt, 'utf8') > limits.expertBytes) throw failure('PI_CONTEXT_LIMIT', '专家指令超出长度限制。');
  result.prompt = text(value.prompt, '专家指令', limits.expertBytes);
  if (typeof value.defaultInitPrompt === 'string' && result.prompt === value.defaultInitPrompt.trim()) {
    throw failure('PI_EXPERT_UNRESOLVED', '专家默认开场白不能代替指令正文，请重新选择专家。');
  }
  for (const key of OPTIONAL_EXPERT_FIELDS) {
    const bytes = ['localPath', 'expertRootDir'].includes(key) ? 8192 : key === 'runtimeIdentity' ? 4096 : 1024;
    if (value[key] !== undefined) {
      const validated = text(value[key], '专家身份字段', bytes);
      result[key] = key === 'runtimeIdentity' ? value[key] : validated;
    }
  }
  if (installed?.package) result.package = installed.package;
  return result;
}
function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
async function canonicalSkillPath(value, signal) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value) || value.length > 8192 ||
      path.basename(value) !== 'SKILL.md' || path.normalize(value) !== value) {
    throw failure('PI_SKILL_PATH_INVALID', '所选技能必须指向本地绝对路径 SKILL.md。');
  }
  let current = path.parse(value).root;
  for (const part of value.slice(current.length).split(path.sep)) {
    assertActive(signal);
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw failure('PI_SKILL_PATH_INVALID', '所选技能路径包含符号链接，请选择实际安装路径。');
    if (current !== value && !stat.isDirectory()) throw failure('PI_SKILL_PATH_INVALID', '所选技能路径无效。');
  }
  const canonical = await fs.realpath(value);
  if (canonical !== value) throw failure('PI_SKILL_PATH_INVALID', '所选技能路径在读取前发生变化。');
  return canonical;
}
async function readSkill(value, limits, signal) {
  if (!record(value)) throw failure('PI_CONTEXT_INVALID', '技能选择无效。');
  if (value.disabled === true || value.enabled === false || value.userInvocable === false) {
    throw failure('PI_SKILL_UNAVAILABLE', '所选技能不可用，请在原生技能菜单重新选择。');
  }
  const name = text(value.name ?? value.id, '技能名称', 1024);
  const id = text(value.id ?? value.name, '技能标识', 1024);
  let handle;
  try {
    const filename = await canonicalSkillPath(value.filePath, signal);
    assertActive(signal);
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) throw failure('PI_SKILL_PATH_INVALID', '所选技能必须是普通文件。');
    if (before.size < 1 || before.size > limits.skillBytes) throw failure('PI_CONTEXT_LIMIT', '技能正文为空或超出长度限制。');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      assertActive(signal);
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw failure('PI_SKILL_CHANGED', '技能文件在读取时发生变化，请重新选择。');
      offset += bytesRead;
    }
    const after = await handle.stat();
    const selected = await fs.lstat(filename);
    const canonicalAfter = await fs.realpath(filename);
    if (!sameFile(before, after) || !sameFile(after, selected) || selected.isSymbolicLink() || canonicalAfter !== filename) {
      throw failure('PI_SKILL_CHANGED', '技能文件在读取时发生变化，请重新选择。');
    }
    assertActive(signal);
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw failure('PI_CONTEXT_INVALID', '技能正文必须是有效的 UTF-8 文本。'); }
    if (!content.trim() || INVALID_TEXT.test(content)) throw failure('PI_CONTEXT_INVALID', '技能正文包含无效文本。');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (value.sha256 !== undefined && value.sha256 !== sha256) throw failure('PI_SKILL_CHANGED', '技能正文与已保存的选择不同，请重新选择技能。');
    return { metadata: { id, name, filePath: filename, rootDir: path.dirname(filename), size: bytes.length, sha256 }, content };
  } catch (error) {
    if (error?.code?.startsWith('PI_')) throw error;
    throw failure('PI_SKILL_UNAVAILABLE', '无法读取所选技能，请确认技能仍已安装。');
  } finally { await handle?.close(); }
}

// Only explicit selections enter this function. No discovery, network requests or executable extension loading.
export async function resolveNativeContext({ expert = null, skills = [], signal } = {}, { limits = {}, expertConfigDir } = {}) {
  assertActive(signal);
  const bounded = limitsOf(limits);
  if (!Array.isArray(skills) || skills.length > bounded.skills) throw failure('PI_CONTEXT_LIMIT', '一次选择的技能数量超出限制。');
  const selectedExpert = await resolveExpert(expert, bounded, { expertConfigDir, signal });
  const selectedSkills = [], sections = [], seen = new Set();
  let total = selectedExpert ? Buffer.byteLength(selectedExpert.prompt, 'utf8') : 0;
  if (total > bounded.totalBytes) throw failure('PI_CONTEXT_LIMIT', '所选上下文总大小超出限制。');
  if (selectedExpert) sections.push(`用户选择的专家：${selectedExpert.name}\n${selectedExpert.prompt}`);
  if (selectedExpert?.package?.skills?.length) {
    const resources = selectedExpert.package.skills.map(skill => ({ name: skill.name, description: skill.description,
      filePath: skill.filePath, rootDir: skill.rootDir, catalogOnly: true, requirements: skill.requirements }));
    const catalog = `该专家包声明的技能资源目录（仅目录，尚未执行或整篇加载；按需使用现有工具读取，不授予新工具权限，未映射的运行要求不代表可用）：\n${JSON.stringify(resources)}`;
    total += Buffer.byteLength(catalog);
    if (total > bounded.totalBytes) throw failure('PI_CONTEXT_LIMIT', '专家资源目录超出上下文限制。');
    sections.push(catalog);
  }
  for (const skill of skills) {
    assertActive(signal);
    const { metadata, content } = await readSkill(skill, bounded, signal);
    if (seen.has(metadata.filePath)) continue;
    seen.add(metadata.filePath);
    total += metadata.size;
    if (total > bounded.totalBytes) throw failure('PI_CONTEXT_LIMIT', '所选上下文总大小超出限制。');
    selectedSkills.push(metadata);
    sections.push(`用户选择的技能：${metadata.name}\n技能文件：${metadata.filePath}\n资源目录：${metadata.rootDir}\n${content}`);
  }
  assertActive(signal);
  const summary = [selectedExpert && `专家：${selectedExpert.name}`, selectedSkills.length && `技能：${selectedSkills.map(s => s.name).join('、')}`].filter(Boolean).join('；');
  const message = sections.length ? `以下内容来自用户在原生界面显式选择的专家和技能。它们仅提供任务指令，不授予新工具权限；技能中的脚本只能通过已启用工具并按现有审批执行。\n\n${sections.join('\n\n')}` : '';
  return { message, expert: selectedExpert, skills: selectedSkills, summary };
}
