import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const EXPERT_PACKAGE_LIMITS = Object.freeze({ manifestBytes: 64 * 1024, expertBytes: 24 * 1024,
  skillBytes: 128 * 1024, totalBytes: 512 * 1024, skills: 8, agents: 32 });
const BAD_TEXT = /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IDENTITY_FIELDS = ['marketExpertId', 'runtimeIdentity', 'source', 'expertType', 'enterpriseId', 'pluginRegisteredName'];
const SKILL_REQUIREMENTS = new Set(['tools', 'allowed-tools', 'disallowed-tools', 'model', 'context', 'agent', 'hooks', 'mcp', 'mcpServers', 'mcp-servers', 'skills',
  'user-invocable', 'disable-model-invocation']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code: 'PI_EXPERT_PACKAGE_' + code }); };
function active(signal) { if (signal?.aborted) throw Object.assign(new Error('已取消读取所选专家包。'), { code: 'PI_CONTEXT_ABORTED' }); }
function label(value, max = 1024) {
  if (typeof value !== 'string' || !value.trim() || BAD_TEXT.test(value) || /[\x00-\x1f\x7f]/.test(value)
    || Buffer.byteLength(value) > max) fail('INVALID', '专家包身份字段无效。');
  return value.trim();
}
function component(value) {
  const result = label(value, 128);
  if (!COMPONENT.test(result) || result === '.' || result === '..') fail('IDENTITY', '专家包名称或市场身份无效。');
  return result;
}
function absolute(value) {
  if (typeof value !== 'string' || value.length > 8192 || BAD_TEXT.test(value) || /[\x00-\x1f\x7f\\]/.test(value)
    || !path.isAbsolute(value) || path.normalize(value) !== value) fail('UNSAFE', '专家包必须位于规范的已安装目录。');
  return value;
}
function localized(value, locale) {
  if (typeof value === 'string') return value.trim() ? label(value) : undefined;
  if (!object(value)) return undefined;
  for (const key of [locale, locale === 'en' ? 'zh' : 'en']) if (typeof value[key] === 'string' && value[key].trim()) return label(value[key]);
}
function shortDescription(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (BAD_TEXT.test(value) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail('INVALID', '专家包技能说明包含无效文本。');
  let result = '', bytes = 0;
  for (const part of value.trim()) { const size = Buffer.byteLength(part); if (bytes + size > 1024) break; result += part; bytes += size; }
  return result;
}
function limitsOf(overrides) {
  if (!object(overrides)) fail('INVALID', '专家包限制无效。');
  const result = { ...EXPERT_PACKAGE_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(result, key) || !Number.isSafeInteger(value) || value < 1 || value > result[key]) fail('INVALID', '专家包限制只能收紧。');
    result[key] = value;
  }
  return result;
}
function same(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function directories(filename, signal) {
  const chain = []; let current = path.parse(filename).root;
  for (const part of filename.slice(current.length).split(path.sep).filter(Boolean)) {
    active(signal); current = path.join(current, part);
    const stat = await fs.lstat(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE', '专家包目录包含符号链接或异常节点。');
    chain.push({ filename: current, dev: stat.dev, ino: stat.ino });
  }
  if (await fs.realpath(filename) !== filename) fail('UNSAFE', '专家包目录不是实际安装路径。');
  return chain;
}
async function checkChain(chain, signal) {
  for (const item of chain) {
    active(signal); const stat = await fs.lstat(item.filename, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== item.dev || stat.ino !== item.ino) fail('CHANGED', '专家包目录在读取时发生变化，请重新选择。');
  }
}
async function readFile(filename, maximum, signal, reads) {
  const chain = await directories(path.dirname(filename), signal);
  let handle;
  try {
    const selected = await fs.lstat(filename, { bigint: true });
    if (!selected.isFile() || selected.isSymbolicLink() || selected.nlink !== 1n) fail('UNSAFE', '专家包只允许普通且独占的已安装文件。');
    if (selected.size < 1n || selected.size > BigInt(maximum)) fail('LIMIT', '专家包文件为空或超过读取限制。');
    await checkChain(chain, signal);
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !same(selected, opened)) fail('CHANGED', '专家包文件在读取前发生变化。');
    const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
    while (offset < bytes.length) {
      active(signal); const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) fail('CHANGED', '专家包文件在读取时发生变化。');
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await fs.lstat(filename, { bigint: true });
    if (!same(opened, after) || !same(after, current) || current.isSymbolicLink() || current.nlink !== 1n
      || await fs.realpath(filename) !== filename) fail('CHANGED', '专家包文件在读取时发生变化。');
    await checkChain(chain, signal);
    let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('INVALID', '专家包文件必须是有效UTF-8文本。'); }
    if (BAD_TEXT.test(text)) fail('INVALID', '专家包文件包含无效文本。');
    const result = { filename, bytes: bytes.length, text, sha256: sha(bytes), stat: after, chain };
    reads.push(result); return result;
  } finally { await handle?.close(); }
}
async function optionalDirectory(filename, signal) {
  try { return await directories(filename, signal); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function relativeFile(root, value) {
  if (typeof value !== 'string' || value.length > 2048 || BAD_TEXT.test(value) || /[\x00-\x1f\x7f\\]/.test(value)
    || path.isAbsolute(value) || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value)) fail('UNSAFE', '专家包声明的文件必须在包目录内。');
  const relative = value.startsWith('./') ? value.slice(2) : value;
  if (!relative || relative.split('/').some(p => !p || p === '.' || p === '..')) fail('UNSAFE', '专家包声明的路径包含越界或无效段。');
  const filename = path.join(root, relative);
  if (!filename.startsWith(root + path.sep)) fail('UNSAFE', '专家包文件路径超出安装目录。');
  return filename;
}
function scalar(value) {
  const raw = value.trim();
  if (raw.startsWith('"')) { try { const result = JSON.parse(raw); return typeof result === 'string' ? result : undefined; } catch { return undefined; } }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'");
  return raw.replace(/\s+#.*$/, '');
}
function markdown(text, agent = false) {
  const original = text.replace(/^\uFEFF/, ''); let body = original, fields = {};
  if (/^---\r?\n/.test(original)) {
    const match = original.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) fail('INVALID', '专家包Markdown元数据未正确闭合。');
    body = original.slice(match[0].length);
    const lines = match[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]; if (!line.trim() || /^\s*#/.test(line)) continue;
      const item = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
      if (!item) { if (agent) fail('UNSUPPORTED', '专家指令含尚未映射的复杂元数据。'); continue; }
      const [, key, raw] = item;
      if (Object.hasOwn(fields, key)) fail('INVALID', '专家包Markdown元数据重复。');
      if (agent && !['name', 'description'].includes(key)) fail('UNSUPPORTED', '专家包含尚未映射的运行配置，请勿按普通指令执行。');
      if (/^[|>][-+]?$/.test(raw)) {
        const parts = [];
        while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || !lines[i + 1].trim())) parts.push(lines[++i].trim());
        fields[key] = parts.join(raw.startsWith('>') ? ' ' : '\n').trim();
      } else fields[key] = scalar(raw);
    }
  }
  if (!body.trim()) fail('INVALID', '专家包Markdown没有指令正文。');
  return { body: body.trim(), fields };
}
function hasDeclaration(value) {
  return value !== undefined && value !== null && value !== false && value !== ''
    && !(Array.isArray(value) && value.length === 0) && !(object(value) && Object.keys(value).length === 0);
}
function expectedUnchanged(previous, next) {
  if (previous === undefined) return;
  if (!object(previous)) fail('INVALID', '已保存的专家包身份无效。');
  for (const key of ['root', 'manifestPath', 'manifestSha256', 'agentPath', 'agentSha256']) {
    if (previous[key] !== next[key]) fail('CHANGED', '已选专家包已变化，请重新选择专家。');
  }
  if (previous.version !== next.version || !Array.isArray(previous.skills) || previous.skills.length !== next.skills.length) fail('CHANGED', '已选专家包资源已变化，请重新选择专家。');
  for (let index = 0; index < next.skills.length; index++) {
    for (const key of ['filePath', 'sha256']) if (previous.skills[index]?.[key] !== next.skills[index][key]) fail('CHANGED', '已选专家包技能已变化，请重新选择专家。');
  }
}

