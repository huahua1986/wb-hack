import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const DEFAULT_COMPACT_PERCENT = 80;
export const TURN_SETTINGS_ENV = 'WORKBUDDY_PI_TURN_SETTINGS';
export const TURN_SETTINGS_READY = 'workbuddy-turn-settings-ready-v1';
export class TurnSettingsError extends Error {
  constructor(code, message) { super(message); this.name = 'TurnSettingsError'; this.code = code; }
}
const fail = (code, message) => { throw new TurnSettingsError(code, message); };
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** Model metadata, not the existence of a native menu, decides which levels are valid. */
export function thinkingOptionsForModel(model = {}) {
  if (model.reasoning !== true) return { levels: ['off'], defaultLevel: 'off', canDisableThinking: true };
  const caps = record(model.capabilities), details = record(caps.reasoning);
  const declared = Array.isArray(details.supportedEfforts)
    ? [...new Set(details.supportedEfforts)].filter(level => THINKING_LEVELS.includes(level) && level !== 'off') : [];
  const fixed = [details.defaultEffort, details.effort].find(level => THINKING_LEVELS.includes(level) && level !== 'off');
  const levels = declared.length ? declared : fixed ? [fixed] : ['minimal', 'low', 'medium', 'high'];
  // An explicit canDisableThinking declaration takes precedence over onlyReasoning,
  // as in the native GLM catalogue: onlyReasoning=true but disabling is supported.
  const canDisableThinking = typeof details.canDisableThinking === 'boolean'
    ? details.canDisableThinking : caps.onlyReasoning !== true;
  const available = THINKING_LEVELS.filter(level => level === 'off' ? canDisableThinking : levels.includes(level));
  const defaultLevel = fixed && available.includes(fixed) ? fixed : available.includes('medium') ? 'medium'
    : available.find(level => level !== 'off') ?? 'off';
  return { levels: available, defaultLevel, canDisableThinking };
}

export function normalizeThoughtLevel(value, model) {
  if (value === 'enabled' && model?.reasoning !== true) fail('PI_THINKING_UNSUPPORTED', '当前模型不支持启用推理。');
  const options = thinkingOptionsForModel(model);
  const level = value === undefined || value === null || value === '' || value === 'enabled' ? options.defaultLevel
    : value === 'disabled' ? 'off' : value;
  if (typeof level !== 'string' || !THINKING_LEVELS.includes(level)) fail('PI_THINKING_INVALID', '推理档位无效。');
  if (!options.levels.includes(level)) fail('PI_THINKING_UNSUPPORTED', `当前模型不支持该推理档位；可用档位：${options.levels.join('、')}。`);
  return level;
}

/** Empty restores the native default; zero explicitly disables proactive auto compaction. */
export function normalizePreMessageCompactPct(value) {
  if (value === undefined || value === null || value === '') return null;
  if ((typeof value !== 'number' && typeof value !== 'string') || typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) {
    fail('PI_COMPACTION_INVALID', '压缩阈值必须是0到100的百分比，空值恢复默认。');
  }
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) fail('PI_COMPACTION_INVALID', '压缩阈值必须是0到100的百分比。');
  return percent;
}

export function normalizeTurnSettings(settings = {}, model = {}, { contextWindow = model.contextWindow } = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) fail('PI_SETTINGS_INVALID', '会话执行设置无效。');
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 2 || contextWindow > 20_000_000) fail('PI_SETTINGS_INVALID', '当前模型上下文窗口无效。');
  const percent = normalizePreMessageCompactPct(settings.preMessageCompactPct);
  const effectivePercent = percent ?? DEFAULT_COMPACT_PERCENT;
  const thresholdTokens = Math.max(1, Math.floor(contextWindow * effectivePercent / 100));
  return {
    thinkingLevel: normalizeThoughtLevel(settings.thoughtLevel ?? settings.thinkingLevel, model),
    preMessageCompactPct: percent,
    effectiveCompactPercent: effectivePercent,
    // Pi's automatic-compaction switch also gates overflow recovery. Keep it
    // enabled; the controlled extension cancels only threshold work for native 0%.
    autoCompaction: true,
    preMessageCompaction: effectivePercent !== 0,
    contextWindow,
    // Pi's exact trigger is contextTokens > contextWindow - reserveTokens.
    // reserveTokens is not a second output budget and must not be added to maxTokens.
    reserveTokens: effectivePercent === 0 ? 0 : contextWindow - thresholdTokens,
    keepRecentTokens: Math.max(1, Math.min(20_000, Math.floor((effectivePercent === 0 ? contextWindow * 0.8 : thresholdTokens) / 2))),
  };
}

