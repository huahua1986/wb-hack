import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PiRpcClient } from './pi-rpc.mjs';
import { OfficialBridgeClient, OFFICIAL_PROVIDER, OFFICIAL_READY } from './official-bridge.mjs';
import { prepareTurnInput } from './turn-input.mjs';
import { describeNativeInput } from './native-input-resources.mjs';
import { resolveNativeContext } from './native-context.mjs';
import { resolveInstalledExpert } from './expert-package.mjs';
import { normalizeNativeTools, validateConnectorSelection } from './native-tools.mjs';
import { NATIVE_READY, NATIVE_CALL, NATIVE_TITLE } from './native-feature-extension.mjs';
import { projectContextUsage } from './context-usage.mjs';
import { allocateTaskWorkspace } from './task-workspace.mjs';
import { FileJournal } from './file-journal.mjs';
import { SessionCheckpoints } from './session-checkpoints.mjs';
import { nativeArtifacts, nativeFileTree, nativeManifest, nativeDiffResources } from './file-resources.mjs';
import { normalizeTurnSettings, normalizeThoughtLevel, normalizePreMessageCompactPct, ensureTurnRuntime,
  TURN_SETTINGS_ENV, TURN_SETTINGS_READY } from './turn-settings.mjs';

const ACTIVE = new Set(['running', 'waiting_for_approval']);
const STATE_VERSION = 1;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const ID = /^pi-thread-[a-f0-9-]{36}$/;
const TOOLS = new Set(['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']);
const MUTATING_TOOLS = new Set(['edit', 'write', 'bash']);
const APPROVAL_PROTOCOL = 'workbuddy-host-approval-v1';
const APPROVAL_READY = 'workbuddy-host-approval-ready-v1';
const APPROVAL_TITLE = 'WorkBuddy Pi 操作确认';
const APPROVAL_EXTENSION_SHA256 = '53c785dbcba7a0d2607c3de43de3122a8eb4f68808c4dfffac5ce11089a48cbd';
const NATIVE_EXTENSION_SHA256 = 'afc437d6abc5afca6659b96dae29f54b97a76c74b7dd9067a3728dca31ca999e';
const OFFICIAL_FILES = {
  'official-provider-extension.mjs': '3fdfd2e782c0f0da9b9c6d03df6e668153f28a94dd1338a4a9f5895b340f1252',
  'official-provider-extension.ts': 'e79b657c9fcbabfa576889b5aa3b4adce435b49c383288d26a0fdf26b069bebd',
  'official-bridge.mjs': '3f0175e24b28dc2c6e066c5bf8d5cf577dfbe9d36caa2b57c8a960e70d79abae',
};
const SETTINGS_FILES = {
  'turn-settings.mjs': 'dd7da19887f58244576f370f4def373a9205a71f4dc1345b60970ec1caa0a54d',
  'turn-settings-extension.mjs': '3235fb2fc566ca2380eb3ac870ea1aafad9072435c08bb00096c58416b85b4a9',
};
const TRUNCATED_RESPONSE = Object.freeze({ code: 'PI_RESPONSE_TRUNCATED', stopReason: 'length',
  message: '模型因长度限制停止，未完成最终回答。已有内容和工具结果已保留；可继续要求基于已有结果总结，无需重跑已执行的操作。' });

function fileUpdatePayload(changes = []) {
  const paths = [], files = []; let bytes = 0, invalidateAll = false;
  for (const filename of new Set(changes.map(c => c.path).filter(p => typeof p === 'string' && isAbsolute(p) && !/[\x00-\x1f\x7f]/.test(p)))) {
    let size = null;
    try { const stat = lstatSync(filename); if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && Number.isSafeInteger(stat.size)) size = stat.size; } catch { /* Missing/unknown files cannot become preview read arguments. */ }
    const file = { path: filename, size };
    bytes += Buffer.byteLength(JSON.stringify([filename, file]));
    if (bytes > 48 * 1024) { invalidateAll = true; break; }
    paths.push(filename); files.push(file);
  }
  return { paths, files, ...(invalidateAll ? { invalidateAll: true } : {}) };
}

function appendOutcomeDiagnostic(turn) {
  if (!['PI_RESPONSE_TRUNCATED', 'PI_EMPTY_RESPONSE'].includes(turn.error?.code)) return null;
  const id = `${turn.id}-host-diagnostic`;
  if (turn.items.some(item => item.id === id)) return null;
  const item = { id, type: 'text', role: 'assistant', origin: 'host-diagnostic',
    text: `系统提示：${turn.error.message}`, status: 'failed' };
  turn.items.push(item);
  return item;
}

function legacyTruncatedOutcome(filename, turn) {
  if (turn?.status !== 'completed' || turn.stopReason !== 'end_turn') return false;
  let fd;
  try {
    fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return false;
    const size = Math.min(stat.size, 1024 * 1024), start = stat.size - size, buffer = Buffer.alloc(size);
    if (readSync(fd, buffer, 0, size, start) !== size) return false;
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return false;
    const lines = buffer.toString('utf8').split('\n');
    if (start) lines.shift();
    for (const line of lines.reverse()) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.type !== 'message' || row.message?.role !== 'assistant') continue;
      const at = Date.parse(row.timestamp), from = Date.parse(turn.createdAt), to = Date.parse(turn.completedAt);
      return row.message.stopReason === 'length' && Number.isFinite(at) && at >= from && at <= to;
    }
  } catch { /* A missing or incomplete old session must not prevent startup. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return false;
}
const OFFICIAL_ERROR_CODES = new Set([
  'LOCAL_CLIENT_REQUIRED', 'INVALID_BRIDGE_TICKET', 'WORKBUDDY_LOGIN_REQUIRED', 'NOT_FOUND',
  'REQUEST_TOO_LARGE', 'INVALID_JSON', 'INVALID_BODY', 'BUILTIN_MODEL_REQUIRED', 'AICC_PERMISSION_REQUIRED',
  'MODEL_UNAVAILABLE', 'MODEL_API_MISMATCH', 'MODEL_INPUT_REQUIRED', 'OFFICIAL_SESSION_CHANGED',
  'CLIENT_CANCELED', 'UNTRUSTED_MODEL_ENDPOINT', 'OFFICIAL_REQUEST_REJECTED', 'OFFICIAL_STREAM_UNAVAILABLE',
  'OFFICIAL_BRIDGE_ERROR', 'OFFICIAL_STREAM_TRUNCATED', 'AICC_REQUEST_NOT_PROTECTED', 'AICC_RESPONSE_PLAINTEXT',
  'AICC_RESPONSE_INVALID_JSON', 'AICC_RESPONSE_DECRYPT_FAILED', 'AICC_STREAM_TRUNCATED', 'AICC_EVENT_TOO_LARGE',
  'AICC_CLOSED', 'OFFICIAL_AUTH_REQUIRED', 'OFFICIAL_MODEL_FORBIDDEN', 'OFFICIAL_BRIDGE_UNAVAILABLE',
  'MODEL_THINKING_INVALID', 'MODEL_THINKING_UNSUPPORTED',
]);

/** Classify only known bridge codes/statuses. Raw SDK errors never reach UI or persisted state. */
export function safeOfficialModelError(value) {
  const text = typeof value === 'string' ? value.slice(0, 8_192) : '';
  const explicitStatus = typeof value === 'object' && value !== null
    ? [value.status, value.statusCode, value.upstreamStatus].find(status => [401, 403, 429].includes(status))
    : undefined;
  const status = explicitStatus ?? Number(text.match(/^\s*(?:Error:\s*)?(?:HTTP(?:\/\d(?:\.\d)?)?\s+)?(401|403|429)(?=[\s:,-]|$)/i)?.[1]
    ?? text.match(/\b(?:status|statusCode|httpStatus|upstreamStatus)["']?\s*[:=]\s*["']?(401|403|429)\b/i)?.[1]);
  const suppliedCode = typeof value?.code === 'string' && OFFICIAL_ERROR_CODES.has(value.code) ? value.code : undefined;
  const code = suppliedCode ?? text.split(/[^A-Za-z0-9_]+/).find(part => OFFICIAL_ERROR_CODES.has(part));
  if (['MODEL_THINKING_INVALID', 'MODEL_THINKING_UNSUPPORTED'].includes(code)) return { code: 'PI_THINKING_UNSUPPORTED', message: '官方模型目录已变化或该模型不接受当前推理档位，请重新选择模型或档位。' };
  if (status === 401 || (!Number.isFinite(status) && ['INVALID_BRIDGE_TICKET', 'WORKBUDDY_LOGIN_REQUIRED', 'OFFICIAL_SESSION_CHANGED', 'OFFICIAL_AUTH_REQUIRED'].includes(code))) {
    return { code: 'OFFICIAL_AUTH_REQUIRED', message: '官方模型连接或登录状态已失效，请重新连接或登录 WorkBuddy 后重试。' };
  }
  if (status === 403 || (!Number.isFinite(status) && ['LOCAL_CLIENT_REQUIRED', 'BUILTIN_MODEL_REQUIRED', 'AICC_PERMISSION_REQUIRED', 'MODEL_UNAVAILABLE', 'UNTRUSTED_MODEL_ENDPOINT', 'OFFICIAL_MODEL_FORBIDDEN'].includes(code))) {
    return { code: 'OFFICIAL_MODEL_FORBIDDEN', message: '当前账号无权使用该官方模型，或模型已不可用。请切换模型或检查账号权益。' };
  }
  if (status === 429) return { code: 'OFFICIAL_RATE_LIMITED', message: '官方模型请求受到额度或频率限制，请检查账号额度并稍后重试。' };
  if (code === 'REQUEST_TOO_LARGE') return { code: 'OFFICIAL_REQUEST_TOO_LARGE', message: '官方模型请求过大，请减少输入或附件后重试。' };
  if (['MODEL_API_MISMATCH', 'MODEL_INPUT_REQUIRED', 'INVALID_JSON', 'INVALID_BODY'].includes(code)) {
    return { code: 'OFFICIAL_REQUEST_INVALID', message: '官方模型请求协议不兼容，本轮已停止。请重新选择模型后重试。' };
  }
  if (code === 'OFFICIAL_BRIDGE_UNAVAILABLE') return { code: 'OFFICIAL_BRIDGE_UNAVAILABLE', message: '官方模型连接尚未就绪，请确认 WorkBuddy 已连接后重试。' };
  if (code?.startsWith('AICC_') || ['OFFICIAL_STREAM_UNAVAILABLE', 'OFFICIAL_STREAM_TRUNCATED'].includes(code)) {
    return { code: 'OFFICIAL_STREAM_ERROR', message: '官方模型响应传输不完整或校验失败，本轮已停止。请稍后重试。' };
  }
  return { code: 'OFFICIAL_MODEL_ERROR', message: '官方模型请求失败，请检查 WorkBuddy 登录、模型权限和网络后重试。' };
}

function clone(value) { return structuredClone(value); }
function now() { return new Date().toISOString(); }
function error(code, message) { return Object.assign(new Error(message), { code }); }
function required(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw error('INVALID_PARAMS', `${name} must be a non-empty string`);
  }
  return value;
}
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
    throw error('INVALID_PARAMS', 'Pi state directory must be a real directory');
  }
  chmodSync(path, 0o700);
}
function realFileIfPresent(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw error('INVALID_PARAMS', 'Pi state files must be regular files');
    }
    return stat;
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw cause;
  }
}
function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
async function bounded(promise, milliseconds) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(() => true, () => false),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}
function textFrom(message) {
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('');
}

/** Private per-thread Pi RPC processes, exposing the normalized WorkBuddy Host contract. */
export class PiHarness {
  #threads = new Map();
  #clients = new Map();
  #runs = new Map();
  #listeners = new Set();
  #blockedThreads = new Set();
  #closingThreads = new Set();
  #pendingInteractions = new Map();
  #closed = false;
  #factory;
  #stateFile;
  #sessionDir;
  #cancelTimeoutMs;
  #requestTimeoutMs;
  #approvalExtension;
  #approvalTimeoutMs;
  #officialBridge;
  #officialCatalog = [];
  #officialRefresh;
  #officialRefreshedAt = 0;
  #officialExtension;
  #officialCatalogVersion = 0;
  #officialPollTimer;
  #nativeServices;
  #expertConfigDir;
  #preparing = new Set();
  #contextRefresh = new Map();
  #statsClients = new Map();
  #contextVersion = new Map();
  #fileJournal;
  #journalReady;
  #journalFailure;
  #sessionCheckpoints;
  #compactions = new Map();
  #rewinds = new Map();
  #fileScopes = new Map();

