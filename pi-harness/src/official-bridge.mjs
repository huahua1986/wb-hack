import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { THINKING_LEVELS, thinkingLevelMapForModel } from './turn-settings.mjs';

export const OFFICIAL_PROVIDER = 'workbuddy-official';
export const OFFICIAL_READY = 'workbuddy-official-provider-ready-v1';

function failure(code, message) { return Object.assign(new Error(message), { code }); }
const unavailable = () => failure('OFFICIAL_BRIDGE_UNAVAILABLE', '官方模型连接尚未就绪，请确认已登录 WorkBuddy 后重试。');

export function readOfficialLocator(directory, { now = Date.now() } = {}) {
  try {
    if (!isAbsolute(directory)) throw unavailable();
    const dir = lstatSync(directory), file = lstatSync(join(directory, 'locator.json'));
    const uid = process.getuid?.();
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077)
      || !file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) || file.size > 16_384
      || (uid !== undefined && (file.uid !== uid || dir.uid !== uid))) throw unavailable();
    const value = JSON.parse(readFileSync(join(directory, 'locator.json'), 'utf8'));
    const expiresAt = typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : value.expiresAt;
    if (value.version !== 1 || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535
      || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.ticket !== 'string'
      || value.ticket.length < 16 || value.ticket.length > 1024 || /[\x00-\x20\x7f]/.test(value.ticket)
      || !Number.isFinite(expiresAt) || expiresAt <= now) throw unavailable();
    return { port: value.port, ticket: value.ticket, expiresAt };
  } catch { throw unavailable(); }
}

export function normalizeOfficialCatalog(value) {
  if (!Array.isArray(value?.data) || value.data.length > 1_000) throw failure('OFFICIAL_CATALOG_INVALID', '官方模型目录格式无效。');
  const ids = new Set();
  const models = value.data.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 256
      || /[\x00-\x1f\x7f]/.test(item.id) || ids.has(item.id)
      || !['openai-completions', 'openai-responses'].includes(item.api)) {
      throw failure('OFFICIAL_CATALOG_INVALID', '官方模型目录包含不受支持的模型。');
    }
    ids.add(item.id);
    const result = {
      id: item.id, name: typeof item.name === 'string' && item.name.trim() ? item.name.slice(0, 256) : item.id,
      provider: OFFICIAL_PROVIDER, api: item.api, reasoning: item.reasoning === true,
      input: Array.isArray(item.input) && item.input.includes('image') ? ['text', 'image'] : ['text'],
      contextWindow: Number.isSafeInteger(item.contextWindow) && item.contextWindow > 0 ? item.contextWindow : 32_768,
      maxTokens: Number.isSafeInteger(item.maxTokens) && item.maxTokens > 0 ? item.maxTokens : 4_096,
      supportsToolCall: item.supportsToolCall !== false,
      disabled: item.disabled === true,
      pricingKnown: false,
    };
    result.maxInputTokens = Number.isSafeInteger(item.maxInputTokens) && item.maxInputTokens > 0
      ? Math.min(item.maxInputTokens, 20_000_000) : result.contextWindow;
    result.supportedContextWindows = Array.from(new Set(Array.isArray(item.supportedContextWindows)
      ? item.supportedContextWindows : [result.contextWindow]))
      .filter(value => Number.isSafeInteger(value) && value > 1 && value <= result.maxInputTokens).sort((a, b) => a - b);
    if (!result.supportedContextWindows.length) result.supportedContextWindows = [result.contextWindow];
    if (result.disabled) result.disabledReason = typeof item.disabledReason === 'string'
      ? item.disabledReason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512) : '当前账号无权使用此模型。';
    if (item.cost && ['input', 'output', 'cacheRead', 'cacheWrite'].every(key => Number.isFinite(item.cost[key]) && item.cost[key] >= 0)) {
      result.cost = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(key => [key, item.cost[key]]));
      result.pricingKnown = true;
    }
    if (item.capabilities && typeof item.capabilities === 'object' && !Array.isArray(item.capabilities)) {
      const caps = item.capabilities, reasoning = caps.reasoning;
      result.capabilities = { onlyReasoning: caps.onlyReasoning === true, useCustomProtocol: caps.useCustomProtocol === true };
      if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
        const details = {};
        for (const key of ['defaultEffort', 'effort']) if (THINKING_LEVELS.includes(reasoning[key]) && reasoning[key] !== 'off') details[key] = reasoning[key];
        if (Array.isArray(reasoning.supportedEfforts)) details.supportedEfforts = [...new Set(reasoning.supportedEfforts)].filter(level => THINKING_LEVELS.includes(level) && level !== 'off');
        if (typeof reasoning.canDisableThinking === 'boolean') details.canDisableThinking = reasoning.canDisableThinking;
        if (['auto', 'concise', 'detailed'].includes(reasoning.summary)) details.summary = reasoning.summary;
        result.capabilities.reasoning = details;
      }
    }
    if (result.reasoning) result.thinkingLevelMap = thinkingLevelMapForModel(result);
    return result;
  });
  if (!models.length) throw failure('OFFICIAL_CATALOG_EMPTY', '当前账号没有可用的官方模型，请检查登录或模型权益。');
  return models;
}