/** Resolves only an explicit selection's installed instruction assets. No network, installation or execution. */
export async function resolveInstalledExpert(selection, { configDir, signal, limits = {} } = {}) {
  if (configDir === undefined || configDir === null) return null;
  active(signal);
  if (!object(selection)) fail('INVALID', '专家选择无效。');
  const bounded = limitsOf(limits), reads = [], absent = [];
  let readBytes = 0;
  const load = async (filename, maximum) => {
    active(signal);
    const remaining = bounded.totalBytes - readBytes;
    if (remaining < 1) fail('LIMIT', '专家包资源超过总读取限制。');
    const loaded = await readFile(filename, Math.min(maximum, remaining), signal, reads);
    readBytes += loaded.bytes; return loaded;
  };
  try {
    const config = absolute(configDir), id = label(selection.id), locale = String(selection.locale ?? 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh';
    if (!await optionalDirectory(config, signal)) {
      if (selection.package !== undefined) fail('CHANGED', '已选专家包配置目录已移除。');
      return null;
    }
    const source = selection.source === undefined ? undefined : label(selection.source);
    if (source !== undefined && !['builtin', 'enterprise', 'custom'].includes(source)) fail('IDENTITY', '专家来源身份无效。');
    const marketId = selection.marketExpertId === undefined ? undefined : label(selection.marketExpertId);
    if (marketId && !/^ex_[A-Za-z0-9-]+$/.test(marketId)) fail('IDENTITY', '专家市场标识无效。');
    const marketplaces = path.join(config, 'plugins', 'marketplaces');
    let local = selection.localPath ?? selection.expertRootDir;
    if (selection.localPath && selection.expertRootDir && selection.localPath !== selection.expertRootDir) fail('IDENTITY', '专家本地身份不一致。');
    let market = selection.marketplace === undefined ? undefined : component(selection.marketplace), directoryName;
    if (local !== undefined) {
      local = absolute(local);
      const relative = path.relative(marketplaces, local).split(path.sep);
      if (relative.length !== 3 || relative[1] !== 'plugins' || relative.some(p => !p || p === '..' || p === '.')) fail('UNSAFE', '所选专家路径不在已安装专家市场目录内。');
      const localMarket = component(relative[0]); directoryName = component(relative[2]);
      if (market && market !== localMarket) fail('IDENTITY', '专家市场和本地目录身份不一致。');
      market = localMarket;
    }
    market ??= source === 'custom' ? 'my-experts' : 'experts';
    if (source === 'custom' && market !== 'my-experts') fail('IDENTITY', '本地自定义专家不能使用官方市场身份。');
    const plugins = selection.pluginName === undefined ? undefined : component(selection.pluginName);
    let mapped;
    if (market === 'experts') {
      const mappingFile = path.join(config, 'app', 'cache', 'experts', 'expert-bundle-map.json');
      try {
        const loaded = await load(mappingFile, bounded.manifestBytes);
        let mapping; try { mapping = JSON.parse(loaded.text); } catch { fail('INVALID', '已安装专家映射无效。'); }
        if (!object(mapping)) fail('INVALID', '已安装专家映射无效。');
        const candidates = [marketId, id].filter(Boolean).filter(key => Object.hasOwn(mapping, key)).map(key => component(mapping[key]));
        if (new Set(candidates).size > 1) fail('IDENTITY', '专家标识对应不同的本地包，请重新选择。');
        mapped = candidates[0];
      } catch (error) { if (error.code === 'ENOENT') absent.push(mappingFile); else throw error; }
    }
    const candidates = [directoryName, plugins, mapped].filter(Boolean);
    if (new Set(candidates).size > 1) fail('IDENTITY', '专家插件和目录身份不一致。');
    const bundle = candidates[0];
    if (!bundle) {
      if (selection.package !== undefined) fail('CHANGED', '已选专家包身份已变化。');
      return null;
    }
    const root = path.join(marketplaces, market, 'plugins', bundle);
    if (local && root !== local) fail('IDENTITY', '专家包路径不一致。');
    if (!await optionalDirectory(root, signal)) {
      if (selection.package !== undefined) fail('CHANGED', '已选专家包已移除，请重新选择。');
      return null;
    }
    const manifestPath = path.join(root, '.codebuddy-plugin', 'plugin.json');
    let loadedManifest;
    try { loadedManifest = await load(manifestPath, bounded.manifestBytes); }
    catch (error) {
      if (error.code === 'ENOENT') {
        if (selection.package !== undefined) fail('CHANGED', '已选专家包manifest已移除。');
        return null;
      }
      throw error;
    }
    let manifest; try { manifest = JSON.parse(loadedManifest.text); } catch { fail('INVALID', '专家包manifest不是有效JSON。'); }
    if (!object(manifest) || component(manifest.name) !== bundle) fail('IDENTITY', '专家包manifest名称不匹配。');
    if (hasDeclaration(manifest.hooks) || hasDeclaration(manifest.mcpServers) || hasDeclaration(manifest.mcp)
      || hasDeclaration(manifest.extensions) || manifest.expertType && !['agent', 'prompt'].includes(manifest.expertType)) fail('UNSUPPORTED', '专家包包含尚未映射的MCP、Hook或编排配置。');
    if (!Array.isArray(manifest.agents) || !manifest.agents.length) {
      if (manifest.expertType === 'prompt' && selection.package === undefined) return null;
      fail('UNSUPPORTED', '专家包没有可唯一解析的agent声明。');
    }
    if (manifest.agents.length > bounded.agents) fail('LIMIT', '专家包agent声明超出限制。');
    const agentFiles = [...new Set(manifest.agents.map(value => relativeFile(root, value)))];
    if (agentFiles.some(f => path.extname(f).toLowerCase() !== '.md')) fail('UNSUPPORTED', '专家包agent必须是已声明的Markdown文件。');
    const wanted = selection.agentName === undefined ? manifest.agentName === undefined ? undefined : label(manifest.agentName) : label(selection.agentName);
    const agents = [];
    for (const filename of agentFiles) {
      const loaded = await load(filename, bounded.expertBytes), parsed = markdown(loaded.text);
      agents.push({ loaded, parsed, name: parsed.fields.name ? label(parsed.fields.name) : path.basename(filename, path.extname(filename)) });
    }
    const matching = wanted ? agents.filter(a => a.name === wanted || path.basename(a.loaded.filename, path.extname(a.loaded.filename)) === wanted) : agents;
    if (matching.length !== 1) fail('IDENTITY', '专家包agent选择有歧义或与已选身份不匹配。');
    const chosen = matching[0], skills = [];
    // Only the selected agent's frontmatter becomes active instructions.
    chosen.parsed = markdown(chosen.loaded.text, true);
    if (manifest.skills !== undefined && (!Array.isArray(manifest.skills) || manifest.skills.length > bounded.skills)) fail('LIMIT', '专家包技能声明超出限制。');
    const skillFiles = [...new Set((manifest.skills ?? []).map(value => {
      const declared = relativeFile(root, value);
      if (path.extname(declared).toLowerCase() === '.md' && path.basename(declared) !== 'SKILL.md') fail('UNSUPPORTED', '专家包技能必须指向声明目录中的SKILL.md。');
      return path.basename(declared) === 'SKILL.md' ? declared : path.join(declared, 'SKILL.md');
    }))];
    for (const filename of skillFiles) {
      const loaded = await load(filename, bounded.skillBytes), parsed = markdown(loaded.text);
      const skillName = parsed.fields.name ? label(parsed.fields.name) : path.basename(path.dirname(filename));
      const description = shortDescription(parsed.fields.description);
      const requirements = Object.keys(parsed.fields).filter(key => SKILL_REQUIREMENTS.has(key));
      skills.push({ id: path.relative(root, path.dirname(filename)).split(path.sep).join('/'), name: skillName,
        ...(description ? { description } : {}), filePath: filename, rootDir: path.dirname(filename), size: loaded.bytes, sha256: loaded.sha256,
        catalogOnly: true, ...(requirements.length ? { requirements } : {}) });
    }
    const version = manifest.version === undefined ? undefined : label(manifest.version);
    const packageInfo = { version, root, manifestPath, manifestSha256: loadedManifest.sha256,
      agentPath: chosen.loaded.filename, agentSha256: chosen.loaded.sha256, skills };
    expectedUnchanged(selection.package, packageInfo);
    for (const loaded of reads) {
      active(signal); const current = await fs.lstat(loaded.filename, { bigint: true });
      if (!same(current, loaded.stat) || current.isSymbolicLink() || current.nlink !== 1n || await fs.realpath(loaded.filename) !== loaded.filename) fail('CHANGED', '专家包在读取期间发生变化。');
      await checkChain(loaded.chain, signal);
    }
    for (const filename of absent) { try { await fs.lstat(filename); fail('CHANGED', '专家包映射在读取时发生变化。'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    const result = { id, name: localized(selection.name, locale) ?? localized(selection.displayName, locale)
      ?? localized(manifest.displayName, locale) ?? chosen.name, prompt: chosen.parsed.body, locale,
      marketplace: market, pluginName: bundle, agentName: wanted ?? chosen.name, localPath: root, expertRootDir: root,
      ...(version === undefined ? {} : { version }), package: packageInfo };
    for (const key of IDENTITY_FIELDS) if (selection[key] !== undefined) {
      const normalized = label(selection[key], key === 'runtimeIdentity' ? 4096 : 1024);
      result[key] = key === 'runtimeIdentity' ? selection[key] : normalized;
    }
    return result;
  } catch (error) {
    if (error.code?.startsWith('PI_')) throw error;
    if (signal?.aborted) active(signal);
    fail('UNAVAILABLE', '无法安全读取已安装专家包，请检查安装状态后重新选择。');
  }
}