  constructor({ command, args = [], cwd, stateDir, agentDir, provider, model,
    modelName, env = {}, clientFactory, cancelTimeoutMs = 3_000,
    requestTimeoutMs = 30_000, tools = ['read'], approvalExtension,
    approvalTimeoutMs = 300_000, officialOnly = false, officialBridgeDir,
    officialBridgeClient, nativeServices, expertConfigDir, workspaceRoot, approvalMode = 'manual' } = {}) {
    this.id = 'pi';
    this.officialOnly = officialOnly === true;
    if (typeof officialOnly !== 'boolean') throw error('INVALID_PARAMS', 'officialOnly must be boolean');
    this.label = this.officialOnly ? 'Pi · 官方模型' : 'Pi · 本地模型';
    this.command = required(command, 'command');
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
      throw error('INVALID_PARAMS', 'args must be an array of strings');
    }
    this.args = [...args];
    this.cwd = resolve(required(cwd, 'cwd'));
    if (!['manual', 'auto'].includes(approvalMode)) throw error('INVALID_PARAMS', 'approvalMode must be manual or auto');
    this.defaultApprovalMode = approvalMode;
    if (workspaceRoot !== undefined) this.workspaceRoot = resolve(required(workspaceRoot, 'workspaceRoot'));
    this.stateDir = resolve(required(stateDir, 'stateDir'));
    this.agentDir = resolve(required(agentDir, 'agentDir'));
    this.provider = required(provider ?? (this.officialOnly ? OFFICIAL_PROVIDER : undefined), 'provider');
    this.model = required(model ?? (this.officialOnly ? 'hy4' : undefined), 'model');
    this.modelName = modelName === undefined ? this.model : required(modelName, 'modelName');
    this.#nativeServices = nativeServices;
    if (expertConfigDir !== undefined && (typeof expertConfigDir !== 'string' || !isAbsolute(expertConfigDir) || /[\x00-\x1f\x7f]/.test(expertConfigDir))) {
      throw error('INVALID_PARAMS', '专家配置根目录无效。');
    }
    this.#expertConfigDir = expertConfigDir;
    if (!Array.isArray(tools) || tools.length === 0 || tools.some(tool => !TOOLS.has(tool))
      || new Set(tools).size !== tools.length) {
      throw error('INVALID_PARAMS', 'tools must contain distinct supported Pi built-in tool names');
    }
    this.tools = [...tools];
    if (!Number.isSafeInteger(approvalTimeoutMs) || approvalTimeoutMs < 1_000 || approvalTimeoutMs > 3_600_000) {
      throw error('INVALID_PARAMS', 'approvalTimeoutMs must be between 1000 and 3600000');
    }
    this.#approvalTimeoutMs = approvalTimeoutMs;
    if (this.tools.some(tool => MUTATING_TOOLS.has(tool)) || nativeServices) {
      this.#approvalExtension = approvalExtension === undefined
        ? fileURLToPath(new URL('../package-dmg/approval-extension.mjs', import.meta.url))
        : required(approvalExtension, 'approvalExtension');
      if (!isAbsolute(this.#approvalExtension)) throw error('INVALID_PARAMS', 'approvalExtension must be absolute');
      this.#verifyApprovalExtension();
    } else if (approvalExtension !== undefined) {
      throw error('INVALID_PARAMS', 'approvalExtension requires mutating tools or native MCP services');
    }
    if (!env || typeof env !== 'object' || Array.isArray(env)
      || Object.values(env).some(value => typeof value !== 'string')) {
      throw error('INVALID_PARAMS', 'env must contain string values');
    }
    this.env = { ...env };
    if (this.officialOnly) {
      if (this.provider !== OFFICIAL_PROVIDER) throw error('INVALID_PARAMS', '官方模式禁止使用其它 Provider。');
      this.officialBridgeDir = resolve(required(officialBridgeDir, 'officialBridgeDir'));
      this.#officialBridge = officialBridgeClient ?? new OfficialBridgeClient(this.officialBridgeDir);
      this.#officialExtension = fileURLToPath(new URL('./official-provider-extension.ts', import.meta.url));
      this.#verifyOfficialExtension();
    } else if (officialBridgeDir !== undefined || this.provider === OFFICIAL_PROVIDER) {
      throw error('INVALID_PARAMS', '官方 Provider 必须使用 officialOnly 与独立桥目录。');
    }
    this.#factory = clientFactory ?? (options => new PiRpcClient(options));
    for (const [name, value] of Object.entries({ cancelTimeoutMs, requestTimeoutMs })) {
      if (!Number.isSafeInteger(value) || value < 1) throw error('INVALID_PARAMS', `${name} must be positive`);
    }
    this.#cancelTimeoutMs = cancelTimeoutMs;
    this.#requestTimeoutMs = requestTimeoutMs;
    privateDirectory(this.stateDir);
    privateDirectory(this.agentDir);
    this.#sessionDir = join(this.stateDir, 'sessions');
    privateDirectory(this.#sessionDir);
    this.#sessionCheckpoints = new SessionCheckpoints({ stateDir: this.stateDir });
    if (this.tools.some(tool => MUTATING_TOOLS.has(tool))) {
      const journalDir = join(this.stateDir, 'file-journal'); privateDirectory(journalDir);
      this.#fileJournal = new FileJournal({ stateDir: journalDir });
      this.#journalReady = this.#fileJournal.recoverInterruptedTurns().catch(cause => { this.#journalFailure = cause; });
    }
    this.#stateFile = join(this.stateDir, 'threads.json');
    this.#load();
    if (this.officialOnly) {
      this.#officialPollTimer = setInterval(() => {
        if (!this.#closed) void this.refreshOfficialModels({ waitMs: 0 }).catch(() => {});
      }, 5_000);
      this.#officialPollTimer.unref?.();
    }
  }

  describe() {
    return {
      id: this.id, label: this.label, kind: 'pi-rpc', available: !this.#closed,
      running: this.#clients.size > 0,
      capabilities: { streaming: true, tools: true, diff: Boolean(this.#fileJournal), approval: Boolean(this.#approvalExtension),
        cancel: true, models: true, persistence: true, attachments: true, experts: true, skills: true,
        nativeMcp: Boolean(this.#nativeServices) },
      approvalMode: this.defaultApprovalMode,
      ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
      toolPolicy: { enabledTools: [...this.tools], approvalRequired: this.defaultApprovalMode === 'auto' ? [] : this.tools.filter(tool => MUTATING_TOOLS.has(tool)) },
    };
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  listThreads() {
    if (this.officialOnly && !this.#closed && !this.#officialRefresh && Date.now() - this.#officialRefreshedAt > 5_000) {
      void this.refreshOfficialModels().catch(() => {});
    }
    return [...this.#threads.values()].map(thread => this.#publicThread(thread));
  }
  snapshot() { return { ...this.describe(), threads: this.listThreads() }; }

  async refreshOfficialModels({ force = false, waitMs = 6_000 } = {}) {
    if (!this.officialOnly) return [];
    this.#assertOpen();
    if (this.#officialRefresh) return this.#officialRefresh;
    if (!force && this.#officialCatalog.length && Date.now() - this.#officialRefreshedAt < 3_000) {
      return clone(this.#officialCatalog);
    }
    this.#officialRefresh = (async () => {
      const catalog = await this.#officialBridge.models({ waitMs });
      if (this.#closed) return [];
      const changed = JSON.stringify(catalog) !== JSON.stringify(this.#officialCatalog);
      this.#officialRefreshedAt = Date.now();
      if (changed) {
        const oldWindows = new Map([...this.#threads.values()].map(thread => [thread.id, this.#effectiveContextWindow(thread)]));
        this.#officialCatalog = clone(catalog);
        this.#officialCatalogVersion++;
        for (const thread of this.#threads.values()) {
          thread.models = this.#models(thread.models.requestedModelId ?? thread.models.currentModelId ?? this.model);
          if (oldWindows.get(thread.id) !== this.#effectiveContextWindow(thread)) {
            this.#contextVersion.set(thread.id, (this.#contextVersion.get(thread.id) ?? 0) + 1);
            thread.piContextUsage = projectContextUsage();
          }
          this.#publish('thread.updated', { threadId: thread.id, payload: { thread: this.#publicThread(thread) } });
        }
        this.#persist();
      }
      return clone(this.#officialCatalog);
    })().finally(() => { this.#officialRefresh = null; });
    return this.#officialRefresh;
  }

  async createThread(params = {}) {
    this.#assertOpen();
    if (this.officialOnly) await this.refreshOfficialModels();
    this.#assertOpen();
    if (params.mcpServers?.length) throw error('UNAVAILABLE', 'Pi 试验模式未启用 MCP 连接器。');
    if (params.workspaceAutoGenerated !== undefined && typeof params.workspaceAutoGenerated !== 'boolean') throw error('INVALID_PARAMS', 'workspaceAutoGenerated must be boolean');
    if (params.approvalMode !== undefined && !['manual', 'auto'].includes(params.approvalMode)) throw error('INVALID_PARAMS', 'approvalMode must be manual or auto');
    const title = params.title === undefined ? 'Pi 新任务' : required(params.title, 'title');
    const models = params.model === undefined ? this.#models() : this.#explicitModels(params.model);
    const defaultWorkspace = params.cwd === undefined || params.cwd === null || params.cwd === '';
    const id = `pi-thread-${randomUUID()}`;
    const timestamp = now();
    const workspace = this.workspaceRoot ? await allocateTaskWorkspace({ cwd: params.cwd, rootDir: this.workspaceRoot }) : null;
    const thread = {
      id, harnessId: this.id, nativeSessionId: id,
      title,
      cwd: workspace?.cwd ?? (defaultWorkspace ? this.cwd : resolve(required(params.cwd, 'cwd'))),
      workspaceAutoGenerated: params.workspaceAutoGenerated ?? defaultWorkspace,
      approvalMode: params.approvalMode ?? this.defaultApprovalMode,
      createdAt: timestamp, updatedAt: timestamp, status: 'idle', activeTurnId: null,
      provider: this.provider, models, contextWindows: {}, turns: [],
    };
    this.#threads.set(id, thread);
    this.#persist();
    this.#publish('thread.created', { threadId: id, payload: { thread: this.#publicThread(thread) } });
    return this.#publicThread(thread);
  }

  async renameThread({ threadId, title }) {
    this.#assertOpen();
    const thread = this.#thread(threadId), value = required(title, 'title').trim();
    if (value.length > 256) throw error('INVALID_PARAMS', 'Conversation title is too long');
    thread.title = value; thread.userDefinedTitle = true; thread.updatedAt = now();
    this.#persist();
    this.#publish('thread.updated', { threadId, payload: { thread: this.#publicThread(thread) } });
    return this.#publicThread(thread);
  }

  async setApprovalMode({ threadId, approvalMode }) {
    this.#assertOpen();
    if (!['manual', 'auto'].includes(approvalMode)) throw error('INVALID_PARAMS', '请选择自动执行或逐次确认。');
    const thread = this.#thread(threadId);
    if (thread.approvalMode !== approvalMode) {
      thread.approvalMode = approvalMode;
      this.#persist();
      this.#publish('thread.updated', { threadId, payload: { thread: this.#publicThread(thread) } });
    }
    if (approvalMode === 'auto') {
      for (const pending of [...this.#pendingInteractions.values()]) {
        if (thread.approvalMode !== 'auto') break;
        if (pending.thread !== thread || !this.#isRun(thread, pending.run) || pending.run.cancelling) continue;
        pending.interaction.authorizationSource = 'auto-mode-change';
        await this.respondInteraction({ interactionId: pending.interaction.id, response: 'allow-once' });
      }
    }
    return this.#publicThread(thread);
  }

  async setModel({ threadId, model }) {
    this.#assertOpen();
    const thread = this.#thread(threadId);
    if (thread.activeTurnId || this.#preparing.has(thread.id)) throw error('CONFLICT', '请等待当前操作结束后切换模型。');
    this.#preparing.add(thread.id);
    try {
    if (this.officialOnly) {
      await this.refreshOfficialModels();
      this.#assertOpen();
      const selected = this.#officialCatalog.find(candidate => candidate.id === model);
      if (!selected) throw error('INVALID_PARAMS', '该模型不在当前账号的官方目录中。');
      if (selected.disabled) throw error('OFFICIAL_MODEL_FORBIDDEN', '当前账号无权使用此官方模型。');
      const entry = this.#clients.get(thread.id);
      if (entry) {
        if (entry.catalogVersion !== this.#officialCatalogVersion) await this.#closeClient(thread.id);
        else await entry.client.setModel(OFFICIAL_PROVIDER, model, { timeoutMs: this.#requestTimeoutMs });
        await this.#closeClient(thread.id);
      }
      this.#assertOpen();
      thread.models = this.#models(model);
      this.#contextVersion.set(thread.id, (this.#contextVersion.get(thread.id) ?? 0) + 1);
      thread.piContextUsage = projectContextUsage();
      thread.updatedAt = now();
      this.#persist();
      this.#publish('thread.updated', { threadId, payload: { thread: this.#publicThread(thread) } });
    } else if (model !== this.model) throw error('INVALID_PARAMS', 'Pi 试验模式仅启用已配置的本地模型。');
    return this.#publicThread(thread);
    } finally { this.#preparing.delete(thread.id); }
  }

  async setContextWindow({ threadId, contextWindow = null }) {
    this.#assertOpen();
    const thread = this.#thread(threadId);
    if (!this.officialOnly) throw error('UNAVAILABLE', '当前执行器尚未提供可配置的上下文档位。');
    if (thread.activeTurnId || this.#preparing.has(thread.id)) throw error('CONFLICT', '请等待当前轮次结束后修改上下文长度。');
    this.#preparing.add(thread.id);
    try {
      await this.refreshOfficialModels();
      this.#assertOpen();
      const model = this.#officialCatalog.find(model => model.id === thread.models.currentModelId && !model.disabled);
      if (!model) throw error('OFFICIAL_MODEL_SELECTION_REQUIRED', '请先选择可用的官方模型。');
      if (contextWindow !== null && (!Number.isSafeInteger(contextWindow)
        || !(model.supportedContextWindows ?? [model.contextWindow]).includes(contextWindow))) {
        throw error('INVALID_PARAMS', '该模型不支持所选上下文长度。');
      }
      const previous = thread.contextWindows ?? {};
      if (contextWindow === null ? !Object.hasOwn(previous, model.id) : previous[model.id] === contextWindow) return this.#publicThread(thread);
      if (contextWindow !== null && !Object.hasOwn(previous, model.id) && Object.keys(previous).length >= 128) {
        throw error('INVALID_PARAMS', '该会话的模型上下文配置已达到上限。');
      }
      this.#contextVersion.set(thread.id, (this.#contextVersion.get(thread.id) ?? 0) + 1);
      await this.#statsClients.get(thread.id)?.close().catch(() => {});
      await this.#contextRefresh.get(thread.id)?.catch(() => {});
      await this.#closeClient(thread.id);
      if (this.#blockedThreads.has(thread.id)) throw error('UNAVAILABLE', 'Pi 未正常停止，请重启应用后修改上下文长度。');
      this.#assertOpen();
      const current = this.#officialCatalog.find(entry => entry.id === model.id && !entry.disabled);
      if (!current || contextWindow !== null && !(current.supportedContextWindows ?? [current.contextWindow]).includes(contextWindow)) {
        throw error('CONFLICT', '模型目录已变化，请重新选择上下文长度。');
      }
      if (contextWindow === null) {
        const { [model.id]: removed, ...rest } = previous;
        thread.contextWindows = rest;
      } else thread.contextWindows = { ...previous, [model.id]: contextWindow };
      thread.piContextUsage = projectContextUsage();
      this.#persist();
      this.#publish('thread.updated', { threadId, payload: { thread: this.#publicThread(thread) } });
      return this.#publicThread(thread);
    } finally { this.#preparing.delete(thread.id); }
  }

  #selectedModel(thread) {
    if (this.officialOnly) return this.#officialCatalog.find(m => m.id === thread.models.currentModelId && !m.disabled);
    return { id: this.model, provider: this.provider, reasoning: false, contextWindow: 32768 };
  }

  #turnSettings(thread) {
    const model = this.#selectedModel(thread);
    if (!model) return { status: 'unavailable' };
    try {
      return { status: 'available', ...normalizeTurnSettings({ thoughtLevel: thread.thoughtLevels?.[model.id],
        preMessageCompactPct: thread.preMessageCompactPct }, { ...model, provider: this.provider },
      { contextWindow: this.#effectiveContextWindow(thread) ?? model.contextWindow }) };
    } catch (cause) { return { status: 'invalid', errorCode: cause.code, message: '模型能力已变化，请重新选择推理或压缩设置。' }; }
  }

  #turnRuntime(thread) {
    if (!this.officialOnly) return { agentDir: this.agentDir, effective: this.#turnSettings(thread) };
    const model = this.#selectedModel(thread);
    if (!model) throw error('OFFICIAL_MODEL_SELECTION_REQUIRED', '请先选择可用的官方模型。');
    let baseSettings = {};
    const filename = join(this.agentDir, 'settings.json'), stat = realFileIfPresent(filename);
    if (stat && stat.size <= 512 * 1024) baseSettings = JSON.parse(readFileSync(filename, 'utf8'));
    return ensureTurnRuntime({ stateDir: this.stateDir, threadId: thread.id, baseSettings,
      settings: { thoughtLevel: thread.thoughtLevels?.[model.id], preMessageCompactPct: thread.preMessageCompactPct },
      model: { ...model, provider: this.provider }, contextWindow: this.#effectiveContextWindow(thread) ?? model.contextWindow });
  }

  async setExecutionSettings({ threadId, ...change }) {
    this.#assertOpen(); const thread = this.#thread(threadId);
    if (!this.officialOnly) throw error('UNAVAILABLE', '此设置需要官方模型能力目录。');
    if (thread.activeTurnId || this.#preparing.has(thread.id)) throw error('CONFLICT', '请等待当前操作结束后修改执行设置。');
    if (!Object.keys(change).length || Object.keys(change).some(k => !['thoughtLevel', 'preMessageCompactPct'].includes(k))) throw error('INVALID_PARAMS', '执行设置字段无效。');
    this.#preparing.add(thread.id);
    try {
      await this.refreshOfficialModels(); this.#assertOpen(); const model = this.#selectedModel(thread);
      if (!model) throw error('OFFICIAL_MODEL_SELECTION_REQUIRED', '请先选择可用的官方模型。');
      const levels = { ...(thread.thoughtLevels ?? {}) };
      if (Object.hasOwn(change, 'thoughtLevel')) {
        const selected = change.thoughtLevel;
        const effective = normalizeThoughtLevel(selected, model);
        if (selected === null || selected === '' || selected === undefined || selected === 'enabled') delete levels[model.id];
        else levels[model.id] = effective;
        if (Object.keys(levels).length > 128) throw error('INVALID_PARAMS', '会话模型设置数量超过限制。');
      }
      const percent = Object.hasOwn(change, 'preMessageCompactPct') ? normalizePreMessageCompactPct(change.preMessageCompactPct) : thread.preMessageCompactPct ?? null;
      if (JSON.stringify(levels) === JSON.stringify(thread.thoughtLevels ?? {}) && percent === (thread.preMessageCompactPct ?? null)) return this.#publicThread(thread);
      this.#contextVersion.set(thread.id, (this.#contextVersion.get(thread.id) ?? 0) + 1);
      await this.#statsClients.get(thread.id)?.close().catch(() => {});
      await this.#contextRefresh.get(thread.id)?.catch(() => {});
      await this.#closeClient(thread.id);
      this.#assertOpen();
      if (this.#blockedThreads.has(thread.id)) throw error('UNAVAILABLE', 'Pi 未能安全停止，请重启后修改设置。');
      thread.thoughtLevels = levels; thread.preMessageCompactPct = percent;
      thread.updatedAt = now(); this.#persist();
      this.#publish('thread.updated', { threadId, payload: { thread: this.#publicThread(thread) } });
      return this.#publicThread(thread);
    } finally { this.#preparing.delete(thread.id); }
  }

  async compactThread({ threadId, customInstructions } = {}) {
    this.#assertOpen(); const thread = this.#thread(threadId);
    if (thread.activeTurnId || this.#preparing.has(thread.id) || thread.pendingRewind) throw error('CONFLICT', '请等待当前操作结束后压缩。');
    if (!thread.turns.length || !realFileIfPresent(this.#sessionFile(thread))) throw error('PI_COMPACTION_EMPTY', '当前会话还没有可压缩的内容。');
    if (customInstructions !== undefined && (typeof customInstructions !== 'string' || Buffer.byteLength(customInstructions) > 8192)) throw error('INVALID_PARAMS', '压缩指令过长或格式无效。');
    const operation = { cancelled: false }; this.#compactions.set(thread.id, operation); this.#preparing.add(thread.id);
    thread.status = 'compacting'; this.#publish('thread.updated', { threadId, payload: { thread: this.#publicThread(thread) } });
    try {
      await this.refreshOfficialModels(); this.#assertOpen();
      if (operation.cancelled) return { cancelled: true };
      const run = { turn: { id: `pi-turn-${randomUUID()}` }, features: { instructions: '', tools: [] } };
      const entry = this.#client(thread, run); await this.#readyClient(thread, entry);
      if (operation.cancelled) return { cancelled: true };
      if (this.officialOnly) this.#writeRequestContext(thread, run.turn);
      const result = await entry.client.compact({ customInstructions, timeoutMs: Math.max(180000, this.#requestTimeoutMs) });
      if (operation.cancelled) return { cancelled: true };
      thread.lastCompaction = { at: now(), tokensBefore: result?.tokensBefore ?? null, estimatedTokensAfter: result?.estimatedTokensAfter ?? null };
      this.#contextVersion.set(thread.id, (this.#contextVersion.get(thread.id) ?? 0) + 1);
      thread.piContextUsage = projectContextUsage(); this.#persist();
      return { compacted: true, ...thread.lastCompaction };
    } catch (cause) {
      await this.#closeClient(thread.id);
      if (operation.cancelled) return { cancelled: true };
      throw error('PI_COMPACTION_FAILED', '上下文压缩未完成，原会话保留；请检查模型连接后重试。');
    } finally {
      if (operation.cancelled) await this.#closeClient(thread.id);
      this.#compactions.delete(thread.id); this.#preparing.delete(thread.id); thread.status = 'idle';
      if (!this.#closed) { this.#persist(); this.#publish('thread.updated', { threadId, payload: { thread: this.#publicThread(thread) } }); void this.refreshContextUsage({ threadId }).catch(() => {}); }
    }
  }

  async fileResources({ threadId, detailRef } = {}) {
    this.#assertOpen(); const thread = this.#thread(threadId);
    await this.#journalReady;
    if (this.#journalFailure) throw error('PI_FILE_UNAVAILABLE', '文件记录暂不可读取，请保留快照后检查。');
    if (!this.#fileJournal) return { artifacts: [], files: [], manifests: [] };
    const active = new Set(thread.turns.map(t => t.id));
    const files = (await this.#fileJournal.listFiles({ threadId })).filter(f => active.has(f.turnId));
    const manifests = (await this.#fileJournal.listManifests({ threadId })).filter(m => active.has(m.turnId) && !m.rolledBackAt);
    if (detailRef !== undefined) {
      const manifest = manifests.find(m => m.turnId === detailRef);
      if (!manifest) throw error('NOT_FOUND', '未找到该轮文件变更。');
      const details = new Map(); let bytes = 0;
      for (const change of manifest.changes) {
        const detail = await this.#fileJournal.getChangeDetail({ threadId, changeId: change.id });
        bytes += Buffer.byteLength(JSON.stringify(detail));
        details.set(change.id, bytes <= 1024 * 1024 ? detail : { reason: 'text-preview-limit' });
      }
      return { detail: nativeManifest(manifest, details) };
    }
    const diff = await nativeDiffResources(manifests.filter(m => m.changes.length),
      change => this.#fileJournal.getChangeDetail({ threadId, changeId: change.id }));
    return { artifacts: nativeArtifacts(files), files: nativeFileTree(files, thread.cwd), ...diff };
  }

  async checkpointRead({ threadId, turnId } = {}) {
    this.#assertOpen(); const thread = this.#thread(threadId), index = thread.turns.findIndex(t => t.id === turnId);
    if (index < 0 || !thread.turns[index].sessionCheckpoint || thread.pendingRewind) return { available: false, reason: 'checkpoint-unavailable' };
    if (thread.activeTurnId || this.#preparing.has(thread.id)) return { available: false, reason: 'runtime-busy' };
    await this.#journalReady;
    const turnIds = thread.turns.slice(index).map(t => t.id);
    const manifests = this.#fileJournal ? await this.#fileJournal.listManifests({ threadId }) : [];
    const affected = manifests.filter(m => turnIds.includes(m.turnId) && !m.rolledBackAt);
    if (affected.some(m => !m.coverage?.complete)) return { available: false, reason: 'incomplete-file-coverage', errorCode: 'PI_FILE_CHECKPOINT_UNAVAILABLE' };
    const tracked = affected.filter(m => m.changes.length).map(m => m.turnId);
    const checkpoint = tracked.length ? await this.#fileJournal.checkpointRead({ threadId, turnIds: tracked }) : { available: true, files: [], coverage: { complete: true } };
    if (!checkpoint.available) return { available: false, reason: checkpoint.reason, errorCode: 'PI_FILE_CHECKPOINT_UNAVAILABLE' };
    const kept = new Set(thread.turns.slice(0, index).map(t => t.id));
    const restoreInfo = checkpoint.files.map(file => {
      const first = manifests.filter(m => tracked.includes(m.turnId)).flatMap(m => m.changes).find(c => c.path === file.path);
      const previous = [...manifests].reverse().find(m => kept.has(m.turnId) && !m.rolledBackAt
        && m.changes.some(c => c.path === file.path && first?.before.kind === 'file' && c.after.kind === 'file' && c.after.sha256 === first.before.sha256));
      return { path: file.path, restorePoint: 'exact', ...(previous ? { versionRequestId: previous.turnId } : {}) };
    });
    return { available: true, diff: { changes: checkpoint.files.map(f => ({ path: f.path, operation: f.operation === 'created' ? 'delete' : 'write' })) },
      unavailable: [], restoreInfo,
      forkPoint: { found: true }, createdAt: Date.parse(thread.turns[index].createdAt), coverage: checkpoint.coverage };
  }

  async rewindThread({ threadId, turnId } = {}) {
    this.#assertOpen(); const thread = this.#thread(threadId), index = thread.turns.findIndex(t => t.id === turnId);
    if (index < 0 || !thread.turns[index].sessionCheckpoint) throw error('PI_CHECKPOINT_UNAVAILABLE', '该轮次来自旧版本，尚无可验证的检查点。');
    if (thread.activeTurnId || this.#preparing.has(thread.id) || thread.pendingRewind) throw error('CONFLICT', '请先结束当前操作再回退。');
    this.#preparing.add(thread.id);
    const operation = { cancelled: false, committing: false, done: deferred() }; this.#rewinds.set(thread.id, operation);
    const assertRewindOpen = () => { this.#assertOpen(); if (operation.cancelled) throw error('CONFLICT', '文件回退已取消。'); };
    try {
      await this.#journalReady;
      assertRewindOpen();
      const removed = thread.turns.slice(index), ids = removed.map(t => t.id);
      if (removed.some(t => t.items.some(i => i.type === 'tool' && !TOOLS.has(i.name)))) throw error('PI_CHECKPOINT_EXTERNAL_EFFECT', '该范围包含业务工具调用，文件检查点无法撤销其外部副作用，已拒绝整轮回退。');
      const manifests = this.#fileJournal ? await this.#fileJournal.listManifests({ threadId }) : [];
      const affected = manifests.filter(m => ids.includes(m.turnId) && !m.rolledBackAt);
      if (affected.some(m => !m.coverage?.complete)) throw error('PI_CHECKPOINT_CONFLICT', '文件快照范围不完整，未执行回退。');
      const tracked = affected.filter(m => m.changes.length).map(m => m.turnId);
      const plan = tracked.length ? await this.#fileJournal.prepareRollback({ threadId, turnIds: tracked }) : { available: true };
      assertRewindOpen();
      if (!plan.available) throw error('PI_CHECKPOINT_CONFLICT', '文件已被外部修改、快照范围不完整或检查点不可用，未执行回退。');
      if (plan.changes?.length) this.#claimFileScope(thread.id, plan.changes.map(c => c.path));
      this.#contextVersion.set(thread.id, (this.#contextVersion.get(thread.id) ?? 0) + 1);
      await this.#statsClients.get(thread.id)?.close().catch(() => {}); await this.#contextRefresh.get(thread.id)?.catch(() => {});
      await this.#closeClient(thread.id);
      assertRewindOpen();
      if (this.#blockedThreads.has(thread.id)) throw error('UNAVAILABLE', 'Pi 未能安全停止，未执行回退。');
      const prepared = this.#sessionCheckpoints.prepareRestore({ threadId, turnId, checkpoint: removed[0].sessionCheckpoint });
      const backup = join(this.stateDir, 'rewind-backups', prepared.id, 'thread-before-rewind.json');
      const backupFd = openSync(backup, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { writeFileSync(backupFd, JSON.stringify(thread)); fsyncSync(backupFd); } finally { closeSync(backupFd); }
      thread.pendingRewind = { backupId: prepared.id, turnId, turnIds: ids, phase: 'prepared' }; this.#persist();
      // Once committing begins, normal shutdown waits for completion or a
      // persisted recovery-required state rather than abandoning the transaction.
      operation.committing = true;
      if (tracked.length) {
        const result = await this.#fileJournal.rollbackTurn({ threadId, turnIds: tracked, token: plan.token });
        if (!result.applied) { delete thread.pendingRewind; this.#persist(); throw error('PI_CHECKPOINT_CONFLICT', '回退提交前文件已变化，未覆盖当前文件。'); }
      }
      thread.pendingRewind.phase = 'files-restored'; this.#persist();
      this.#sessionCheckpoints.restore(prepared);
      thread.turns = thread.turns.slice(0, index); thread.piContextUsage = projectContextUsage(); thread.updatedAt = now();
      delete thread.pendingRewind; this.#persist(); this.#sessionCheckpoints.complete(prepared);
      this.#publish('thread.updated', { threadId, payload: { thread: this.#publicThread(thread) } });
      this.#publish('files.updated', { threadId, payload: fileUpdatePayload(plan.changes) });
      return { ok: true, branchChanged: true, truncatedFromRequestId: turnId, removedRequestIds: ids, thread: this.#publicThread(thread) };
    } catch (cause) {
      if (thread.pendingRewind) { thread.status = 'error'; this.#blockedThreads.add(thread.id); this.#persist(); throw error('PI_CHECKPOINT_RECOVERY_REQUIRED', '回退事务中断，原会话与文件快照均保留；该任务已暂停，需检查私有回退记录后恢复。'); }
      throw cause;
    } finally { this.#preparing.delete(thread.id); this.#fileScopes.delete(thread.id); this.#rewinds.delete(thread.id); operation.done.resolve(); }
  }

  async deleteThread(threadId) {
    this.#assertOpen();
    const thread = this.#thread(threadId);
    if (this.#preparing.has(thread.id) || thread.pendingRewind) throw error('CONFLICT', '请先结束压缩、设置或回退操作再删除任务。');
    this.#preparing.add(thread.id);
    try {
    if (thread.activeTurnId) await this.cancelTurn({ threadId, turnId: thread.activeTurnId });
    await this.#closeClient(thread.id);
    await this.#statsClients.get(thread.id)?.close().catch(() => {});
    this.#assertOpen();
    this.#threads.delete(thread.id);
    this.#persist();
    const session = this.#sessionFile(thread);
    realFileIfPresent(session);
    rmSync(session, { force: true });
    realFileIfPresent(this.#nativeContextFile(thread));
    rmSync(this.#nativeContextFile(thread), { force: true });
    if (this.officialOnly) {
      realFileIfPresent(this.#requestContextFile(thread));
      rmSync(this.#requestContextFile(thread), { force: true });
    }
    this.#publish('thread.deleted', { threadId, payload: { threadId } });
    return { deleted: true, threadId };
    } finally { this.#preparing.delete(thread.id); }
  }

  async resolveExpertSelection({ expert } = {}) {
    this.#assertOpen();
    if (!expert || typeof expert !== 'object' || Array.isArray(expert)) throw error('INVALID_PARAMS', '专家选择无效。');
    required(expert.id, 'expert.id');
    const resolved = await resolveInstalledExpert(expert, { configDir: this.#expertConfigDir });
    this.#assertOpen();
    if (expert.package && !resolved) throw error('PI_EXPERT_PACKAGE_UNAVAILABLE', '已绑定的专家包暂不可验证，请重新选择专家。');
    return resolved;
  }

  async setNativeContext({ threadId, expert, connectors }) {
    this.#assertOpen();
    const thread = this.#thread(threadId);
    if (thread.activeTurnId || this.#preparing.has(thread.id)) throw error('CONFLICT', '请先停止当前轮次再更改 Expert 或连接器。');
    const previous = thread.nativeContext ?? { expert: null, connectors: [] };
    const context = await resolveNativeContext({ expert: expert === undefined ? previous.expert : expert, skills: [] }, { expertConfigDir: this.#expertConfigDir });
    this.#assertOpen();
    const options = connectors === undefined ? thread.nativeContext?.connectorSelections ?? thread.nativeContext?.connectors ?? [] : connectors;
    if (!Array.isArray(options)) throw error('INVALID_PARAMS', '连接器选择无效。');
    const selected = validateConnectorSelection(options.map(item => typeof item === 'string' ? item : item?.name));
    if (thread.activeTurnId || this.#preparing.has(thread.id)) throw error('CONFLICT', '任务已开始，请稍后更改上下文。');
    thread.nativeContext = { expert: expert === undefined ? thread.nativeContext?.expert ?? null : context.expert, connectors: selected,
      connectorSelections: options.map((item, index) => ({ name: selected[index], displayName: typeof item?.displayName === 'string' ? item.displayName.slice(0, 256) : selected[index], activeStatus: true })) };
    this.#persist();
    this.#publish('thread.updated', { threadId, payload: { thread: this.#publicThread(thread) } });
    return this.#publicThread(thread);
  }

  async startTurn({ threadId, prompt, model, promptContentBlocks, skills = [] }) {
    this.#assertOpen();
    const thread = this.#thread(threadId);
    if (!Array.isArray(promptContentBlocks) || !promptContentBlocks.length) required(prompt, 'prompt');
    if (this.#statsClients.has(thread.id)) {
      await this.#statsClients.get(thread.id).close().catch(() => {});
      await this.#contextRefresh.get(thread.id)?.catch(() => {});
    }
    if (this.#preparing.has(thread.id)) throw error('CONFLICT', '正在准备本轮请求。');
    this.#preparing.add(thread.id);
    try {
      if (this.officialOnly) await this.refreshOfficialModels();
      this.#assertOpen();
      if (this.#blockedThreads.has(thread.id)) throw error('UNAVAILABLE', '上次 Pi 进程未正常退出，请重启外置 Host 后重试。');
      if (thread.pendingRewind) throw error('PI_CHECKPOINT_RECOVERY_REQUIRED', '该任务有未完成的回退事务，请先检查私有快照记录。');
      if (this.#runs.get(thread.id)?.cancelling || this.#closingThreads.has(thread.id)) throw error('CONFLICT', 'Pi 正在停止，请等待停止完成。');
      if (thread.activeTurnId) throw error('CONFLICT', '该任务仍有运行中的轮次，请先停止。');
      if (model !== undefined) {
        const models = this.#explicitModels(model);
        if (models.currentModelId !== thread.models.currentModelId) {
          thread.models = models;
          thread.updatedAt = now();
          this.#publish('thread.updated', { threadId, payload: { thread: this.#publicThread(thread) } });
        }
      }
      if (this.officialOnly && !thread.models.currentModelId) {
        throw error('OFFICIAL_MODEL_SELECTION_REQUIRED', thread.models.selectionReason ?? '默认官方模型不可用，请先选择模型。');
      }
      if (this.officialOnly && this.#officialCatalog.find(model => model.id === thread.models.currentModelId)?.disabled) {
        throw error('OFFICIAL_MODEL_FORBIDDEN', '当前账号无权使用此官方模型，请切换模型。');
      }
      const turn = {
        id: `pi-turn-${randomUUID()}`, threadId: thread.id, prompt: prompt || '附件输入',
        provider: this.provider, model: thread.models.currentModelId,
        status: 'running', stopReason: null, createdAt: now(), completedAt: null,
        items: [], interaction: null, interactions: [],
        inputDiagnostics: describeNativeInput(promptContentBlocks),
      };
      const run = { turn, settled: deferred(), cancelling: false, promptSent: false,
        rawInput: { prompt, promptContentBlocks, skills }, input: null, features: { instructions: '', tools: [] }, approvedNative: new Map(), authorizationRequestIds: new Set(), nativeCallRequestIds: new Set(),
        abort: new AbortController(),
        currentMessageId: null, messageSequence: 0, currentThinkingId: null, thinkingSequence: 0,
        assistantSequence: 0, usageSnapshots: new Map() };
      this.#runs.set(thread.id, run);
      this.#contextVersion.set(thread.id, (this.#contextVersion.get(thread.id) ?? 0) + 1);
      thread.piContextUsage = projectContextUsage();
      thread.turns.push(turn);
      thread.activeTurnId = turn.id;
      thread.status = 'running';
      thread.updatedAt = turn.createdAt;
      this.#persist();
      this.#publish('turn.started', { threadId, turnId: turn.id, payload: { turn: clone(turn) } });
      void this.#performPrompt(thread, run);
      return clone(turn);
    } finally { this.#preparing.delete(thread.id); }
  }

  async cancelTurn({ threadId, turnId }) {
    this.#assertOpen();
    const thread = this.#thread(threadId);
    const compaction = this.#compactions.get(thread.id);
    if (compaction) { compaction.cancelled = true; await this.#closeClient(thread.id); return { status: 'cancelled' }; }
    const turn = thread.turns.find(entry => entry.id === (turnId ?? thread.activeTurnId));
    const run = this.#runs.get(thread.id);
    if (!turn) throw error('NOT_FOUND', '未找到需要停止的轮次。');
    if (!ACTIVE.has(turn.status) || run?.turn !== turn) {
      throw error('CONFLICT', '该轮次已经结束。');
    }
    if (run.cancelPromise) return run.cancelPromise;
    run.cancelling = true;
    run.abort?.abort();
    this.#cancelPendingInteractions(thread, run);
    run.cancelPromise = (async () => {
      const client = this.#clients.get(thread.id)?.client;
      if (client && run.promptSent) {
        void client.abort({ timeoutMs: this.#cancelTimeoutMs }).catch(() => {});
        await bounded(run.settled.promise, this.#cancelTimeoutMs);
      }
      // Drop the process after abort, even when it settled. Late records from an
      // aborted run must never be attached to the next turn of this thread.
      await this.#closeClient(thread.id);
      if (ACTIVE.has(turn.status)) await this.#finish(thread, run, 'cancelled', 'cancelled');
      if (run.finishPromise) await run.finishPromise;
      run.cancelling = false;
      return clone(turn);
    })();
    return run.cancelPromise;
  }

  async respondInteraction({ interactionId, response } = {}) {
    this.#assertOpen();
    if (!this.#approvalExtension) throw error('UNAVAILABLE', 'Pi 当前仅启用只读工具，不支持审批交互。');
    required(interactionId, 'interactionId');
    const pending = this.#pendingInteractions.get(interactionId);
    if (!pending) throw error('NOT_FOUND', '操作确认已结束或不存在。');
    if (!this.#isRun(pending.thread, pending.run) || pending.run.cancelling) {
      throw error('CONFLICT', '操作确认所属轮次已结束。');
    }
    const candidate = typeof response === 'boolean' ? (response ? 'allow' : 'deny')
      : typeof response === 'string' ? response
        : response?.decision ?? response?.optionId ?? response?.option_id ?? response?.outcome ?? response?.kind;
    const decision = typeof candidate === 'string' ? candidate.toLowerCase().replaceAll('-', '_') : '';
    const allow = ['allow', 'allow_once', 'approve', 'approved'].includes(decision);
    if (!allow && !['cancel', 'deny', 'denied', 'reject', 'rejected', 'reject_once'].includes(decision)) {
      throw error('INVALID_PARAMS', '请选择仅允许本次操作或拒绝；不支持永久授权。');
    }
    this.#resolveInteraction(pending, allow ? 'approved' : 'rejected');
    try {
      if (allow) await this.#beforeFileTool(pending.thread, pending.run, pending.interaction.toolName, pending.interaction.toolCall.input);
      if (!this.#isRun(pending.thread, pending.run) || pending.run.cancelling) return { interaction: clone(pending.interaction) };
      await pending.client.sendExtensionUiResponse({ id: pending.uiId, confirmed: allow });
    } catch (cause) {
      const snapshot = /^(?:FILE_JOURNAL|PI_FILE)/.test(cause?.code ?? '');
      const message = snapshot ? cause.code === 'PI_FILE_SCOPE_BUSY' ? cause.message : '文件快照未能安全完成，本次操作未授权。' : '操作确认无法送达 Pi，本轮已停止。';
      void pending.client.sendExtensionUiResponse({ id: pending.uiId, confirmed: false }).catch(() => {});
      this.#finish(pending.thread, pending.run, 'failed', 'error', message, snapshot ? cause.code : 'PI_ERROR');
      await this.#closeClient(pending.thread.id);
      throw error(snapshot ? cause.code : 'UNAVAILABLE', message);
    }
    return { interaction: clone(pending.interaction) };
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#officialPollTimer);
    for (const operation of this.#compactions.values()) operation.cancelled = true;
    const rewinds = [...this.#rewinds.values()];
    for (const operation of rewinds) if (!operation.committing) operation.cancelled = true;
    const finishing = [];
    for (const thread of this.#threads.values()) {
      const run = this.#runs.get(thread.id);
      if (run && ACTIVE.has(run.turn.status)) {
        finishing.push(this.#finish(thread, run, 'interrupted', 'runtime_closed'));
      }
    }
    await Promise.allSettled([...this.#clients.keys()].map(id => this.#closeClient(id)));
    await Promise.allSettled([...this.#statsClients.values()].map(client => client.close()));
    await Promise.allSettled(finishing);
    await Promise.allSettled(rewinds.map(o => o.done.promise));
    this.#persist();
    this.#listeners.clear();
  }

  #models(requestedModelId = this.model) {
    if (!this.officialOnly) return { availableModels: [{ id: this.model, name: this.modelName }], currentModelId: this.model };
    if (!this.#officialCatalog.length) {
      return { availableModels: [{ id: requestedModelId, name: requestedModelId === this.model ? this.modelName : requestedModelId,
        provider: OFFICIAL_PROVIDER }], currentModelId: requestedModelId, requestedModelId };
    }
    const availableModels = clone(this.#officialCatalog);
    const counts = new Map();
    for (const model of availableModels) counts.set(model.name, (counts.get(model.name) ?? 0) + 1);
    for (const model of availableModels) if (counts.get(model.name) > 1) model.description = model.id;
    const exact = availableModels.find(model => model.id === requestedModelId && !model.disabled);
    const alias = requestedModelId === 'hy4'
      ? availableModels.find(model => !model.disabled && /^hy4(?:[-_.]|$)/.test(model.id)) : null;
    const selected = exact?.id ?? alias?.id ?? null;
    return { availableModels, currentModelId: selected, requestedModelId: selected ?? requestedModelId,
      ...(selected ? {} : { selectionRequired: true, selectionReason: '默认或先前选择的官方模型不可用，请从官方目录选择模型。' }) };
  }
  #explicitModels(value) {
    const model = required(value, 'model').trim();
    if (model.length > 256 || /[\x00-\x1f]/.test(model)) throw error('INVALID_PARAMS', 'Invalid model');
    if (!this.officialOnly) {
      if (model !== this.model) throw error('INVALID_PARAMS', 'Pi 试验模式仅启用已配置的本地模型。');
      return this.#models(model);
    }
    if (!this.#officialCatalog.length) throw error('OFFICIAL_BRIDGE_UNAVAILABLE', '官方模型目录尚未就绪。');
    const models = this.#models(model);
    if (!models.currentModelId) {
      const existing = this.#officialCatalog.find(entry => entry.id === model);
      if (existing?.disabled) throw error('OFFICIAL_MODEL_FORBIDDEN', '当前账号无权使用此官方模型。');
      throw error('INVALID_PARAMS', '该模型不在当前账号的可用官方目录中。');
    }
    return models;
  }
  #verifyOfficialExtension() {
    for (const [filename, expected] of Object.entries(OFFICIAL_FILES)) {
      const path = fileURLToPath(new URL(`./${filename}`, import.meta.url));
      const stat = realFileIfPresent(path);
      if (!stat || stat.size > 256 * 1024 || createHash('sha256').update(readFileSync(path)).digest('hex') !== expected) {
        throw error('UNAVAILABLE', '官方模型 Provider 文件缺失或完整性检查失败。');
      }
    }
    if (this.args.some(arg => arg === '--' || arg === '-e' || arg.startsWith('--extension')
      || arg === '-t' || arg.startsWith('--tools') || arg === '-nt' || arg.startsWith('--no-tools')
      || arg === '--mode' || arg.startsWith('--mode='))) {
      throw error('INVALID_PARAMS', '官方模式禁止覆盖受控 Provider、扩展和工具参数。');
    }
  }
  #verifyApprovalExtension() {
    const stat = realFileIfPresent(this.#approvalExtension);
    if (!stat || stat.size > 64 * 1024
      || createHash('sha256').update(readFileSync(this.#approvalExtension)).digest('hex') !== APPROVAL_EXTENSION_SHA256) {
      throw error('UNAVAILABLE', 'Pi 操作确认扩展缺失或与受控版本不一致，禁止启用写入和 Bash。');
    }
    if (this.args.some(arg => arg === '--' || arg === '-e' || arg.startsWith('--extension')
      || arg === '-t' || arg.startsWith('--tools') || arg === '-nt' || arg.startsWith('--no-tools')
      || arg === '--mode' || arg.startsWith('--mode='))) {
      throw error('INVALID_PARAMS', 'Pi 启动前缀不得覆盖 Host 的工具、扩展和 RPC 策略。');
    }
  }
  #thread(id) {
    required(id, 'threadId');
    const thread = this.#threads.get(id);
    if (!thread) throw error('NOT_FOUND', '未找到 Pi 任务。');
    return thread;
  }
  #sessionFile(thread) { return join(this.#sessionDir, `${thread.id}.jsonl`); }
  #contextWindows(thread) {
    return Object.fromEntries(this.#officialCatalog.filter(model => !model.disabled
      && Object.hasOwn(thread.contextWindows ?? {}, model.id)
      && (model.supportedContextWindows ?? [model.contextWindow]).includes(thread.contextWindows[model.id]))
      .map(model => [model.id, thread.contextWindows[model.id]]));
  }
  #effectiveContextWindow(thread) {
    const model = thread.models?.availableModels?.find(model => model.id === thread.models.currentModelId);
    return this.#contextWindows(thread)[model?.id] ?? model?.contextWindow;
  }
  async refreshContextUsage({ threadId, allowCold = true } = {}) {
    this.#assertOpen();
    const thread = this.#thread(threadId);
    let catalogFailure;
    if (this.officialOnly) {
      try { await this.refreshOfficialModels({ waitMs: 0 }); }
      catch (cause) { catalogFailure = cause; }
      this.#assertOpen();
    }
    if (this.#preparing.has(thread.id) && !thread.activeTurnId) return clone(thread.piContextUsage ?? projectContextUsage());
    if (this.#contextRefresh.has(thread.id)) return this.#contextRefresh.get(thread.id);
    if (thread.piContextUsage?.status === 'available' && Date.now() - Date.parse(thread.piContextUsage.updatedAt) < 1_000) return clone(thread.piContextUsage);
    const version = this.#contextVersion.get(thread.id) ?? 0;
    const operation = (async () => {
      let client = this.#clients.get(thread.id)?.client, owned = false, snapshotDir;
      let summary = projectContextUsage();
      try {
        if (catalogFailure) throw catalogFailure;
        if (client && this.officialOnly && !thread.activeTurnId
          && this.#clients.get(thread.id)?.catalogVersion !== this.#officialCatalogVersion) {
          await this.#closeClient(thread.id);
          client = undefined;
        }
        if (!client && allowCold && realFileIfPresent(this.#sessionFile(thread))) {
          if (this.officialOnly) this.#verifyOfficialExtension();
          const before = realFileIfPresent(this.#sessionFile(thread));
          if (before.size > 256 * 1024 * 1024) throw error('PI_CONTEXT_UNAVAILABLE', '会话过大，无法读取上下文快照。');
          snapshotDir = mkdtempSync(join(this.stateDir, 'stats-'));
          const sessionCopy = join(snapshotDir, 'session.jsonl');
          copyFileSync(this.#sessionFile(thread), sessionCopy); chmodSync(sessionCopy, 0o600);
          const after = realFileIfPresent(this.#sessionFile(thread));
          if (!after || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw error('PI_CONTEXT_UNAVAILABLE', '读取统计期间会话已变化。');
          const env = {};
          for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR']) if (process.env[key] !== undefined) env[key] = process.env[key];
          const runtime = this.#turnRuntime(thread);
          Object.assign(env, this.env, { PI_CODING_AGENT_DIR: runtime.agentDir, PI_CODING_AGENT_SESSION_DIR: this.#sessionDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' });
          if (this.officialOnly) {
            env.WORKBUDDY_PI_OFFICIAL_BRIDGE_DIR = this.officialBridgeDir;
            env.WORKBUDDY_PI_CONTEXT_WINDOWS = JSON.stringify(this.#contextWindows(thread));
            const contextFile = join(snapshotDir, 'request.json');
            writeFileSync(contextFile, JSON.stringify({ threadId: thread.id, turnId: `pi-turn-${randomUUID()}` }), { mode: 0o600, flag: 'wx' });
            env.WORKBUDDY_PI_REQUEST_CONTEXT_FILE = contextFile;
          }
          client = this.#factory({ command: this.command, args: [...this.args, '--mode', 'rpc', '--provider', this.provider,
            '--model', thread.models.currentModelId ?? thread.models.requestedModelId ?? this.model, '--thinking', runtime.effective.thinkingLevel ?? 'off',
            '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-mcp', '--no-context-files', '--offline', '--no-tools',
            ...(this.#officialExtension ? ['--extension', this.#officialExtension] : []), '--session', sessionCopy],
            cwd: thread.cwd, env, timeoutMs: Math.min(this.#requestTimeoutMs, 8_000) });
          owned = true; this.#statsClients.set(thread.id, client);
          client.on('failure', () => {}); client.on('error', () => {});
          await client.start();
        }
        if (client && typeof client.getSessionStats === 'function') {
          const timeoutMs = Math.min(this.#requestTimeoutMs, 8_000);
          const state = await client.getState({ timeoutMs });
          const stats = await client.getSessionStats({ timeoutMs });
          summary = projectContextUsage({ stats, state });
        }
      } catch (cause) {
        // Keep a bounded diagnostic code without SDK stderr, paths or credentials.
        const safeCodes = ['PI_RPC_TIMEOUT', 'PI_RPC_EXITED', 'PI_RPC_CLOSED', 'PI_RPC_INVALID_RECORD', 'OFFICIAL_BRIDGE_UNAVAILABLE', 'OFFICIAL_AUTH_REQUIRED', 'PI_CONTEXT_UNAVAILABLE'];
        summary = { ...summary, refreshErrorCode: safeCodes.includes(cause?.code) ? cause.code : 'PI_CONTEXT_REFRESH_FAILED' };
      }
      finally {
        if (owned) { this.#statsClients.delete(thread.id); try { await client.close(); } catch { this.#blockedThreads.add(thread.id); } }
        if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
      }
      if (!this.#closed && this.#threads.get(thread.id) === thread && (this.#contextVersion.get(thread.id) ?? 0) === version) {
        thread.piContextUsage = { ...summary, updatedAt: now() };
        this.#persist();
        this.#publish('context.usage.updated', { threadId, payload: { summary: clone(thread.piContextUsage) } });
      }
      return clone(thread.piContextUsage ?? summary);
    })().finally(() => {
      this.#contextRefresh.delete(thread.id);
      if (!this.#closed && this.#threads.get(thread.id) === thread && (this.#contextVersion.get(thread.id) ?? 0) !== version
        && !thread.activeTurnId && !this.#preparing.has(thread.id) && this.#clients.has(thread.id)) void this.refreshContextUsage({ threadId, allowCold: false }).catch(() => {});
    });
    this.#contextRefresh.set(thread.id, operation);
    return operation;
  }
  #requestContextFile(thread) { return join(this.#sessionDir, `${thread.id}.request.json`); }
  #nativeContextFile(thread) { return join(this.#sessionDir, `${thread.id}.native.json`); }
  #writeNativeContext(thread, run) {
    const filename = this.#nativeContextFile(thread), temp = `${filename}.${randomUUID()}.tmp`;
    realFileIfPresent(filename);
    const aliases = run.features.tools.length ? '当前选中的 MCP 工具映射（调用必须使用右侧 Pi 工具名；未列出的工具不可调用）：\n'
      + run.features.tools.map(tool => `${tool.connectorId} / ${tool.rawName} → ${tool.name}`).join('\n') : '';
    const value = { version: 1, threadId: thread.id, turnId: run.turn.id,
      instructions: [run.features.instructions, aliases].filter(Boolean).join('\n\n'), tools: run.features.tools.map(({ serverId, connectorId, rawName, ...tool }) => tool) };
    try { writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temp, filename); }
    finally { if (existsSync(temp)) rmSync(temp, { force: true }); }
  }
  #verifyNativeExtension() {
    const filename = fileURLToPath(new URL('./native-feature-extension.mjs', import.meta.url));
    const stat = realFileIfPresent(filename);
    if (!stat || stat.size > 64 * 1024 || createHash('sha256').update(readFileSync(filename)).digest('hex') !== NATIVE_EXTENSION_SHA256) {
      throw error('UNAVAILABLE', '原生功能映射扩展完整性校验失败。');
    }
    return filename;
  }
  #writeRequestContext(thread, turn) {
    const filename = this.#requestContextFile(thread);
    realFileIfPresent(filename);
    const temp = `${filename}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ threadId: thread.id, turnId: turn.id }), { mode: 0o600, flag: 'wx' });
      renameSync(temp, filename);
    } finally { if (existsSync(temp)) rmSync(temp, { force: true }); }
  }
  #assertOpen() { if (this.#closed) throw error('CONFLICT', 'Pi Harness 已关闭。'); }
  #publicThread(thread) {
    const visible = clone(thread); delete visible.pendingRewind;
    for (const turn of visible.turns) delete turn.sessionCheckpoint;
    return { ...visible, executionSettings: this.#turnSettings(thread), contextWindow: this.#effectiveContextWindow(thread), approvalMode: thread.approvalMode ?? this.defaultApprovalMode, items: clone(thread.turns.flatMap(turn => [
      ...turn.items,
      ...(turn.interactions ?? []).map(interaction => ({ ...interaction, interactionId: interaction.id, kind: 'approval' })),
    ])) };
  }
  #publish(type, fields = {}) {
    const event = { type, harnessId: this.id, ...fields };
    for (const listener of [...this.#listeners]) {
      try { listener(clone(event)); } catch { /* UI listeners cannot break the executor. */ }
    }
  }

  #client(thread, run) {
    let entry = this.#clients.get(thread.id);
    if (entry) return entry;
    if (this.#approvalExtension) this.#verifyApprovalExtension();
    if (this.officialOnly) this.#verifyOfficialExtension();
    const settingsExtension = this.officialOnly ? this.#verifySettingsExtension() : null;
    const runtime = this.#turnRuntime(thread);
    const nativeEnabled = Boolean(this.#nativeServices || run.features.instructions || run.features.tools.length);
    const nativeExtension = nativeEnabled ? this.#verifyNativeExtension() : null;
    realFileIfPresent(this.#sessionFile(thread));
    // Only a small OS environment is inherited: no WorkBuddy credentials,
    // provider secrets, project hooks, or the user's normal Pi configuration.
    const env = {};
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL',
      'XDG_DATA_HOME', 'SYSTEMROOT', 'WINDIR']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    Object.assign(env, this.env, { PI_CODING_AGENT_DIR: runtime.agentDir,
      PI_CODING_AGENT_SESSION_DIR: this.#sessionDir, PI_OFFLINE: '1', PI_TELEMETRY: '0',
      WORKBUDDY_PI_APPROVAL_TIMEOUT_MS: String(this.#approvalTimeoutMs) });
    for (const key of ['WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR', 'WORKBUDDY_USER_DATA_DIR', 'WORKBUDDY_RESOURCES_PATH']) {
      const value = process.env[key];
      if (typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f]/.test(value)) env[key] = value;
    }
    env.CODEBUDDY_SESSION_ID = thread.id;
    if (this.officialOnly) {
      env.WORKBUDDY_PI_OFFICIAL_BRIDGE_DIR = this.officialBridgeDir;
      env.WORKBUDDY_PI_CONTEXT_WINDOWS = JSON.stringify(this.#contextWindows(thread));
      env.WORKBUDDY_PI_REQUEST_CONTEXT_FILE = this.#requestContextFile(thread);
      env[TURN_SETTINGS_ENV] = runtime.extensionValue;
    }
    if (nativeEnabled) env.WORKBUDDY_PI_NATIVE_CONTEXT_FILE = this.#nativeContextFile(thread);
    const client = this.#factory({
      command: this.command,
      args: [...this.args, '--mode', 'rpc', '--provider', this.provider, '--model', thread.models.currentModelId,
        '--thinking', runtime.effective.thinkingLevel ?? 'off', '--no-extensions', '--no-skills', '--no-prompt-templates',
        '--no-mcp', '--no-context-files', '--offline', '--tools', [...this.tools, ...run.features.tools.map(tool => tool.name)].join(','),
        ...(this.#approvalExtension ? ['--extension', this.#approvalExtension] : []),
        ...(this.#officialExtension ? ['--extension', this.#officialExtension] : []),
        ...(nativeExtension ? ['--extension', nativeExtension] : []),
        ...(settingsExtension ? ['--extension', settingsExtension] : []),
        '--session', this.#sessionFile(thread)],
      cwd: thread.cwd, env, timeoutMs: this.#requestTimeoutMs,
    });
    if (this.#approvalExtension && typeof client.sendExtensionUiResponse !== 'function') {
      throw error('UNAVAILABLE', 'Pi 传输不支持操作确认，本轮未启动。');
    }
    const onEvent = record => {
      if (this.#clients.get(thread.id) !== entry) return;
      if (settingsExtension && record?.type === 'extension_ui_request' && record.method === 'notify' && record.message === TURN_SETTINGS_READY) {
        entry.settingsVerified = true; entry.settingsReady.resolve(); return;
      }
      if (nativeEnabled && record?.type === 'extension_ui_request' && record.method === 'notify' && record.message === NATIVE_READY) {
        entry.nativeVerified = true; entry.nativeReady.resolve(); return;
      }
      if (this.officialOnly && record?.type === 'extension_ui_request'
        && record.method === 'notify' && record.message === OFFICIAL_READY) {
        entry.officialVerified = true;
        entry.officialReady.resolve();
        return;
      }
      if (this.#approvalExtension && record?.type === 'extension_ui_request'
        && record.method === 'notify' && record.message === APPROVAL_READY) {
        entry.approvalVerified = true;
        entry.approvalReady.resolve();
        return;
      }
      if ((this.#approvalExtension || this.officialOnly || nativeEnabled) && record?.type === 'extension_error') { onFailure(); return; }
      this.#event(thread, record);
    };
    const onFailure = () => {
      if (this.#clients.get(thread.id) !== entry) return;
      entry.approvalReady.resolve();
      entry.officialReady.resolve();
      entry.nativeReady.resolve();
      entry.settingsReady.resolve();
      const run = this.#runs.get(thread.id);
      if (run && ACTIVE.has(run.turn.status) && !run.cancelling) {
        this.#finish(thread, run, 'failed', 'error', 'Pi 进程连接中断，请重试该任务。');
      }
      void this.#closeClient(thread.id);
    };
    client.on('event', onEvent);
    client.on('failure', onFailure);
    client.on('exit', onFailure);
    // Also handle conventional EventEmitter clients used by embedders/tests.
    client.on('error', onFailure);
    entry = { client, approvalReady: deferred(), approvalVerified: false,
      settingsReady: deferred(), settingsVerified: false, settingsEnabled: Boolean(settingsExtension),
      nativeReady: deferred(), nativeVerified: false, nativeEnabled,
      nativeSignature: JSON.stringify(run.features.tools),
      officialReady: deferred(), officialVerified: false, catalogVersion: this.#officialCatalogVersion, detach: () => {
      client.off('event', onEvent); client.off('failure', onFailure);
      client.off('exit', onFailure); client.off('error', onFailure);
    } };
    this.#clients.set(thread.id, entry);
    return entry;
  }

  #verifySettingsExtension() {
    for (const [name, digest] of Object.entries(SETTINGS_FILES)) {
      const filename = fileURLToPath(new URL(name, import.meta.url)), stat = realFileIfPresent(filename);
      if (!stat || stat.size > 64 * 1024 || createHash('sha256').update(readFileSync(filename)).digest('hex') !== digest) throw error('PI_SETTINGS_UNAVAILABLE', '会话设置扩展完整性校验失败。');
    }
    return fileURLToPath(new URL('./turn-settings-extension.mjs', import.meta.url));
  }

  async #readyClient(thread, entry) {
    await entry.client.start(); await entry.client.getState({ timeoutMs: this.#requestTimeoutMs });
    if (this.officialOnly) {
      await bounded(entry.officialReady.promise, this.#requestTimeoutMs);
      if (!entry.officialVerified) throw error('UNAVAILABLE', '官方模型 Provider 尚未就绪。');
      await entry.client.setModel(OFFICIAL_PROVIDER, thread.models.currentModelId, { timeoutMs: this.#requestTimeoutMs });
    }
    if (entry.settingsEnabled) {
      await bounded(entry.settingsReady.promise, this.#requestTimeoutMs);
      if (!entry.settingsVerified) throw error('PI_SETTINGS_NOT_APPLIED', '会话推理/压缩配置未通过执行器核对，本轮未发送。');
    }
    if (this.#approvalExtension) {
      await bounded(entry.approvalReady.promise, this.#requestTimeoutMs);
      if (!entry.approvalVerified) throw error('UNAVAILABLE', 'Pi 操作确认扩展未就绪。');
    }
    if (entry.nativeEnabled) {
      await bounded(entry.nativeReady.promise, this.#requestTimeoutMs);
      if (!entry.nativeVerified) throw error('UNAVAILABLE', '原生内容及 MCP 映射尚未就绪。');
    }
  }

  async #beforeFileTool(thread, run, toolName, args) {
    if (!this.#fileJournal || !MUTATING_TOOLS.has(toolName)) return;
    const work = (run.journalTail ?? Promise.resolve()).then(async () => {
      await this.#journalReady;
      if (this.#journalFailure) throw error('PI_FILE_UNAVAILABLE', '文件快照组件不可用，本次写入未授权。');
      if (run.abort.signal.aborted) throw error('PI_FILE_CANCELLED', '文件快照已取消。');
      const filename = args?.path ?? args?.file_path;
      this.#claimFileScope(thread.id, toolName === 'bash' ? [thread.cwd] : typeof filename === 'string' ? [resolve(thread.cwd, filename)] : []);
      if (!run.journalStarted) {
        await this.#fileJournal.beginTurn({ threadId: thread.id, turnId: run.turn.id, cwd: thread.cwd });
        run.journalStarted = true;
      }
      await this.#fileJournal.beforeTool({ threadId: thread.id, turnId: run.turn.id, toolName, args, signal: run.abort.signal });
    });
    run.journalTail = work;
    await work;
  }

  #claimFileScope(threadId, paths) {
    const own = this.#fileScopes.get(threadId) ?? [];
    // APFS commonly resolves case/Unicode aliases to one file while realpath
    // retains caller spelling. Fold only lock keys; never rewrite user paths.
    const scopeKey = value => process.platform === 'darwin' ? value.normalize('NFD').toLowerCase() : value;
    const overlap = (left, right) => {
      const a = scopeKey(left), b = scopeKey(right);
      return a === b || a.startsWith(b.endsWith('/') ? b : b + '/') || b.startsWith(a.endsWith('/') ? a : a + '/');
    };
    for (const [other, held] of this.#fileScopes) {
      if (other !== threadId && paths.some(p => held.some(h => overlap(p, h)))) throw error('PI_FILE_SCOPE_BUSY', '其他任务正在修改同一文件或工作目录，请等待其结束后重试。');
    }
    this.#fileScopes.set(threadId, [...new Set([...own, ...paths])]);
  }

  async #performPrompt(thread, run) {
    try {
      const rawInput = run.rawInput;
      const prepared = await prepareTurnInput({ ...rawInput, cwd: thread.cwd, signal: run.abort.signal });
      if (prepared.scenes.length) {
        run.turn.inputContexts = { scenes: prepared.scenes };
        this.#persist();
      }
      const context = await resolveNativeContext({ expert: thread.nativeContext?.expert ?? null, skills: rawInput.skills, signal: run.abort.signal }, { expertConfigDir: this.#expertConfigDir });
      const selected = validateConnectorSelection(thread.nativeContext?.connectors ?? []);
      const tools = this.#nativeServices ? normalizeNativeTools(await this.#nativeServices.listTools({ threadId: thread.id, cwd: thread.cwd, connectors: selected, signal: run.abort.signal }), selected) : [];
      if (selected.length && !this.#nativeServices) throw error('NATIVE_MCP_UNAVAILABLE', '原生 MCP 连接尚未就绪。');
      if (tools.length && !this.#approvalExtension) throw error('UNAVAILABLE', 'MCP 接入需要启用受控的工具授权扩展。');
      if (tools.length && this.officialOnly && this.#officialCatalog.find(model => model.id === thread.models.currentModelId)?.supportsToolCall === false) {
        throw error('NATIVE_TOOLS_UNSUPPORTED', '当前官方模型未声明工具调用能力，请选择支持工具的模型。');
      }
      if (prepared.images.length && this.officialOnly) {
        const selectedModel = this.#officialCatalog.find(model => model.id === thread.models.currentModelId);
        if (!selectedModel?.input?.includes('image')) throw error('NATIVE_IMAGE_UNSUPPORTED', '当前官方模型未声明图片输入能力，请选择支持图片的模型。');
      }
      this.#assertOpen();
      if (!this.#isRun(thread, run) || run.cancelling) return;
      run.input = prepared; run.rawInput = null;
      run.features = { instructions: context.message, tools };
      run.turn.prompt = prepared.summary || run.turn.prompt;
      if (prepared.attachments.length) run.turn.attachments = prepared.attachments;
      if (context.summary) run.turn.nativeContextSummary = context.summary;
      this.#persist();
      this.#writeNativeContext(thread, run);
      const old = this.#clients.get(thread.id);
      const nativeEnabled = Boolean(this.#nativeServices || run.features.instructions || run.features.tools.length);
      if (old && (old.nativeSignature !== JSON.stringify(run.features.tools) || old.nativeEnabled !== nativeEnabled
        || this.officialOnly && old.catalogVersion !== this.#officialCatalogVersion)) await this.#closeClient(thread.id);
      if (!this.#isRun(thread, run) || run.cancelling) return;
      const entry = this.#client(thread, run);
      const { client } = entry;
      await this.#readyClient(thread, entry);
      if (!this.#isRun(thread, run) || run.cancelling) return;
      if (this.officialOnly) this.#writeRequestContext(thread, run.turn);
      run.turn.sessionCheckpoint = this.#sessionCheckpoints.capture({ threadId: thread.id, turnId: run.turn.id });
      this.#persist();
      run.promptSent = true;
      const result = await client.prompt(run.input.message, { images: run.input.images, timeoutMs: this.#requestTimeoutMs });
      if (!this.#isRun(thread, run) || run.cancelling) return;
      // Pi 1.1 acknowledges queued runs before streaming. Only handled commands
      // have no run and therefore no subsequent agent_settled notification.
      if (result?.disposition === 'handled') this.#finish(thread, run, 'completed', 'handled');
    } catch (cause) {
      if (!this.#isRun(thread, run) || run.cancelling) return;
      const safe = /^(?:ATTACHMENT|ATTACHMENTS|TURN_INPUT|PI_CONTEXT|PI_EXPERT|PI_SKILL|PI_SETTINGS|PI_THINKING|PI_COMPACTION|PI_CHECKPOINT|FILE_JOURNAL|NATIVE_)/.test(cause?.code ?? '')
        ? { code: cause.code, message: String(cause.message).slice(0, 512) } : this.officialOnly ? safeOfficialModelError(cause)
        : { code: 'PI_ERROR', message: 'Pi 请求失败，请检查本地模型和 Pi 配置后重试。' };
      this.#finish(thread, run, 'failed', 'error', safe.message, safe.code);
      await this.#closeClient(thread.id);
    }
  }

  #isRun(thread, run) {
    return !this.#closed && !run.finishing && this.#runs.get(thread.id) === run
      && thread.activeTurnId === run.turn.id && ACTIVE.has(run.turn.status);
  }

  #event(thread, record) {
    const run = this.#runs.get(thread.id);
    if (!run || !this.#isRun(thread, run) || !run.promptSent || !record || typeof record !== 'object') return;
    const turn = run.turn;
    if (record.type === 'agent_settled') {
      run.settled.resolve();
      if (run.cancelling || record.aborted) this.#finish(thread, run, 'cancelled', 'cancelled');
      else if (run.failed) this.#finish(thread, run, 'failed', run.failed.stopReason ?? 'error', run.failed.message ?? run.failed, run.failed.code ?? 'PI_ERROR');
      else this.#finish(thread, run, 'completed', 'end_turn');
      return;
    }
    if (run.cancelling) return;
    if (record.type === 'extension_ui_request') {
      if (record.method === 'input' && record.title === NATIVE_TITLE) { void this.#nativeToolCall(thread, run, record); return; }
      this.#approvalRequest(thread, run, record);
      return;
    }
    if (record.type === 'message_start' && record.message?.role === 'assistant') {
      run.currentMessageId = null;
      run.currentThinkingId = null;
      run.currentUsageKey = ++run.assistantSequence;
      run.failed = null;
      return;
    }
    if (record.type === 'message_update' && record.assistantMessageEvent?.type === 'thinking_delta') {
      const delta = record.assistantMessageEvent.delta;
      if (typeof delta !== 'string' || !delta) return;
      const item = this.#thinking(thread, run);
      item.thinking += delta;
      this.#publish('thinking.delta', { threadId: thread.id, turnId: turn.id,
        payload: { id: item.id, delta } });
      return;
    }
    if (record.type === 'message_update' && record.assistantMessageEvent?.type === 'text_delta') {
      const delta = record.assistantMessageEvent.delta;
      if (typeof delta !== 'string' || !delta) return;
      const item = this.#assistant(thread, run);
      item.text += delta;
      this.#publish('message.delta', { threadId: thread.id, turnId: turn.id,
        payload: { id: item.id, messageId: item.id, delta } });
      return;
    }
    if (record.type === 'message_end' && record.message?.role === 'assistant') {
      const message = record.message;
      const text = textFrom(message);
      if (text || run.currentMessageId) {
        const item = this.#assistant(thread, run);
        // message_end is canonical; a final update replaces a partial stream
        // without duplicating its prefix or losing provider-corrected content.
        item.text = text;
        item.status = message.stopReason === 'error' ? 'failed' : 'completed';
        this.#item('message.updated', thread, turn, item);
      }
      if (message.stopReason === 'error') run.failed = this.officialOnly
        ? safeOfficialModelError(message.errorMessage)
        : '本地模型返回错误，请检查模型服务后重试。';
      else if (message.stopReason === 'length') run.failed = TRUNCATED_RESPONSE;
      else if (message.stopReason === 'stop' && !text.trim()
        && !(message.content ?? []).some(part => part?.type === 'toolCall')) {
        run.failed = { code: 'PI_EMPTY_RESPONSE', message: '模型结束了本轮请求，但没有返回可显示的正文。已有工具结果已保留，请继续总结或重试。' };
      }
      const thinking = (message.content ?? []).filter(part => part?.type === 'thinking' && !part.redacted
        && typeof part.thinking === 'string').map(part => part.thinking).join('');
      if (thinking || run.currentThinkingId) {
        const item = this.#thinking(thread, run);
        item.thinking = thinking;
        item.status = message.stopReason === 'error' ? 'failed' : 'completed';
        this.#item('thinking.updated', thread, turn, item);
      }
      this.#usage(thread, run, message.usage);
      run.currentMessageId = null;
      run.currentThinkingId = null;
      run.currentUsageKey = null;
      this.#persist();
      return;
    }
    if (record.type === 'auto_retry_end' && record.success === false) {
      run.failed ??= this.officialOnly ? safeOfficialModelError(record.finalError) : '本地模型重试失败，请检查模型服务后重试。';
      return;
    }
    if (record.type?.startsWith('tool_execution_')) {
      const toolId = record.toolCallId;
      if (typeof toolId !== 'string' || !toolId) return;
      let item = turn.items.find(candidate => candidate.type === 'tool' && candidate.id === toolId);
      if (!item) {
        item = { id: toolId, type: 'tool', name: record.toolName ?? 'read',
          title: run.features.tools.find(tool => tool.name === record.toolName)?.label ?? record.toolName ?? 'read', status: 'running', input: clone(record.args ?? null), output: null };
        turn.items.push(item);
        this.#item('tool.created', thread, turn, item);
      }
      if (record.type === 'tool_execution_update') item.output = clone(record.partialResult ?? null);
      if (record.type === 'tool_execution_end') {
        item.output = clone(record.result ?? null);
        item.status = record.isError ? 'failed' : 'completed';
        if (run.journalStarted) {
          run.journalTail = (run.journalTail ?? Promise.resolve()).then(() => this.#fileJournal.afterTool({ threadId: thread.id, turnId: run.turn.id }))
            .then(manifest => this.#publish('files.updated', { threadId: thread.id, payload: fileUpdatePayload(manifest?.changes) }));
          // Failures are reported when the round settles; never authorize another mutation after a failed snapshot.
          void run.journalTail.catch(() => {});
        }
      }
      this.#item('tool.updated', thread, turn, item);
      this.#persist();
    }
  }

  async #approvalRequest(thread, run, record) {
    if (!['confirm', 'select', 'input', 'editor'].includes(record.method)) return;
    const client = this.#clients.get(thread.id)?.client;
    let metadata;
    try { metadata = JSON.parse(record.message); } catch { /* Reject unknown UI requests below. */ }
    if (!this.#approvalExtension || record.method !== 'confirm' || record.title !== APPROVAL_TITLE
      || typeof record.id !== 'string' || !record.id || metadata?.protocol !== APPROVAL_PROTOCOL
      || typeof metadata.toolCallId !== 'string' || !metadata.toolCallId
      || !(MUTATING_TOOLS.has(metadata.toolName) && this.tools.includes(metadata.toolName)
        || run.features.tools.some(tool => tool.name === metadata.toolName))
      || !metadata.input || typeof metadata.input !== 'object' || Array.isArray(metadata.input)
      || run.authorizationRequestIds.has(record.id)
      || [...this.#pendingInteractions.values()].some(pending => pending.uiId === record.id)) {
      if (record.method === 'confirm' && typeof record.id === 'string'
        && typeof client?.sendExtensionUiResponse === 'function') {
        void client.sendExtensionUiResponse({ id: record.id, confirmed: false }).catch(() => {});
      }
      this.#finish(thread, run, 'failed', 'error', 'Pi 收到不受支持的操作确认，本轮已停止。');
      void this.#closeClient(thread.id);
      return;
    }
    run.authorizationRequestIds.add(record.id);
    const interaction = {
      id: `pi-interaction-${randomUUID()}`, type: 'permission', status: 'pending',
      title: `是否允许 Pi 执行 ${run.features.tools.find(tool => tool.name === metadata.toolName)?.label ?? metadata.toolName}？`,
      description: JSON.stringify(metadata.input, null, 2),
      toolItemId: metadata.toolCallId, toolName: metadata.toolName,
      toolCall: { id: metadata.toolCallId, name: metadata.toolName, input: clone(metadata.input) },
      options: [
        { id: 'allow-once', kind: 'allow_once', label: '允许一次' },
        { id: 'reject', kind: 'reject_once', label: '拒绝' },
      ],
      requestedAt: now(), respondedAt: null, response: null,
    };
    if ((thread.approvalMode ?? this.defaultApprovalMode) === 'auto') {
      try {
        if (MUTATING_TOOLS.has(metadata.toolName)) await this.#beforeFileTool(thread, run, metadata.toolName, metadata.input);
        if (!this.#isRun(thread, run) || run.cancelling) return;
      } catch (cause) {
        void client.sendExtensionUiResponse({ id: record.id, confirmed: false }).catch(() => {});
        this.#finish(thread, run, 'failed', 'error', cause.code === 'PI_FILE_SCOPE_BUSY' ? cause.message : '文件快照未能安全完成，本次操作未授权。', cause.code === 'PI_FILE_SCOPE_BUSY' ? cause.code : 'PI_FILE_SNAPSHOT_FAILED');
        void this.#closeClient(thread.id); return;
      }
      interaction.status = 'approved'; interaction.respondedAt = now();
      interaction.response = { decision: 'allow-once' }; interaction.authorizationSource = 'automatic';
      run.turn.interactions.push(interaction);
      if (run.features.tools.some(tool => tool.name === metadata.toolName)) {
        run.approvedNative.set(`${metadata.toolCallId}\0${metadata.toolName}`, JSON.stringify(metadata.input));
      }
      this.#persist();
      void client.sendExtensionUiResponse({ id: record.id, confirmed: true }).catch(() => {
        if (!this.#isRun(thread, run) || run.cancelling) return;
        this.#finish(thread, run, 'failed', 'error', '自动授权无法送达 Pi，本轮已停止。');
        void this.#closeClient(thread.id);
      });
      return;
    }
    const pending = { uiId: record.id, interaction, thread, run, client };
    this.#pendingInteractions.set(interaction.id, pending);
    run.turn.interactions.push(interaction);
    run.turn.status = 'waiting_for_approval';
    thread.status = 'waiting_for_approval';
    thread.updatedAt = interaction.requestedAt;
    const item = run.turn.items.find(item => item.type === 'tool' && item.id === metadata.toolCallId);
    if (item) {
      item.status = 'awaiting_approval';
      this.#item('tool.updated', thread, run.turn, item);
    }
    const timeout = Number.isSafeInteger(record.timeout) && record.timeout > 0
      ? Math.min(this.#approvalTimeoutMs, record.timeout) : this.#approvalTimeoutMs;
    pending.timer = setTimeout(() => {
      if (!this.#pendingInteractions.has(interaction.id)) return;
      this.#resolveInteraction(pending, 'rejected', 'timeout');
      void client.sendExtensionUiResponse({ id: record.id, confirmed: false }).catch(() => {
        this.#finish(thread, run, 'failed', 'error', 'Pi 操作确认超时且无法撤回，本轮已停止。');
        void this.#closeClient(thread.id);
      });
    }, timeout);
    pending.timer.unref?.();
    this.#persist();
    this.#publish('interaction.requested', { threadId: thread.id, turnId: run.turn.id,
      interactionId: interaction.id, payload: this.#interactionPayload(interaction) });
  }

  async #nativeToolCall(thread, run, record) {
    if (typeof record.id === 'string' && run.nativeCallRequestIds.has(record.id)) return;
    const client = this.#clients.get(thread.id)?.client;
    const respond = value => client?.sendExtensionUiResponse({ id: record.id, value: JSON.stringify(value) }).catch(() => {});
    try {
      if (!this.#isRun(thread, run) || run.cancelling || typeof record.id !== 'string'
        || typeof record.placeholder !== 'string' || record.placeholder.length > 48 * 1024) throw error('NATIVE_MCP_INVALID', 'Invalid native call');
      run.nativeCallRequestIds.add(record.id);
      const value = JSON.parse(record.placeholder);
      const tool = run.features.tools.find(tool => tool.name === value.name);
      const key = `${value.toolCallId}\0${value.name}`;
      if (!tool || value.protocol !== NATIVE_CALL || value.threadId !== thread.id || value.turnId !== run.turn.id
        || run.approvedNative.get(key) !== JSON.stringify(value.arguments)) throw error('NATIVE_MCP_NOT_APPROVED', 'Native tool not approved');
      // Consume before the external call. Timeout, disconnect, or restart must
      // never retry a potentially side-effecting operation.
      run.approvedNative.delete(key);
      const result = await this.#nativeServices.callTool({ threadId: thread.id, turnId: run.turn.id,
        cwd: thread.cwd,
        connectors: thread.nativeContext?.connectors ?? [], serverId: tool.serverId, rawName: tool.rawName,
        arguments: value.arguments, signal: run.abort.signal });
      if (!this.#isRun(thread, run) || run.cancelling || run.abort.signal.aborted) return;
      if (Buffer.byteLength(JSON.stringify(result ?? null)) > 256 * 1024) throw error('NATIVE_MCP_RESULT_LIMIT', 'Native result too large');
      await respond({ ok: true, result: result ?? null });
    } catch (cause) {
      if (!run.cancelling) await respond({ ok: false, code: cause?.mayHaveExecuted ? 'NATIVE_MCP_OUTCOME_UNKNOWN' : 'NATIVE_MCP_CALL_FAILED' });
    }
  }

  #interactionPayload(interaction) {
    return { ...clone(interaction), interactionId: interaction.id, kind: 'approval' };
  }

  #resolveInteraction(pending, status, reason) {
    this.#pendingInteractions.delete(pending.interaction.id);
    clearTimeout(pending.timer);
    const { interaction, thread, run } = pending;
    interaction.status = status;
    interaction.response = status === 'approved' ? { decision: 'allow-once' } : { decision: 'reject' };
    interaction.respondedAt = now();
    if (status === 'approved' && run.features.tools.some(tool => tool.name === interaction.toolName)) {
      run.approvedNative.set(`${interaction.toolCall.id}\0${interaction.toolName}`, JSON.stringify(interaction.toolCall.input));
    }
    if (reason) interaction.reason = reason;
    if (ACTIVE.has(run.turn.status)) {
      const stillWaiting = [...this.#pendingInteractions.values()].some(entry => entry.run === run);
      run.turn.status = stillWaiting ? 'waiting_for_approval' : 'running';
      thread.status = run.turn.status;
      thread.updatedAt = interaction.respondedAt;
    }
    const item = run.turn.items.find(item => item.type === 'tool' && item.id === interaction.toolItemId);
    if (item?.status === 'awaiting_approval') {
      item.status = status === 'approved' ? 'running' : status === 'cancelled' ? 'cancelled' : 'denied';
      this.#item('tool.updated', thread, run.turn, item);
    }
    this.#persist();
    this.#publish('interaction.resolved', { threadId: thread.id, turnId: run.turn.id,
      interactionId: interaction.id, payload: this.#interactionPayload(interaction) });
  }

  #cancelPendingInteractions(thread, run) {
    for (const pending of [...this.#pendingInteractions.values()]) {
      if (pending.thread !== thread || pending.run !== run) continue;
      this.#resolveInteraction(pending, 'cancelled');
      void pending.client.sendExtensionUiResponse({ id: pending.uiId, confirmed: false }).catch(() => {});
    }
  }

  #assistant(thread, run) {
    let item = run.turn.items.find(candidate => candidate.id === run.currentMessageId);
    if (!item) {
      run.currentMessageId = `${run.turn.id}-assistant-${++run.messageSequence}`;
      item = { id: run.currentMessageId, type: 'text', role: 'assistant', text: '', status: 'streaming' };
      run.turn.items.push(item);
      this.#item('message.created', thread, run.turn, item);
    }
    return item;
  }

  #thinking(thread, run) {
    let item = run.turn.items.find(candidate => candidate.id === run.currentThinkingId);
    if (!item) {
      run.currentThinkingId = `${run.turn.id}-thinking-${++run.thinkingSequence}`;
      item = { id: run.currentThinkingId, type: 'thinking', thinking: '', status: 'streaming' };
      run.turn.items.push(item);
      this.#item('thinking.created', thread, run.turn, item);
    }
    return item;
  }

  #usage(thread, run, usage) {
    if (!usage || typeof usage !== 'object') return;
    const keys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'reasoning'];
    const safe = Object.fromEntries(keys.filter(key => Number.isFinite(usage[key]) && usage[key] >= 0)
      .map(key => [key, usage[key]]));
    if (!Object.keys(safe).length) return;
    run.usageSnapshots.set(run.currentUsageKey ?? ++run.assistantSequence, safe);
    const total = { costKnown: false };
    for (const key of keys) {
      const values = [...run.usageSnapshots.values()].map(value => value[key]);
      if (values.every(value => value !== undefined)) total[key] = values.reduce((sum, value) => sum + value, 0);
    }
    run.turn.usage = total;
    this.#publish('turn.usage', { threadId: thread.id, turnId: run.turn.id, payload: { usage: clone(total) } });
  }

  #item(type, thread, turn, item) {
    this.#publish(type, { threadId: thread.id, turnId: turn.id,
      payload: { ...clone(item), ...(item.type === 'text' ? { messageId: item.id }
        : item.type === 'tool' ? { toolCallId: item.id } : {}) } });
  }

  #finish(thread, run, status, stopReason, message, code = 'PI_ERROR') {
    if (run.finishing) return run.finishPromise;
    if (run.journalTail || run.journalStarted) {
      run.finishing = true; run.abort?.abort();
      run.finishPromise = (async () => {
        await run.journalTail?.catch(() => {});
        try {
          const manifest = run.journalStarted ? await this.#fileJournal.finishTurn({ threadId: thread.id, turnId: run.turn.id, status }) : undefined;
          this.#publish('files.updated', { threadId: thread.id, payload: fileUpdatePayload(manifest?.changes) });
        } catch {
          status = 'failed'; stopReason = 'error'; code = 'PI_FILE_JOURNAL_FAILED';
          message = '任务已停止，但文件记录未完整保存；文件未自动回退，请检查工作目录。';
        }
        this.#completeTurn(thread, run, status, stopReason, message, code);
      })();
      return run.finishPromise;
    }
    return this.#completeTurn(thread, run, status, stopReason, message, code);
  }

  #completeTurn(thread, run, status, stopReason, message, code = 'PI_ERROR') {
    run.abort?.abort();
    run.approvedNative?.clear();
    run.input = null; run.rawInput = null;
    const turn = run.turn;
    if (!ACTIVE.has(turn.status)) return;
    this.#fileScopes.delete(thread.id);
    this.#cancelPendingInteractions(thread, run);
    turn.status = status;
    turn.stopReason = stopReason;
    turn.completedAt = now();
    if (message) turn.error = { code, message };
    const diagnostic = appendOutcomeDiagnostic(turn);
    if (diagnostic) this.#item('message.created', thread, turn, diagnostic);
    for (const item of turn.items) {
      if (['streaming', 'running', 'pending', 'awaiting_approval'].includes(item.status)) {
        item.status = status === 'completed' ? 'completed' : status;
        this.#item(item.type === 'text' ? 'message.updated' : item.type === 'thinking' ? 'thinking.updated' : 'tool.updated', thread, turn, item);
      }
    }
    thread.activeTurnId = null;
    thread.status = 'idle';
    thread.updatedAt = turn.completedAt;
    run.settled.resolve();
    this.#persist();
    this.#publish(status === 'failed' ? 'turn.failed' : status === 'completed' ? 'turn.completed' : 'turn.cancelled', {
      threadId: thread.id, turnId: turn.id, payload: { turn: clone(turn),
        ...(turn.error ? { error: clone(turn.error) } : {}) },
    });
    if (!this.#closed && !run.cancelling) void this.refreshContextUsage({ threadId: thread.id, allowCold: false }).catch(() => {});
  }

  async #closeClient(threadId) {
    const entry = this.#clients.get(threadId);
    if (!entry) return;
    this.#closingThreads.add(threadId);
    this.#clients.delete(threadId);
    entry.approvalReady.resolve();
    entry.nativeReady.resolve();
    entry.officialReady.resolve();
    entry.detach();
    const closed = await bounded(entry.client.close(), this.#cancelTimeoutMs + 3_500);
    if (!closed) this.#blockedThreads.add(threadId);
    this.#closingThreads.delete(threadId);
  }

  #load() {
    const stat = realFileIfPresent(this.#stateFile);
    if (!stat) return;
    if (stat.size > MAX_STATE_BYTES) throw error('UNAVAILABLE', 'Pi 任务记录超过安全读取限制。');
    let value;
    try { value = JSON.parse(readFileSync(this.#stateFile, 'utf8')); }
    catch { throw error('UNAVAILABLE', 'Pi 任务记录无法读取，请保留原文件后检查。'); }
    if (value?.version !== STATE_VERSION || !Array.isArray(value.threads)) {
      throw error('UNAVAILABLE', 'Pi 任务记录版本或格式不受支持。');
    }
    let changed = false, repairedOutcome = false;
    for (const thread of value.threads) {
      if (!thread || !ID.test(thread.id) || typeof thread.title !== 'string'
        || typeof thread.cwd !== 'string' || !isAbsolute(thread.cwd) || !Array.isArray(thread.turns)
        || this.#threads.has(thread.id)) throw error('UNAVAILABLE', 'Pi 任务记录格式无效。');
      if (thread.contextWindows !== undefined && (!thread.contextWindows || Array.isArray(thread.contextWindows)
        || typeof thread.contextWindows !== 'object' || Object.keys(thread.contextWindows).length > 128
        || Object.entries(thread.contextWindows).some(([id, value]) => !id || id.length > 256 || /[\x00-\x1f]/.test(id)
          || !Number.isSafeInteger(value) || value <= 1 || value > 20_000_000))) throw error('UNAVAILABLE', 'Pi 会话上下文配置无效。');
      if (thread.thoughtLevels !== undefined && (!thread.thoughtLevels || Array.isArray(thread.thoughtLevels)
        || Object.keys(thread.thoughtLevels).length > 128 || Object.entries(thread.thoughtLevels).some(([id, value]) => !id || id.length > 256
          || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)))) throw error('UNAVAILABLE', 'Pi 推理档位记录无效。');
      if (thread.preMessageCompactPct !== undefined && thread.preMessageCompactPct !== null
        && (typeof thread.preMessageCompactPct !== 'number' || !Number.isFinite(thread.preMessageCompactPct) || thread.preMessageCompactPct < 0 || thread.preMessageCompactPct > 100)) throw error('UNAVAILABLE', 'Pi 压缩阈值记录无效。');
      for (const turn of thread.turns) {
        if (typeof turn?.id !== 'string' || turn.threadId !== thread.id || typeof turn.prompt !== 'string'
          || !Array.isArray(turn.items)) throw error('UNAVAILABLE', 'Pi 轮次记录格式无效。');
        if (ACTIVE.has(turn.status)) {
          turn.status = 'interrupted'; turn.stopReason = 'runtime_interrupted'; turn.completedAt = now();
          for (const item of turn.items) {
            if (['streaming', 'running', 'pending', 'awaiting_approval'].includes(item.status)) item.status = 'interrupted';
          }
          changed = true;
        }
        turn.interactions ??= [];
        for (const interaction of turn.interactions) {
          if (interaction?.status === 'pending') {
            interaction.status = 'cancelled'; interaction.respondedAt = now();
            interaction.reason = 'runtime_interrupted'; changed = true;
          }
        }
      }
      const last = thread.turns.at(-1);
      if (legacyTruncatedOutcome(this.#sessionFile(thread), last)) {
        last.status = 'failed'; last.stopReason = 'length';
        last.error = { code: TRUNCATED_RESPONSE.code, message: TRUNCATED_RESPONSE.message };
        appendOutcomeDiagnostic(last);
        changed = true; repairedOutcome = true;
      }
      thread.harnessId = this.id;
      thread.nativeSessionId = thread.id;
      if (thread.workspaceAutoGenerated === undefined) {
        thread.workspaceAutoGenerated = thread.cwd === this.cwd;
        changed = true;
      } else if (typeof thread.workspaceAutoGenerated !== 'boolean') throw error('UNAVAILABLE', 'Pi workspace metadata is invalid');
      const sameProvider = thread.provider === this.provider;
      thread.provider = this.provider;
      // Legacy state may have only currentModelId, or null after an older
      // temporary catalog miss. With no recoverable preference, retry the
      // configured default alias; never infer a selection from turn history.
      const requestedModelId = sameProvider
        ? thread.models?.requestedModelId ?? thread.models?.currentModelId ?? this.model : this.model;
      thread.models = this.#models(requestedModelId);
      thread.activeTurnId = null;
      thread.status = thread.pendingRewind ? 'error' : 'idle';
      if (thread.pendingRewind) this.#blockedThreads.add(thread.id);
      this.#threads.set(thread.id, thread);
    }
    chmodSync(this.#stateFile, 0o600);
    if (repairedOutcome) {
      const backups = join(this.stateDir, 'migration-backups');
      privateDirectory(backups);
      const backup = join(backups, `turn-outcome-0.4.1-${randomUUID()}.json`);
      copyFileSync(this.#stateFile, backup, constants.COPYFILE_EXCL);
      chmodSync(backup, 0o600);
    }
    if (changed) this.#persist();
  }

  #persist() {
    realFileIfPresent(this.#stateFile);
    const temp = join(this.stateDir, `.threads-${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
        | (constants.O_NOFOLLOW ?? 0), 0o600);
      writeFileSync(descriptor, JSON.stringify({ version: STATE_VERSION, threads: [...this.#threads.values()] }));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temp, this.#stateFile);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temp)) rmSync(temp, { force: true });
    }
  }
}