/** Each Pi child gets its own validated selection; other threads keep their own models. */
export function applyOfficialContextWindows(models, selections = {}) {
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)
    || Object.keys(selections).length > 128 || Object.values(selections).some(value => !Number.isSafeInteger(value) || value <= 1)) {
    throw failure('OFFICIAL_CONTEXT_WINDOW_INVALID', '会话上下文配置无效。');
  }
  return models.map(model => {
    if (!Object.hasOwn(selections, model.id)) return model;
    const contextWindow = selections[model.id];
    if (!(model.supportedContextWindows ?? [model.contextWindow]).includes(contextWindow)) {
      throw failure('OFFICIAL_CONTEXT_WINDOW_INVALID', '该模型不支持所选上下文长度。');
    }
    return { ...model, contextWindow, maxTokens: Math.min(model.maxTokens, contextWindow - 1) };
  });
}

/** Loopback-only fetch. The local ticket is read per request and never persisted by Pi. */
export function readOfficialRequestContext(filename) {
  try {
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 4_096
      || (process.getuid && stat.uid !== process.getuid())) throw unavailable();
    const value = JSON.parse(readFileSync(filename, 'utf8'));
    if (!/^pi-thread-[a-f0-9-]{36}$/.test(value.threadId) || !/^pi-turn-[a-f0-9-]{36}$/.test(value.turnId)) throw unavailable();
    return { threadId: value.threadId, turnId: value.turnId };
  } catch { throw failure('OFFICIAL_CONTEXT_INVALID', '官方模型请求上下文无效，本次请求未发送。'); }
}

export function createOfficialFetch(directory, { fetchImpl = globalThis.fetch, timeoutMs = 10_000, requestContextFile } = {}) {
  return async function officialFetch(input, init = {}) {
    const template = new Request(input, init);
    const target = new URL(template.url);
    if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
      || !['/v1/models', '/v1/chat/completions', '/v1/responses'].includes(target.pathname)
      || target.username || target.password || target.hash) {
      throw failure('OFFICIAL_ENDPOINT_REJECTED', '官方模型桥仅允许访问受控的本机接口。');
    }
    const body = ['GET', 'HEAD'].includes(template.method) ? undefined : await template.arrayBuffer();
    if (body?.byteLength > 64 * 1024 * 1024) throw failure('OFFICIAL_REQUEST_TOO_LARGE', '官方模型请求超过本机桥的大小限制。');
    const signal = AbortSignal.any([template.signal, AbortSignal.timeout(timeoutMs)]);
    const context = requestContextFile && target.pathname !== '/v1/models'
      ? readOfficialRequestContext(requestContextFile) : null;
    let locator = readOfficialLocator(directory);
    const send = location => {
      const headers = new Headers(template.headers);
      headers.set('authorization', `Bearer ${location.ticket}`);
      if (context) {
        headers.set('x-workbuddy-pi-thread-id', context.threadId);
        headers.set('x-workbuddy-pi-turn-id', context.turnId);
      }
      return fetchImpl(`http://127.0.0.1:${location.port}${target.pathname}${target.search}`, {
        method: template.method, headers, body, signal, redirect: 'error',
      });
    };
    try {
      let response = await send(locator);
      if (response.status === 401) {
        const rotated = readOfficialLocator(directory);
        if (rotated.ticket !== locator.ticket || rotated.port !== locator.port) {
          await response.body?.cancel();
          locator = rotated;
          response = await send(locator);
        }
      }
      return response;
    } catch (cause) {
      if (template.signal.aborted) throw failure('OFFICIAL_REQUEST_ABORTED', '官方模型请求已取消。');
      throw unavailable();
    }
  };
}

export class OfficialBridgeClient {
  constructor(directory, { fetchImpl, timeoutMs = 8_000, requestContextFile } = {}) {
    this.directory = directory;
    this.fetch = createOfficialFetch(directory, { fetchImpl, timeoutMs: 600_000, requestContextFile });
    this.catalogFetch = createOfficialFetch(directory, { fetchImpl, timeoutMs });
  }
  async models({ waitMs = 6_000, signal } = {}) {
    const deadline = Date.now() + Math.min(8_000, Math.max(0, waitMs));
    while (true) {
      try {
        const locator = readOfficialLocator(this.directory);
        const response = await this.catalogFetch(`http://127.0.0.1:${locator.port}/v1/models`, { signal });
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          throw failure(response.status === 403 ? 'OFFICIAL_MODEL_FORBIDDEN' : 'OFFICIAL_AUTH_REQUIRED',
            response.status === 403 ? '当前账号无权使用官方模型，请检查模型权益。' : '官方模型授权不可用，请在 WorkBuddy 重新登录。');
        }
        if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
        const text = await response.text();
        if (text.length > 2 * 1024 * 1024) throw failure('OFFICIAL_CATALOG_INVALID', '官方模型目录超过安全大小限制。');
        let parsed;
        try { parsed = JSON.parse(text); } catch { throw failure('OFFICIAL_CATALOG_INVALID', '官方模型目录格式无效。'); }
        return normalizeOfficialCatalog(parsed);
      } catch (cause) {
        if (signal?.aborted) throw failure('OFFICIAL_REQUEST_ABORTED', '官方模型目录加载已取消。');
        if (cause.code !== 'OFFICIAL_BRIDGE_UNAVAILABLE' || Date.now() >= deadline) throw cause;
        await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now()))));
      }
    }
  }
}