/** Null entries prevent Pi from silently exposing/clamping an unsupported native level. */
export function thinkingLevelMapForModel(model) {
  const { levels } = thinkingOptionsForModel(model);
  return Object.fromEntries(THINKING_LEVELS.map(level => [level, levels.includes(level) ? level : null]));
}

export function buildRuntimeSettings({ baseSettings = {}, settings = {}, model, contextWindow } = {}) {
  if (!model || typeof model.id !== 'string' || !model.id || typeof model.provider !== 'string' || !model.provider) fail('PI_SETTINGS_INVALID', '会话模型身份无效。');
  const effective = normalizeTurnSettings(settings, model, { contextWindow });
  // Copy ordinary preferences only. Runtime auth, extensions, project hooks and
  // third-party MCP configuration are intentionally supplied through existing bridges.
  const source = record(baseSettings), result = {};
  for (const field of ['theme', 'transport', 'hideThinkingBlock', 'showImages', 'showCacheMissNotices', 'retry']) {
    if (source[field] !== undefined) result[field] = structuredClone(source[field]);
  }
  result.defaultProvider = model.provider; result.defaultModel = model.id; result.defaultThinkingLevel = effective.thinkingLevel;
  result.compaction = {
    enabled: effective.autoCompaction, reserveTokens: effective.reserveTokens, keepRecentTokens: effective.keepRecentTokens,
    modelOverrides: { [`${model.provider}/${model.id}`]: { reserveTokens: effective.reserveTokens, keepRecentTokens: effective.keepRecentTokens } },
  };
  return { effective, settings: result };
}

function privateDirectory(filename) {
  try { mkdirSync(filename, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(filename), uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || uid !== undefined && stat.uid !== uid) fail('PI_SETTINGS_PATH_INVALID', '会话设置目录无效。');
}
function atomicJson(filename, value) {
  try { const stat = lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink()) fail('PI_SETTINGS_PATH_INVALID', '会话设置文件无效。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, filename);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** A separate agent dir per thread keeps one conversation's thresholds out of every other Pi process. */
export function ensureTurnRuntime({ stateDir, threadId, ...options } = {}) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir) || !/^pi-thread-[a-f0-9-]{36}$/.test(threadId ?? '')) fail('PI_SETTINGS_PATH_INVALID', '会话设置目录身份无效。');
  const root = realpathSync(stateDir); privateDirectory(root);
  const runtimes = join(root, 'runtimes'); privateDirectory(runtimes);
  const agentDir = join(runtimes, threadId); privateDirectory(agentDir);
  const runtime = buildRuntimeSettings(options);
  atomicJson(join(agentDir, 'settings.json'), runtime.settings);
  // Official provider definitions and authentication come from the explicit extension.
  atomicJson(join(agentDir, 'models.json'), { providers: {} });
  return { agentDir, settingsFile: join(agentDir, 'settings.json'), effective: runtime.effective,
    extensionValue: JSON.stringify({ version: 1, provider: options.model.provider, modelId: options.model.id, ...runtime.effective }) };
}

export function parseTurnSettingsEnvironment(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4096) fail('PI_SETTINGS_INVALID', '会话设置上下文不可用。');
  let result; try { result = JSON.parse(value); } catch { fail('PI_SETTINGS_INVALID', '会话设置上下文无效。'); }
  if (!result || result.version !== 1 || typeof result.provider !== 'string' || typeof result.modelId !== 'string'
    || !THINKING_LEVELS.includes(result.thinkingLevel) || result.autoCompaction !== true || typeof result.preMessageCompaction !== 'boolean'
    || !Number.isSafeInteger(result.contextWindow) || result.contextWindow < 2
    || !Number.isSafeInteger(result.reserveTokens) || result.reserveTokens < 0 || result.reserveTokens >= result.contextWindow
    || !Number.isSafeInteger(result.keepRecentTokens) || result.keepRecentTokens < 1 || result.keepRecentTokens > result.contextWindow
    || normalizePreMessageCompactPct(result.preMessageCompactPct) !== result.preMessageCompactPct
    || result.preMessageCompaction !== (result.preMessageCompactPct !== 0)
    || result.preMessageCompactPct === 0 && result.reserveTokens !== 0) fail('PI_SETTINGS_INVALID', '会话设置上下文无效。');
  return result;
}
