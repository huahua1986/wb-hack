import { createRendererMessageRouter } from "./protocol.js";

export const DEFAULT_BINDING_NAME = "__workbuddyPiBinding";
export const DEFAULT_RENDERER_GLOBAL = "__workbuddyPi";
export const DEFAULT_ROOT_ID = "workbuddy-pi-root";
export const SUPPORTED_WORKBUDDY_VERSION = "5.11.1";
export const SUPPORTED_WORKBUDDY_VERSIONS = Object.freeze(["5.9.2", SUPPORTED_WORKBUDDY_VERSION, "5.11.2", "5.11.3"]);

/** Shared by the Electron preflight and the injected renderer. */
export function readWorkBuddyRendererIdentity() {
  const document = globalThis.document;
  const body = document?.body;
  const userAgentVersion = globalThis.navigator?.userAgent?.match(
    /(?:WorkBuddy|CodeBuddy)[\/ ]([0-9]+(?:\.[0-9]+){1,3}(?:[-+][\w.-]+)?)/i,
  )?.[1];
  return {
    name: body?.dataset?.applicationName,
    desktop: body?.dataset?.electronDesktop,
    version: [globalThis.workbuddyDesktop?.appVersion, body?.dataset?.appVersion,
      document?.documentElement?.dataset?.appVersion,
      document?.querySelector?.('meta[name="app-version"]')?.content, userAgentVersion]
      .find(value => typeof value === "string" && value.length > 0),
  };
}

/** Runs inside WorkBuddy's main renderer; keep it self-contained. */
function installRenderer(config) {
  if (globalThis.top !== globalThis.self) return;

  const previous = globalThis[config.globalName];
  if (
    previous?.version === config.version
    && previous?.bindingName === config.bindingName
    && previous?.exclusive === config.exclusive
    && previous?.officialModels === config.officialModels
    && previous?.nativeUi === config.nativeUi
  ) {
    if (!config.nativeUi) previous.show?.();
    return;
  }
  let previousCleanup = Promise.resolve();
  try {
    previousCleanup = Promise.resolve(previous?.dispose?.()).catch(() => undefined);
  } catch {
    // A stale injection must not prevent a new nonce-bound owner from starting.
  }

  const state = {
    disposed: false,
    status: "booting",
    error: undefined,
    waitReason: undefined,
    bootRetryResolve: undefined,
    wb: undefined,
    originalConversations: undefined,
    mux: undefined,
    releaseListProgress: undefined,
    controlStyle: undefined,
    modelSelectorNode: undefined,
    modelSelectorListeners: [],
    modelSelectorSyncScheduled: false,
    modelPopoverNode: undefined,
    releaseModelPopoverGuards: undefined,
    releasePreviewStatus: undefined,
    modelSwitchBusy: false,
    sourceSwitchObserver: undefined,
    sourceSwitchNode: undefined,
    officeRestoreNode: undefined,
    officeRestorePending: false,
    sourceSwitchListeners: [],
    sourceSwitchSyncScheduled: false,
    sourceSwitchBusy: 0,
    sourceSwitchQueue: Promise.resolve(),
    contextUsageObserver: undefined,
    contextUsageTipScheduled: false,
    contextUsageTips: new Map(),
    externalCreatePending: false,
    exclusiveComposerPromise: undefined,
    releaseExternalCreateIntent: undefined,
    navigationOperations: new Set(),
    disposePromise: undefined,
    bootTimer: undefined,
    announceTimers: [],
    harnesses: new Map(),
    threads: new Map(),
    conversations: new Map(),
    requestIdByTurn: new Map(),
    activeRequestByThread: new Map(),
    pinnedExternalIds: [],
    pendingEvents: [],
    lastEventSequence: 0,
    selectedHarnessId: undefined,
    activeThreadId: undefined,
    lastNativeConversationId: undefined,
    lastExternalId: undefined,
    uiStateQueue: Promise.resolve(),
    uiStateRequestedKey: undefined,
    uiStateRequestedPromise: undefined,
  };

  let router;
  let readyPromise;
  let api;

  function ownsRendererLifecycle() {
    return !state.disposed && globalThis[config.globalName] === api;
  }

  function assertRendererLifecycle() {
    if (!ownsRendererLifecycle()) {
      throw new Error("WorkBuddy Host renderer no longer owns source navigation");
    }
  }

  const LIST_CHANGED = "wb:conversations:listChanged";
  const STATE_CHANGED = "wb:conversation:stateChange";
  const INFO_CHANGED = "wb:conversation:infoChange";
  const PINNED = "wb:conversation:pinned";
  const UNPINNED = "wb:conversation:unpinned";
  const PINS_REORDERED = "wb:conversation:pinsReordered";

  function bridgeBinding() {
    const binding = globalThis[config.bindingName];
    if (typeof binding !== "function") throw new Error("WorkBuddy Host bridge is unavailable");
    return binding;
  }

  function rpc(method, params = {}) {
    if (new TextEncoder().encode(JSON.stringify(params)).byteLength > 60 * 1024) return Promise.reject(new Error("输入或配置元数据超过 60 KiB，请减少选区或附件数量"));
    return router.request(method, params, (payload) => bridgeBinding()(payload));
  }

  function persistUiState(patch) {
    const key = JSON.stringify(patch);
    if (state.uiStateRequestedKey === key && state.uiStateRequestedPromise) {
      return state.uiStateRequestedPromise;
    }
    // Sidebar navigation and the explicit source switch can observe the same
    // route. Serialize distinct selections and share repeated writes so DOM
    // changes cannot flood the Host or let an older selection win the race.
    const operation = state.uiStateQueue.then(() => {
      assertRendererLifecycle();
      return rpc("ui.update", patch);
    }).catch((error) => {
      if (state.uiStateRequestedPromise === operation) state.uiStateRequestedKey = undefined;
      throw error;
    });
    state.uiStateQueue = operation.catch(() => undefined);
    state.uiStateRequestedKey = key;
    state.uiStateRequestedPromise = operation;
    return operation;
  }

  function persistCurrentExternalRoute() {
    const local = state.conversations.get(currentRouteId());
    if (!local) return Promise.resolve();
    state.selectedHarnessId = local.harnessId;
    state.activeThreadId = local.threadId;
    return persistUiState({
      active: true,
      activeThreadId: local.threadId,
      selectedHarnessId: local.harnessId,
    });
  }

  function toTimestamp(value, fallback = Date.now()) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value ?? ""));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function textFrom(value) {
    if (typeof value === "string") return value;
    if (value == null) return "";
    if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join("\n");
    if (typeof value === "object") {
      const nested = value.text ?? value.content ?? value.delta ?? value.output ?? value.message;
      if (nested !== undefined && nested !== value) return textFrom(nested);
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function safeMcpErrorMessage(error) {
    const messages = {
      WB_CONNECTOR_MANAGER_UNAVAILABLE: "WorkBuddy Connector Manager is unavailable",
      WB_MCP_INVALID_PARAMS: "WorkBuddy MCP tool name and object arguments are required",
      WB_MCP_TOOL_NOT_ALLOWED: "WorkBuddy MCP tool is unavailable or not allowed",
      WB_TOOL_CALL_FAILED: "WorkBuddy MCP tool failed, is disconnected, or requires authorization",
      WB_RENDERER_RPC_INVALID: "Invalid WorkBuddy renderer RPC request",
      WB_RENDERER_RPC_METHOD_NOT_FOUND: "Unsupported WorkBuddy renderer RPC method",
    };
    return messages[error?.code] ?? "WorkBuddy MCP request failed";
  }

  function stableToolHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function stableMessageId(value) {
    const source = String(value ?? "message");
    if (/^[0-9a-f]{32}$/i.test(source) || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(source)) {
      return source;
    }
    const parts = [];
    for (let salt = 0; salt < 4; salt += 1) {
      let hash = (2166136261 ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
      for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      parts.push((hash >>> 0).toString(16).padStart(8, "0"));
    }
    return parts.join("");
  }

  function safeToolPart(value) {
    return String(value ?? "tool")
      .normalize("NFKC")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      || "tool";
  }

  function externalToolName(record) {
    const identity = `${record.sourceType}\u0000${record.sourceId}\u0000${record.rawName}`;
    const readable = `workbuddy_${safeToolPart(record.sourceId)}_${safeToolPart(record.rawName)}`;
    return `${readable.slice(0, 100)}_${stableToolHash(identity)}`;
  }

  function safeToolInputSchema(value) {
    if (!isPlainObject(value)) return { type: "object", additionalProperties: true };
    try {
      const serialized = JSON.stringify(value);
      if (new TextEncoder().encode(serialized).byteLength > 32 * 1024) {
        return { type: "object", additionalProperties: true };
      }
      return JSON.parse(serialized);
    } catch {
      return { type: "object", additionalProperties: true };
    }
  }

  async function workBuddyMcpContract() {
    const startedAt = Date.now();
    while (ownsRendererLifecycle()) {
      const manager = globalThis.__GENIE_DEFAULT_APP_PROVIDERS__?.connectorManager;
      if (
        manager
        && typeof manager.getStates === "function"
      ) {
        return { manager, connectors: globalThis.wb?.connectors };
      }
      if (Date.now() - startedAt >= 10_000) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const error = new Error("WorkBuddy Connector Manager is unavailable");
    error.code = "WB_CONNECTOR_MANAGER_UNAVAILABLE";
    throw error;
  }

  function isConnectedConnectorState(connectorState) {
    return connectorState?.bound === true
      && connectorState?.enabled === true
      && (connectorState.connected === true || connectorState.status === "connected");
  }

  async function workBuddyConnectorStates(manager, connectors) {
    let states;
    if (typeof connectors?.states === "function") {
      try {
        states = await connectors.states({ buddyAppScope: "ignore" });
      } catch {}
    }
    if (!states || typeof states !== "object" || Array.isArray(states)) {
      states = await manager.getStates();
    }
    return !states || typeof states !== "object" || Array.isArray(states) ? {} : states;
  }

  async function managedWorkBuddyTools(states) {
    const records = [];
    for (const [key, connectorState] of Object.entries(states)) {
      if (
        !isConnectedConnectorState(connectorState)
      ) continue;
      const sourceId = String(
        connectorState.connectorId ?? connectorState.configId ?? key,
      ).trim();
      if (!sourceId) continue;
      for (const tool of Array.isArray(connectorState.tools) ? connectorState.tools : []) {
        const rawName = typeof tool?.name === "string" ? tool.name.trim() : "";
        if (!rawName) continue;
        records.push({
          sourceType: "managed",
          sourceId,
          rawName,
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema: safeToolInputSchema(tool.inputSchema),
        });
      }
    }
    return records;
  }

  async function activeWorkBuddyCliConnectors(manager, states) {
    if (typeof manager?.getConfigs !== "function") return [];
    let configs;
    try {
      configs = await manager.getConfigs();
    } catch {
      return [];
    }
    if (!Array.isArray(configs)) return [];
    const configsById = new Map(configs.map((config) => [config?.id, config]));
    const connectors = [];
    for (const [key, connectorState] of Object.entries(states)) {
      if (
        !isConnectedConnectorState(connectorState)
      ) continue;
      const id = String(
        connectorState.connectorId ?? connectorState.configId ?? key,
      ).replace(/^connector:/, "").trim();
      if (!id) continue;
      const config = configsById.get(id);
      if (config?.type !== "cli" && config?.mcpConfig?.type !== "cli") continue;
      connectors.push({
        id,
        name: typeof config.name === "string" ? config.name : id,
        type: "cli",
      });
    }
    return connectors.sort((left, right) => left.id.localeCompare(right.id));
  }

  async function customWorkBuddyTools(connectors) {
    if (typeof connectors?.listCustomMcpServers !== "function") return [];
    let servers;
    try {
      servers = await connectors.listCustomMcpServers();
    } catch {
      return [];
    }
    if (!Array.isArray(servers)) return [];

    const records = [];
    for (const server of servers) {
      if (
        server?.status !== "connected"
        || server.disabled === true
        || server.trustLevel === "black"
      ) continue;
      const sourceId = String(server.name ?? server.id ?? "").trim();
      if (!sourceId) continue;
      for (const tool of Array.isArray(server.tools) ? server.tools : []) {
        if (tool?.enabled === false) continue;
        const rawName = typeof tool?.name === "string" ? tool.name.trim() : "";
        if (!rawName) continue;
        records.push({
          sourceType: "custom",
          sourceId,
          rawName,
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema: safeToolInputSchema(tool.inputSchema),
        });
      }
    }
    return records;
  }

  async function workBuddyMcpAllowlist() {
    const { manager, connectors } = await workBuddyMcpContract();
    const states = await workBuddyConnectorStates(manager, connectors);
    const records = typeof manager.callTool === "function"
      ? [
          ...await managedWorkBuddyTools(states),
          ...await customWorkBuddyTools(connectors),
        ]
      : [];
    const uniqueRecords = [...new Map(records.map((record) => [
      `${record.sourceType}\u0000${record.sourceId}\u0000${record.rawName}`,
      record,
    ])).values()];
    const rawCounts = new Map();
    const rawNames = new Set();
    for (const record of uniqueRecords) {
      rawNames.add(record.rawName);
      rawCounts.set(record.rawName, (rawCounts.get(record.rawName) ?? 0) + 1);
    }

    const candidates = [];
    for (const record of uniqueRecords) {
      const duplicated = rawCounts.get(record.rawName) > 1;
      const callPrefix = record.sourceType === "custom"
        ? `custom-mcp:${record.sourceId}`
        : record.sourceId.replace(/^connector:/, "");
      const internalCallName = duplicated
        ? `${callPrefix}_${record.rawName}`
        : record.rawName;
      if (duplicated && rawNames.has(internalCallName)) continue;
      candidates.push({ ...record, internalCallName });
    }
    const internalCounts = new Map();
    for (const record of candidates) {
      internalCounts.set(
        record.internalCallName,
        (internalCounts.get(record.internalCallName) ?? 0) + 1,
      );
    }

    const allowlist = new Map();
    for (const record of candidates.sort((left, right) => (
      `${left.sourceType}:${left.sourceId}:${left.rawName}`
        .localeCompare(`${right.sourceType}:${right.sourceId}:${right.rawName}`)
    ))) {
      if (internalCounts.get(record.internalCallName) !== 1) continue;
      let name = externalToolName(record);
      let suffix = 1;
      while (allowlist.has(name)) name = `${externalToolName(record).slice(0, 112)}_${++suffix}`;
      allowlist.set(name, { ...record, name });
    }
    return { manager, allowlist, states };
  }

  async function listWorkBuddyMcpTools() {
    const { manager, allowlist, states } = await workBuddyMcpAllowlist();
    return {
      tools: [...allowlist.values()].map((record) => ({
        name: record.name,
        description: [
          record.description,
          `通过 WorkBuddy 连接器 ${record.sourceId} 调用；可能产生外部副作用。`,
        ].filter(Boolean).join("\n\n"),
        inputSchema: record.inputSchema,
      })),
      cliConnectors: await activeWorkBuddyCliConnectors(manager, states),
    };
  }

  async function callWorkBuddyMcpTool(params) {
    const name = params?.name;
    const arguments_ = params?.arguments ?? {};
    if (typeof name !== "string" || !isPlainObject(arguments_)) {
      const error = new Error("WorkBuddy MCP tool name and object arguments are required");
      error.code = "WB_MCP_INVALID_PARAMS";
      throw error;
    }
    const { manager, allowlist } = await workBuddyMcpAllowlist();
    const allowed = allowlist.get(name);
    if (!allowed) {
      const error = new Error(`WorkBuddy MCP tool is unavailable or not allowed: ${name}`);
      error.code = "WB_MCP_TOOL_NOT_ALLOWED";
      throw error;
    }
    const response = await manager.callTool(allowed.internalCallName, arguments_);
    if (!response?.success) {
      const error = new Error(
        "WorkBuddy MCP tool failed, is disconnected, or requires authorization",
      );
      error.code = "WB_TOOL_CALL_FAILED";
      throw error;
    }
    return response.result;
  }

  async function invokeRenderer(request) {
    const id = request?.id;
    let envelope;
    try {
      assertRendererLifecycle();
      if (!request || request.version !== 1 || typeof id !== "string") {
        const error = new Error("Invalid renderer RPC request");
        error.code = "WB_RENDERER_RPC_INVALID";
        throw error;
      }
      let result;
      switch (request.method) {
        case "workbuddyMcp.listTools":
          result = await listWorkBuddyMcpTools();
          break;
        case "workbuddyMcp.callTool":
          result = await callWorkBuddyMcpTool(request.params);
          break;
        default: {
          const error = new Error(`Unsupported renderer RPC method: ${String(request.method)}`);
          error.code = "WB_RENDERER_RPC_METHOD_NOT_FOUND";
          throw error;
        }
      }
      assertRendererLifecycle();
      envelope = { version: 1, id, ok: true, result };
    } catch (error) {
      envelope = {
        version: 1,
        id: typeof id === "string" ? id : "invalid",
        ok: false,
        error: {
          name: error?.name ?? "Error",
          message: safeMcpErrorMessage(error),
          ...(typeof error?.code === "string" ? { code: error.code } : {}),
        },
      };
    }
    try {
      return JSON.stringify(envelope);
    } catch {
      return JSON.stringify({
        version: 1,
        id: typeof id === "string" ? id : "invalid",
        ok: false,
        error: { name: "Error", message: "WorkBuddy MCP result is not serializable" },
      });
    }
  }

  function threadKey(harnessId, threadId) {
    return `${String(harnessId)}\u0000${String(threadId)}`;
  }

  function externalId(harnessId, threadId) {
    return `${config.conversationPrefix}${encodeURIComponent(String(harnessId))}:${encodeURIComponent(String(threadId))}`;
  }

  function isExternalId(value) {
    return typeof value === "string" && value.startsWith(config.conversationPrefix);
  }

  function parseExternalId(value) {
    if (!isExternalId(value)) return undefined;
    const encoded = value.slice(config.conversationPrefix.length);
    const separator = encoded.indexOf(":");
    if (separator < 1) return undefined;
    try {
      return {
        harnessId: decodeURIComponent(encoded.slice(0, separator)),
        threadId: decodeURIComponent(encoded.slice(separator + 1)),
      };
    } catch {
      return undefined;
    }
  }

  function infoState(status) {
    const normalized = String(status ?? "").toLowerCase();
    if (normalized === "waiting_for_approval" || normalized === "pending") return "pending";
    if (["running", "working", "cancelling", "streaming", "compacting"].includes(normalized)) return "working";
    if (["failed", "error", "terminated"].includes(normalized)) return "error";
    return "idle";
  }

  function requestState(status) {
    const normalized = String(status ?? "").toLowerCase();
    if (["running", "working", "waiting_for_approval", "streaming"].includes(normalized)) return "streaming";
    if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
    if (["failed", "error", "denied"].includes(normalized)) return "error";
    return "completed";
  }

  function toolStatus(status) {
    const normalized = String(status ?? "").toLowerCase();
    if (["completed", "success", "succeeded", "done", "applied"].includes(normalized)) return "executed";
    if (["failed", "error", "denied", "rejected"].includes(normalized)) return "failed";
    if (["cancelled", "canceled", "terminated"].includes(normalized)) return "cancelled";
    if (["running", "in_progress", "executing"].includes(normalized)) return "stream_executing";
    return "pending";
  }

  function requestIdForTurn(local, turn, index = 0) {
    const turnId = String(turn?.id ?? turn?.turnId ?? `restored-${index}`);
    const key = `${local.key}\u0000${turnId}`;
    const mapped = state.requestIdByTurn.get(key);
    if (mapped) return mapped;
    const status = String(turn?.status ?? "").toLowerCase();
    const active = state.activeRequestByThread.get(local.key);
    if (active && ["running", "working", "waiting_for_approval", "streaming"].includes(status)) {
      return active;
    }
    return `wbhost:req:${encodeURIComponent(local.harnessId)}:${encodeURIComponent(turnId)}`;
  }

  function requestScopedMessageId(requestId, messageId) {
    return stableMessageId(`${String(requestId ?? "request")}\u0000${String(messageId ?? "message")}`);
  }

  function itemToHistoryBlock(item, requestId) {
    if (!item || typeof item !== "object") return undefined;
    const type = String(item.type ?? item.kind ?? "").toLowerCase();
    if (type === "text" || type === "message") {
      const text = textFrom(item.text ?? item.content ?? item.output);
      return text ? {
        type: "text",
        text,
        messageId: requestScopedMessageId(requestId, item.id ?? item.messageId),
      } : undefined;
    }
    if (type === "thinking" || type === "reasoning") {
      const text = textFrom(item.thinking ?? item.text ?? item.content);
      return text ? { type: "reasoning", text,
        messageId: requestScopedMessageId(requestId, item.id ?? item.messageId) } : undefined;
    }
    const isDiff = type === "diff" || type === "patch";
    const id = String(item.id ?? item.toolCallId ?? item.itemId ?? `tool-${Date.now()}`);
    return {
      type: "tool",
      sessionUpdate: "tool_call",
      toolCallId: id,
      name: String(item.name ?? item.toolName ?? (isDiff ? "apply_patch_preview" : "external_tool")),
      title: String(item.title ?? item.name ?? (isDiff ? "External diff" : "External tool")),
      status: toolStatus(item.status),
      rawInput: isDiff
        ? { path: item.path ?? item.file, patch: item.patch ?? item.diff ?? item.content }
        : item.input ?? item.arguments,
      ...(item.output !== undefined && item.output !== null ? { rawOutput: item.output } : {}),
    };
  }

  function responseModelFor(local, turn) {
    const model = turn?.model ?? turn?.responseModel;
    const id = typeof model === "object" ? model?.id : model;
    return { id: String(id ?? local.thread?.models?.currentModelId ?? local.harnessId) };
  }

  function nativeUsage(usage) {
    if (!usage || typeof usage !== "object") return undefined;
    const count = (key) => Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] : undefined;
    const input = count("input"), output = count("output"), total = count("totalTokens");
    if (input === undefined && output === undefined && total === undefined) return undefined;
    return {
      ...(input === undefined ? {} : { inputTokens: input + (count("cacheRead") ?? 0) + (count("cacheWrite") ?? 0) }),
      ...(output === undefined ? {} : { outputTokens: output }),
      ...(total === undefined ? {} : { lastTokens: total }),
    };
  }

  function applyTokenUsage(request, raw) {
    if (!raw || typeof raw !== "object") return;
    request.piTokenUsage = { ...raw };
    request.assistantMessage.piTokenUsage = { ...raw };
    // Native message.usage is also consumed as current context occupancy.
    // A Pi turn's cumulative billing tokens must never feed that surface.
    if (config.nativeUi) { delete request.usage; delete request.assistantMessage.usage; return; }
    const usage = nativeUsage(raw);
    if (usage) { request.usage = usage; request.assistantMessage.usage = usage; }
  }

  function contextUsagePayload(local) {
    const summary = local.thread.piContextUsage;
    if (summary?.source !== "pi-context-estimate") return undefined;
    const window = Number.isSafeInteger(summary.contextWindow) && summary.contextWindow > 0
      ? summary.contextWindow : local.contextUsageWindow;
    if (!Number.isSafeInteger(window) || window <= 0) return undefined;
    local.contextUsageWindow = window;
    return { totalTokens: summary.status === "available" && Number.isSafeInteger(summary.tokens) && summary.tokens >= 0 ? summary.tokens : null,
      contextWindow: window };
  }

  function publishContextUsage(local) {
    const payload = contextUsagePayload(local);
    if (payload) emitLocal(local, "contextUsageChanged", payload);
    scheduleContextUsageTipSync();
  }

  function refreshPiContextUsage(local) {
    if (local.contextUsagePromise) return local.contextUsagePromise;
    local.contextUsageLoaded = true;
    const version = local.contextUsageVersion ?? 0;
    const operation = rpc("thread.context.usage", { harnessId: local.harnessId, threadId: local.threadId })
      .then(result => {
        if ((local.contextUsageVersion ?? 0) !== version) return local.thread.piContextUsage;
        local.thread.piContextUsage = result.summary; publishContextUsage(local); return result.summary;
      })
      .catch(() => {
        if ((local.contextUsageVersion ?? 0) !== version) return;
        local.thread.piContextUsage = { source: "pi-context-estimate", status: "unknown", tokens: null, contextWindow: null, breakdown: null }; publishContextUsage(local);
      })
      .finally(() => {
        if (local.contextUsagePromise === operation) local.contextUsagePromise = undefined;
        if (!state.disposed && state.conversations.get(local.id) === local
          && (local.contextUsageVersion ?? 0) !== version) void refreshPiContextUsage(local);
      });
    local.contextUsagePromise = operation;
    return operation;
  }

  function usageTipText(local) {
    const value = local?.thread?.piContextUsage;
    if (value?.source !== "pi-context-estimate" || !["idle", "error"].includes(local.info.state) || !local.requests.size) return undefined;
    const model = local.thread.models?.availableModels?.find(model => model.id === local.thread.models.currentModelId);
    const controlHint = model?.supportedContextWindows?.length >= 2 ? " 上下文长度可在模型菜单中调整。" : "";
    if (value.status !== "available" || !Number.isSafeInteger(value.tokens) || !Number.isSafeInteger(value.contextWindow) || value.contextWindow <= 0) {
      return "Pi 当前上下文估算暂不可用；原生分类明细暂不支持。" + controlHint;
    }
    const format = number => String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const percent = value.tokens / value.contextWindow * 100;
    return `Pi 当前上下文估算：约 ${format(value.tokens)} / 配置窗口 ${format(value.contextWindow)} tokens（${percent.toFixed(1)}%）。原生分类明细暂不支持。${controlHint}`;
  }

  function writeUsageTip(node, text) {
    if (node.firstChild?.nodeType === 3 && node.childNodes?.length === 1) node.firstChild.nodeValue = text;
    else if (!node.childElementCount) node.textContent = text;
  }

  function syncContextUsageTips() {
    const local = state.conversations.get(currentRouteId());
    if (config.nativeUi && state.status === "ready" && local && !local.contextUsageLoaded
      && local.requests.size && local.handlers.get("contextUsageChanged")?.size
      && ["idle", "error"].includes(local.info.state)) void refreshPiContextUsage(local);
    const text = config.nativeUi && ownsRendererLifecycle() ? usageTipText(local) : undefined;
    for (const [node, saved] of state.contextUsageTips) {
      if (!text || node.isConnected === false) {
        if (node.textContent === saved.written) writeUsageTip(node, saved.original);
        for (const [name, value] of Object.entries(saved.styles ?? {})) {
          const ours = name === "white-space" ? "normal" : "anywhere";
          if (node.style?.getPropertyValue(name) === ours) node.style.setProperty(name, value.value, value.priority);
        }
        state.contextUsageTips.delete(node);
      }
    }
    if (!text) return;
    for (const node of document.querySelectorAll(".cr-context-usage-requesting-tip__text")) {
      if (!node.closest?.('.cr-context-usage-requesting-tip[role="tooltip"]')) continue;
      const saved = state.contextUsageTips.get(node) ?? { original: node.textContent, written: undefined,
        styles: Object.fromEntries(["white-space", "overflow-wrap"].map(name => [name, {
          value: node.style?.getPropertyValue(name) ?? "", priority: node.style?.getPropertyPriority?.(name) ?? "",
        }])) };
      if (node.textContent !== saved.written) saved.original = node.textContent;
      if (node.textContent !== text) writeUsageTip(node, text);
      // The native tooltip has a 240px max width and inherits nowrap. Wrap only
      // this owned text node so the estimate cannot overflow the native shell.
      if (node.style?.getPropertyValue("white-space") !== "normal") node.style?.setProperty("white-space", "normal");
      if (node.style?.getPropertyValue("overflow-wrap") !== "anywhere") node.style?.setProperty("overflow-wrap", "anywhere");
      saved.written = text; state.contextUsageTips.set(node, saved);
    }
  }

  function scheduleContextUsageTipSync() {
    if (!config.nativeUi || state.disposed || state.contextUsageTipScheduled) return;
    state.contextUsageTipScheduled = true;
    queueMicrotask(() => { state.contextUsageTipScheduled = false; syncContextUsageTips(); });
  }

  function installContextUsageTips() {
    if (!config.nativeUi || typeof globalThis.MutationObserver !== "function" || !document.body) return;
    state.contextUsageObserver = new MutationObserver(scheduleContextUsageTipSync);
    state.contextUsageObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function makeRequest(local, turn, index = 0) {
    const id = requestIdForTurn(local, turn, index);
    const blocks = (turn?.items ?? turn?.events ?? [])
      .map((item) => itemToHistoryBlock(item, id))
      .filter(Boolean);
    const stateValue = requestState(turn?.status);
    const completedAt = turn?.completedAt ? toTimestamp(turn.completedAt) : undefined;
    const request = {
      id,
      conversationRequestId: id,
      identity: { requestId: id, forkMessageId: id, forkRequestId: id },
      requestSeq: index,
      state: stateValue,
      timestamp: toTimestamp(turn?.createdAt),
      ...(completedAt === undefined ? {} : { completedAt, finishTimestamp: completedAt }),
      responseModel: responseModelFor(local, turn),
      userMessage: {
        type: "text",
        state: "completed",
        content: [{ type: "text", text: textFrom(turn?.prompt ?? turn?.input) }],
      },
      assistantMessage: {
        type: "text",
        state: stateValue === "completed" ? "completed" : stateValue,
        contentIdentity: "message",
        content: blocks,
      },
      getAgentTeams: () => [],
      getArtifacts: () => [],
      like: () => undefined,
      dislike: () => undefined,
      share: () => undefined,
    };
    applyTokenUsage(request, turn?.usage);
    local.requests.set(id, request);
    const turnId = String(turn?.id ?? turn?.turnId ?? "");
    if (turnId) {
      state.requestIdByTurn.set(`${local.key}\u0000${turnId}`, id);
      if (["running", "waiting_for_approval"].includes(String(turn?.status))) {
        local.activeTurnId = turnId;
        state.activeRequestByThread.set(local.key, id);
      }
    }
    return request;
  }

  function pendingFromInteraction(interaction) {
    if (!interaction || interaction.status !== "pending") return undefined;
    const interactionId = String(interaction.interactionId ?? interaction.id ?? "");
    if (!interactionId) return undefined;
    const tool = interaction.toolCall ?? interaction.tool_call ?? {};
    const office = interaction.source === "ssh-office";
    return {
      id: interactionId,
      category: "tool",
      toolCallId: String(
        interaction.toolItemId ?? interaction.toolCallId ?? tool.toolCallId ?? tool.id ?? interactionId,
      ),
      toolName: String(interaction.toolName ?? tool.name ?? tool.kind ?? "external_tool"),
      title: String(interaction.title ?? tool.title ?? "External harness requests approval"),
      description: String(interaction.description ?? tool.description ?? interaction.question ?? ""),
      ...(tool.input && typeof tool.input === "object" ? {
        // WorkBuddy's generic permission panel ignores title/description. Its
        // runtime policy panel exposes hitContent alongside the same one-shot
        // allow/reject decisions, so the actual command or write is reviewable.
        metadata: {
          runtimeSecurity: {
            action: "requireApproval",
            defaultDecision: "deny",
            ruleName: office ? String(interaction.title) : `Pi ${String(interaction.toolName ?? tool.name ?? "tool")}`,
            hitContent: office ? String(interaction.description) : JSON.stringify(tool.input, null, 2),
          },
        },
      } : {}),
      options: (Array.isArray(interaction.options) ? interaction.options : []).map((option) => ({
        optionId: String(option.optionId ?? option.id ?? option.value ?? ""),
        kind: String(option.kind ?? "allow_once"),
        name: String(option.name ?? option.label ?? option.title ?? option.id ?? "Continue"),
      })),
      hostInteractionId: interactionId,
    };
  }

  function replacePendingQueue(local, interactions) {
    const previousId = local.pending?.id;
    local.pendingById.clear();
    for (const interaction of interactions) {
      const pending = pendingFromInteraction(interaction);
      if (pending) local.pendingById.set(pending.id, pending);
    }
    local.pending = local.pendingById.values().next().value;
    return previousId !== local.pending?.id;
  }

  function enqueuePending(local, interaction) {
    const pending = pendingFromInteraction(interaction);
    if (!pending) return false;
    const previousId = local.pending?.id;
    local.pendingById.set(pending.id, pending);
    local.pending = local.pendingById.values().next().value;
    return previousId !== local.pending?.id;
  }

  function removePending(local, interactionId) {
    const previousId = local.pending?.id;
    if (interactionId) local.pendingById.delete(String(interactionId));
    local.pending = local.pendingById.values().next().value;
    return previousId !== local.pending?.id;
  }

  function pageFor(local) {
    const requests = [...local.requests.values()];
    const entries = requests.flatMap((request) => [
      { kind: "request-message", requestId: request.id, role: "user" },
      { kind: "request-message", requestId: request.id, role: "assistant" },
    ]);
    return {
      requests,
      entries,
      totalRequests: requests.length,
      hasOlder: false,
      historyReady: true,
      historyKnownEmpty: requests.length === 0,
    };
  }

  function replaceRequestSnapshot(local, request) {
    const cloneContent = (content) => (Array.isArray(content)
      ? content.map((item) => (
          item && typeof item === "object" ? { ...item } : item
        ))
      : []);
    const next = {
      ...request,
      identity: request.identity ? { ...request.identity } : request.identity,
      userMessage: request.userMessage ? {
        ...request.userMessage,
        content: cloneContent(request.userMessage.content),
      } : request.userMessage,
      assistantMessage: request.assistantMessage ? {
        ...request.assistantMessage,
        content: cloneContent(request.assistantMessage.content),
      } : request.assistantMessage,
    };
    local.requests.set(next.id, next);
    return next;
  }

  function emitLocal(local, event, ...args) {
    for (const listener of local.handlers.get(event) ?? []) {
      try {
        listener(...args);
      } catch {
        // A WorkBuddy view listener must not break the external bridge.
      }
    }
  }

  function publishListChange(added, updated, deleted) {
    if (!state.wb || state.disposed) return;
    state.wb.$bus.emit(LIST_CHANGED, { added, updated, deleted });
  }

  function emitInfo(local) {
    emitLocal(local, "infoChange", local.info);
    state.wb?.$bus.emit(INFO_CHANGED, { conversationId: local.id, info: local.info });
    publishListChange([], [local.info], []);
  }

  function emitState(local, to, finalState, terminalError, promptResponseMeta) {
    const from = local.info.state;
    local.info.state = to;
    local.info.updatedAt = Date.now();
    local.info.lastActivityAt = local.info.updatedAt;
    local.info.hasRunningBackgroundTasks = to === "working" || to === "pending";
    emitLocal(local, "stateChange", from, to, finalState, terminalError, undefined, promptResponseMeta);
    state.wb?.$bus.emit(STATE_CHANGED, {
      conversationId: local.id,
      from,
      to,
      ...(finalState === undefined ? {} : { finalState }),
      ...(terminalError === undefined ? {} : { terminalError }),
      ...(promptResponseMeta === undefined ? {} : { promptResponseMeta }),
    });
  }

  function emitRequestUpdate(local, requestId, messageId, chunk) {
    const request = local.requests.get(requestId);
    const context = request ? {
      timestamp: request.timestamp,
      conversationRequestId: request.conversationRequestId ?? request.id,
      ...(request.responseModel ? { responseModel: { ...request.responseModel } } : {}),
    } : {};
    // WorkBuddy 5.9.1 consumes typed patches as the fourth callback argument.
    // Assistant patches replace the complete block at its index; chunks remain
    // available for tool metadata and telemetry, not for assembling UI content.
    const patches = !request ? [] : chunk?.update?.sessionUpdate === "user_message_chunk"
      ? [{
        kind: "user-content-replaced",
        requestId,
        content: request.userMessage.content.map((block) => ({ ...block })),
        context,
      }]
      : (request.assistantMessage?.content ?? []).map((block, index) => ({
        kind: "assistant-block-upserted",
        requestId,
        index,
        block: { ...block },
        context,
      }));
    emitLocal(local, "requestUpdate", requestId, messageId, chunk, patches);
  }

  function emitRequestsChanged(local) {
    emitLocal(local, "requestsChanged", [...local.requests.values()]);
  }

  function unsupported(operation) {
    return { errorCode: "NOT_SUPPORTED", message: `${operation} 暂未在 Pi 接入中实现` };
  }

  function configManagerFor(local) {
    let expertRevision = 0;
    const values = {
      mode: "craft",
      model: String(local.thread?.models?.currentModelId ?? ""),
      connectors: [],
      permissionMode: config.nativeUi ? "default" : "bypassPermissions",
      useSandboxCLI: !config.nativeUi,
      thoughtLevel: undefined,
      contextWindow: undefined,
      expert: undefined,
    };
    function rejectUnmappedSetting(name) {
      const error = new Error(`${name}尚未映射到 Pi，请使用 Pi 已接入的文本对话和工具。`);
      try { state.wb?.ui?.toast?.({ message: error.message, type: "error" }); } catch {}
      throw error;
    }
    async function enqueueConfiguration(work) {
      const previous = local.pendingConfiguration;
      const operation = (async () => { await previous; return work(); })();
      local.pendingConfiguration = operation;
      try { return await operation; }
      finally { if (local.pendingConfiguration === operation) local.pendingConfiguration = undefined; }
    }
    async function saveContext(change) {
      const operation = rpc("thread.context.set", { harnessId: local.harnessId, threadId: local.threadId, ...change });
      local.pendingContext = operation;
      let result;
      try { result = await operation; }
      finally { if (local.pendingContext === operation) local.pendingContext = undefined; }
      updateConversationFromThread(local, result.thread);
      emitLocal(local, "configChange");
    }
    return {
      get mode() { return values.mode; },
      get model() {
        return String(local.thread?.models?.currentModelId ?? (config.nativeUi ? "" : values.model) ?? "");
      },
      get connectors() { return local.thread.nativeContext?.connectorSelections
        ?? (local.thread.nativeContext?.connectors?.map(name => ({ name, displayName: name, activeStatus: true }))) ?? values.connectors; },
      get permissionMode() {
        if (config.nativeUi) return local.thread.approvalMode === "auto" ? "fullAccess" : "default";
        return values.permissionMode;
      },
      get useSandboxCLI() { return values.useSandboxCLI; },
      get thoughtLevel() { return config.nativeUi ? local.thread.executionSettings?.thinkingLevel : values.thoughtLevel; },
      get preMessageCompactPct() { return local.thread.executionSettings?.preMessageCompactPct ?? undefined; },
      get contextWindow() {
        if (config.nativeUi) return Number.isSafeInteger(local.thread.contextWindow) ? String(local.thread.contextWindow) : undefined;
        return values.contextWindow;
      },
      get expert() { return local.thread.nativeContext && Object.hasOwn(local.thread.nativeContext, "expert") ? local.thread.nativeContext.expert ?? undefined : values.expert; },
      get expertId() { return this.expert?.id ?? ""; },
      async setMode(value) { values.mode = value; emitLocal(local, "modeChange", { slug: value }); },
      async setModel(value) {
        const model = String(value ?? "");
        if (!model) throw new Error("External model id is required");
        return enqueueConfiguration(async () => {
        const result = await rpc("thread.model.set", {
          harnessId: local.harnessId,
          threadId: local.threadId,
          model,
        });
        const thread = result?.thread ?? result;
        if (thread && typeof thread === "object") updateConversationFromThread(local, thread);
        if (config.nativeUi) { local.contextUsageLoaded = false; publishContextUsage(local); }
        values.model = String(local.thread?.models?.currentModelId ?? model);
        emitExternalModelChange(local);
        emitContextWindowChange(local);
        scheduleModelSelectorSync();
        });
      },
      async setConnectors(value) {
        const connectors = value ?? [];
        if (!Array.isArray(connectors) || connectors.some(item => typeof (typeof item === "string" ? item : item?.name) !== "string")) throw new Error("连接器选择无效");
        const selected = connectors.map(item => typeof item === "string" ? { name: item, displayName: item, activeStatus: true }
          : { name: item.name, displayName: item.displayName || item.name, activeStatus: true });
        if (config.nativeUi) await saveContext({ connectors: selected });
        values.connectors = selected;
      },
      async setPermissionMode(value) {
        if (config.nativeUi) {
          if (!["default", "bypassPermissions", "default-sandbox", "fullAccess", "full-access"].includes(value)) rejectUnmappedSetting("原生权限模式");
          let mode = ["fullAccess", "full-access"].includes(value) ? "auto" : "manual";
          // A product gate can normalize the core mode to default even while
          // the saved native preference is full-access. Respect the saved
          // policy rather than silently re-enabling command prompts.
          if (mode === "manual" && typeof state.wb?.config?.preference === "function") {
            const saved = await state.wb.config.preference("localTaskPermissionMode");
            if (saved === "full-access" || saved == null && local.thread.approvalMode === "auto") mode = "auto";
          }
          const result = await rpc("thread.approval.set", { harnessId: local.harnessId, threadId: local.threadId, approvalMode: mode });
          updateConversationFromThread(local, result.thread);
          values.permissionMode = mode === "auto" ? "fullAccess" : "default";
        } else values.permissionMode = value;
      },
      async setSandboxMode(value) {
        // The native lifecycle syncs its default sandbox preference before it
        // sends a message. Pi does not use that runtime, so acknowledge the sync
        // without enabling it or pretending an OS sandbox is active.
        if (config.nativeUi) return false;
        values.useSandboxCLI = Boolean(value);
      },
      async setThoughtLevel(value) {
        if (!config.nativeUi) { values.thoughtLevel = value || undefined; return; }
        return enqueueConfiguration(async () => {
          const result = await rpc("thread.execution.settings.set", { harnessId: local.harnessId, threadId: local.threadId, thoughtLevel: value ?? null });
          updateConversationFromThread(local, result.thread); emitExecutionSettingsChange(local);
        });
      },
      async setPreMessageCompactPct(value) {
        if (!config.nativeUi) return unsupported("preMessageCompactPct");
        return enqueueConfiguration(async () => {
          const result = await rpc("thread.execution.settings.set", { harnessId: local.harnessId, threadId: local.threadId, preMessageCompactPct: value ?? null });
          updateConversationFromThread(local, result.thread); emitExecutionSettingsChange(local);
        });
      },
      async setContextWindow(value) {
        if (!config.nativeUi) { values.contextWindow = value || undefined; return; }
        const reset = value === "" || value === undefined || value === null;
        const normalized = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
        if (!reset && (!Number.isSafeInteger(normalized) || normalized <= 1)) throw new Error("上下文长度必须是该模型支持的正整数档位。");
        return enqueueConfiguration(async () => {
          const result = await rpc("thread.context.window.set", { harnessId: local.harnessId, threadId: local.threadId,
            contextWindow: reset ? null : normalized });
          updateConversationFromThread(local, result.thread);
          emitContextWindowChange(local);
          void refreshPiContextUsage(local);
        });
      },
      async setExpert(value) {
        const revision = ++expertRevision;
        const operation = (async () => {
          const expert = value ? await resolveNativeExpert(value) : null;
          if (revision !== expertRevision) return;
          if (config.nativeUi) await saveContext({ expert });
          values.expert = expert ?? undefined;
          emitLocal(local, "expertChange", expert ?? undefined);
        })();
        local.pendingExpert = operation;
        try { await operation; }
        finally { if (local.pendingExpert === operation) local.pendingExpert = undefined; }
      },
      async setExpertId(id, options) {
        return this.setExpert(id ? { id, ...(options ?? {}) } : null);
      },
    };
  }

  async function seedNativeApprovalPreference(uiState = {}) {
    if (!config.nativeUi || typeof state.wb?.config?.preference !== "function" || typeof state.wb?.config?.setPreference !== "function") return;
    const owner = state.harnesses.get(state.selectedHarnessId ?? "pi");
    if (!["auto", "manual"].includes(owner?.approvalMode)) return;
    const marker = `pi-040-${owner.approvalMode}`;
    const saved = await state.wb.config.preference("localTaskPermissionMode");
    if (uiState.approvalPreferenceSeed === marker && saved != null) return;
    await state.wb.config.setPreference("localTaskPermissionMode", owner.approvalMode === "auto" ? "full-access" : "default-sandbox");
    await persistUiState({ approvalPreferenceSeed: marker });
  }

  function nativeExpertSelection(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result = {};
    for (const key of ["id", "marketExpertId", "source", "enterpriseId", "locale", "runtimeIdentity", "marketplace",
      "pluginName", "plugin", "pluginRegisteredName", "agentName", "localPath", "expertRootDir", "expertType",
      "name", "displayName", "version", "updatedAt", "prompt", "defaultInitPrompt"]) {
      if (value[key] !== undefined) result[key] = value[key];
    }
    return result;
  }

  async function resolveNativeExpert(value) {
    if (!value || typeof value.id !== "string" || !value.id.trim()) throw new Error("专家选择无效");
    const selection = nativeExpertSelection(value);
    const locale = String(value.locale ?? "zh").toLowerCase().startsWith("en") ? "en" : "zh";
    const localized = (field) => {
      if (typeof field === "string") return field.trim() || undefined;
      if (!field || typeof field !== "object" || Array.isArray(field)) return undefined;
      for (const key of [locale, locale === "en" ? "zh" : "en"]) {
        if (typeof field[key] === "string" && field[key].trim()) return field[key].trim();
      }
      return undefined;
    };
    const persona = expert => {
      const prompt = localized(expert?.prompt);
      return prompt && ![expert?.defaultInitPrompt, value.defaultInitPrompt].some(field => localized(field) === prompt) ? prompt : undefined;
    };
    const resultFor = (expert, fromLocal = false) => {
      const prompt = persona(expert);
      if (!prompt) return undefined;
      const result = { ...nativeExpertSelection(expert), ...selection, id: value.id,
        name: localized(expert.displayName) || localized(expert.name) || localized(value.displayName) || localized(value.name) || value.id,
        prompt, locale };
      // Package descriptors come only from the Node reader, which revalidates
      // them when binding and before each turn. Renderer never opens paths.
      if (fromLocal) {
        for (const key of ["localPath", "expertRootDir", "version", "agentName", "pluginName", "plugin", "pluginRegisteredName"]) {
          if (expert[key] === undefined) delete result[key];
          else result[key] = expert[key];
        }
        if (expert.package) result.package = expert.package;
      }
      return result;
    };
    const localExpert = async candidate => {
      const resolved = await rpc("expert.resolve", { expert: value.package === undefined ? candidate : { ...candidate, package: value.package } });
      assertRendererLifecycle();
      if (resolved?.expert === null) return undefined;
      if (!resolved?.expert || typeof resolved.expert !== "object" || Array.isArray(resolved.expert)) {
        throw new Error("专家本地解析返回无效结果，请重试或重新安装专家");
      }
      const result = resultFor(resolved.expert, true);
      if (!result) throw new Error("此专家未提供可用指令，请重新安装或选择专家");
      return result;
    };
    const local = await localExpert(selection);
    if (local) return local;
    const packageSelection = ["localPath", "expertRootDir", "pluginName", "plugin", "pluginRegisteredName", "agentName"]
      .some(key => Boolean(selection[key])) || ["agent", "team"].includes(selection.expertType) || Boolean(value.package);
    if (!packageSelection) {
      const inline = resultFor(selection);
      if (inline) return inline;
    }
    const query = { expertId: value.id, locale };
    for (const key of ["marketExpertId", "source", "enterpriseId"]) {
      if (selection[key] !== undefined) query[key] = selection[key];
    }
    for (const key of ["isIncludeInvisible", "allowStaleManifestFallback"]) {
      if (typeof value[key] === "boolean") query[key] = value[key];
    }
    // An explicitly selected namespace must not be replaced by a same-alias
    // custom persona and then mislabeled with the original source.
    const allowCustom = !selection.marketExpertId && (selection.source === undefined || selection.source === "custom");
    const [official, custom] = await Promise.allSettled([
      Promise.resolve().then(() => state.wb?.experts?.get?.(query)),
      allowCustom ? Promise.resolve().then(() => state.wb?.experts?.custom?.get?.({ expertId: value.id })) : Promise.resolve(undefined),
    ]);
    assertRendererLifecycle();
    const expert = (official.status === "fulfilled" ? official.value : undefined)
      ?? (custom.status === "fulfilled" ? custom.value : undefined);
    if (expert && typeof expert === "object") {
      const merged = { ...nativeExpertSelection(expert), ...selection };
      if (persona(expert)) merged.prompt = persona(expert);
      const installed = await localExpert(merged);
      if (installed) return installed;
      const inline = resultFor({ ...merged, prompt: persona(expert) });
      if (inline) return inline;
    }
    throw new Error("此专家未提供可用指令或本地插件包，请重新安装或选择专家");
  }

  async function prepareNativeBlocks(blocks, local) {
    if (!Array.isArray(blocks) || blocks.length > 64) throw new Error("输入内容块无效或过多");
    const claimsScene = block => block?.type === "resource_link" && (/^scene:/i.test(String(block.uri ?? ""))
      || block._meta?.type === "scene" || block._meta?.mentionType === "scene");
    const claimsLongText = block => block?.type === "resource_link" && (/^longtext:/i.test(String(block.uri ?? ""))
      || block._meta?.mentionType === "long-text");
    const selectedSkills = blocks.filter(block => block?.type === "resource_link"
      && !claimsScene(block) && !claimsLongText(block)
      && (block._meta?.type === "skill" || block._meta?.mentionType === "skill" || String(block.uri ?? "").startsWith("skill://")));
    const catalogItems = (catalog) => Array.isArray(catalog) ? catalog
      : Array.isArray(catalog?.results) ? catalog.results : Array.isArray(catalog?.items) ? catalog.items : [];
    const decodeSkillIdentity = (value) => { try { return decodeURIComponent(value).trim(); } catch { return value.trim(); } };
    const normalizeSkill = (item) => {
      const meta = item?.metadata ?? {};
      return {
        id: item?.id || item?.skillId || meta.skillId || item?.name,
        name: item?.name || item?.slug || item?.displayName,
        filePath: item?.filePath || item?.ref || meta.filePath || meta.ref,
        aliases: [item?.id, item?.skillId, item?.cloudUid, item?.name, item?.slug, item?.overrideKey, meta.skillId, meta.cloudUid]
          .filter(value => typeof value === "string" && value),
        disabled: item?.disabled ?? item?.disable ?? (item?.enabled === false ? true : undefined),
        enabled: item?.enabled,
        userInvocable: item?.userInvocable ?? meta.userInvocable,
      };
    };
    const personalSkills = globalThis.__GENIE_DEFAULT_APP_PROVIDERS__?.facades?.personalSkills ?? state.wb?.personalSkills;
    let localCatalog, globalCatalog;
    async function loadCatalog(global) {
      if (global) {
        globalCatalog ??= Promise.resolve().then(async () => ({ available: typeof state.wb?.skills?.installed === "function",
          items: catalogItems(await state.wb?.skills?.installed?.({ dataSource: "local", cwd: local.info.cwd, global: true })).map(normalizeSkill) }));
        return globalCatalog;
      }
      localCatalog ??= Promise.resolve().then(async () => ({ available: typeof personalSkills?.list === "function",
        items: catalogItems(await personalSkills?.list?.({ cwd: local.info.cwd, global: false })).map(normalizeSkill) }));
      return localCatalog;
    }
    const skills = [];
    for (const block of selectedSkills) {
      const meta = block._meta ?? {}, uri = typeof block.uri === "string" ? block.uri : "";
      // Native skill blocks can carry either a skill URI or a command-style alias.
      const uriIdentity = uri.startsWith("skill://") ? decodeSkillIdentity(uri.slice(8))
        : typeof meta.commandName === "string" && meta.commandName.trim() ? meta.commandName.trim()
          : uri.startsWith("command://") ? decodeSkillIdentity(uri.slice(10)) : "";
      const identity = typeof meta.skillId === "string" && meta.skillId ? meta.skillId : uriIdentity;
      const name = block.name || meta.displayText || identity;
      if (!identity && !meta.filePath) throw new Error("所选技能缺少可解析的身份，请重新选择");
      const matchesIn = (items) => {
        const found = items.filter(item => meta.filePath ? item.filePath === meta.filePath : item.aliases.includes(identity));
        return [...new Map(found.map(item => [item.filePath || JSON.stringify(item.aliases), item])).values()];
      };
      let catalog, matches, catalogFailed = false;
      try { catalog = await loadCatalog(false); } catch { catalogFailed = true; }
      matches = matchesIn(catalog?.items ?? []);
      if (!matches.length) {
        let global;
        try { global = await loadCatalog(true); } catch { catalogFailed = true; }
        matches = matchesIn(global?.items ?? []);
        catalog = { available: catalog?.available || global?.available };
      }
      if (!catalog?.available && catalogFailed) throw new Error("无法读取原生已安装技能目录，请刷新技能页后重新选择");
      if (matches.length > 1) throw new Error("所选技能身份不唯一，请在技能页确认后重新选择");
      if (!matches.length && (catalog.available || typeof meta.filePath !== "string")) throw new Error("所选技能尚未安装，请在技能页确认后重新选择");
      const selected = matches[0] ?? { id: identity, name, filePath: meta.filePath, disabled: meta.disabled, enabled: meta.enabled, userInvocable: meta.userInvocable };
      if (typeof selected.filePath !== "string") throw new Error("所选技能缺少本地 SKILL.md 路径");
      skills.push({ id: selected.id || identity || selected.name, name: selected.name || name || identity, filePath: selected.filePath,
        ...(selected.disabled === undefined ? {} : { disabled: selected.disabled }),
        ...(selected.enabled === undefined ? {} : { enabled: selected.enabled }),
        ...(selected.userInvocable === undefined ? {} : { userInvocable: selected.userInvocable }) });
    }
    const inputs = blocks.filter(block => !selectedSkills.includes(block)).map(block => {
      if (block?.type === "text") return { type: "text", text: block.text };
      if (!["image", "resource_link"].includes(block?.type)) throw new Error("此输入类型尚未映射到 Pi");
      const meta = block._meta ?? {}, safeMeta = {};
      for (const key of ["filename", "fileName", "size", "blockStatus", "attachmentTransport", "filePath", "path", "relativePath", "type", "mentionType", "selectionQuote", "selectedText", "llmText"]) {
        if (["string", "number", "boolean"].includes(typeof meta[key])) safeMeta[key] = meta[key];
      }
      if (claimsScene(block)) for (const key of ["sceneId", "displayText"]) {
        if (typeof meta[key] === "string") safeMeta[key] = meta[key];
      }
      if (claimsLongText(block)) for (const key of ["fullText", "displayText"]) {
        if (typeof meta[key] === "string") safeMeta[key] = meta[key];
      }
      if (["connector-link-pending-auth", "connector-link-resolved"].includes(meta.kind)) safeMeta.kind = meta.kind;
      if (meta.selectionPayload && typeof meta.selectionPayload.text === "string") safeMeta.selectionPayload = { text: meta.selectionPayload.text };
      if (block.type === "image" && !meta.filePath && !meta.path && !String(block.uri ?? "").startsWith("file:")) throw new Error("此粘贴图片没有本地文件路径，请保存为图片文件后从附件入口选择");
      return { type: block.type, uri: block.uri ?? "", name: block.name, title: block.title, mimeType: block.mimeType, _meta: safeMeta };
    });
    if (!inputs.some(block => block.type === "text" ? String(block.text ?? "").trim() : !claimsScene(block)) && skills.length) {
      inputs.push({ type: "text", text: "请使用所选技能完成任务。" });
    }
    const prompt = inputs.filter(block => block.type === "text").map(block => block.text).join("");
    if (new TextEncoder().encode(JSON.stringify({ prompt, promptContentBlocks: inputs, skills })).byteLength > 55 * 1024) {
      throw new Error("输入文本或附件元数据过大，请减少内容，或将长文本保存为TXT附件。");
    }
    return { prompt, promptContentBlocks: inputs, skills };
  }

  function extractPrompt(blocks) {
    const values = Array.isArray(blocks) ? blocks : [];
    if (values.some((block) => block?.type !== "text")) {
      throw new Error("Pi 接入目前仅支持纯文本输入");
    }
    const text = values.map((block) => textFrom(block?.text ?? block?.content)).filter(Boolean).join("\n").trim();
    if (text) return text;
    try {
      return JSON.stringify(values);
    } catch {
      return "External WorkBuddy request";
    }
  }

  function createConversation(thread) {
    const threadId = String(thread.id ?? thread.threadId);
    const harnessId = String(thread.harnessId ?? "");
    if (!harnessId) throw new Error(`External thread ${threadId} has no harness owner`);
    const key = threadKey(harnessId, threadId);
    const id = externalId(harnessId, threadId);
    const local = {
      id,
      key,
      harnessId,
      threadId,
      thread,
      handlers: new Map(),
      requests: new Map(),
      pending: undefined,
      pendingById: new Map(),
      draftBlocks: [],
      activeTurnId: thread.activeTurnId ?? undefined,
      info: {
        id,
        title: conversationTitle(thread),
        state: infoState(thread.status),
        lifecycle: "completed",
        transport: "local",
        origin: "desktop",
        kind: "task",
        cwd: String(thread.cwd ?? ""),
        space: {
          type: "local",
          cwd: String(thread.cwd ?? ""),
          name: workspaceName(thread.cwd),
          autoGenerated: config.nativeUi ? thread.workspaceAutoGenerated !== false : !String(thread.cwd ?? ""),
        },
        // Native artifact binding treats any runtimeId as a cloud sandbox.
        // Local Pi identity is info.id; it must not expose a cloud runtimeId.
        createdAt: toTimestamp(thread.createdAt),
        updatedAt: toTimestamp(thread.updatedAt ?? thread.createdAt),
        lastActivityAt: conversationActivity(thread),
        isPinned: false,
        isUserDefinedTitle: thread.userDefinedTitle ? 1 : 0,
        hasRunningBackgroundTasks: ["working", "pending"].includes(infoState(thread.status)),
        conversationOrigin: "local",
        tags: ["workbuddy-host", "external-harness"],
      },
    };

    const queueManager = {
      items: () => [],
      pause: async () => undefined,
      resume: async () => undefined,
      delete: async () => undefined,
      move: async () => undefined,
      sendNow: async () => "missing",
    };
    function nativeRequestId(turnId) { return requestIdForTurn(local, { id: turnId }); }
    function hostTurnId(requestId) {
      const id = typeof requestId === "string" ? requestId : requestId?.requestId;
      for (const [key, value] of state.requestIdByTurn) if (key.startsWith(local.key + "\u0000") && value === id) return key.slice(local.key.length + 1);
      const found = local.thread.turns?.find(t => t.id === id || nativeRequestId(t.id) === id);
      if (found) return found.id;
      throw new Error("未找到该原生轮次对应的 Pi 检查点。");
    }
    function projectManifest(manifest) {
      return { ...manifest, conversationId: local.id, requestId: nativeRequestId(manifest.requestId), files: [...manifest.files] };
    }
    async function loadFiles(detailRef) {
      const result = await rpc("thread.files", { harnessId, threadId, ...(detailRef === undefined ? {} : { detailRef }) });
      return detailRef === undefined ? { artifacts: (result.artifacts ?? []).map(a => ({ ...a, conversationId: local.id, requestId: nativeRequestId(a.requestId) })),
        files: result.files ?? [], manifests: (result.manifests ?? []).map(projectManifest) } : projectManifest(result.detail);
    }
    async function readCheckpoint(requestId) {
      const result = await rpc("thread.checkpoint.read", { harnessId, threadId, turnId: hostTurnId(requestId) });
      return { ...result, restoreInfo: result.restoreInfo?.map(info => ({ ...info,
        ...(info.versionRequestId ? { versionRequestId: nativeRequestId(info.versionRequestId) } : {}) })) };
    }
    async function rewind(requestId) {
      await local.pendingConfiguration;
      const result = await rpc("thread.rewind", { harnessId, threadId, turnId: hostTurnId(requestId) });
      if (!result.branchChanged || !Array.isArray(result.removedRequestIds)) throw new Error("执行器未确认文件和历史回退成功。");
      const removed = result.removedRequestIds.map(nativeRequestId), truncated = nativeRequestId(result.truncatedFromRequestId);
      for (const id of removed) local.requests.delete(id);
      for (const id of result.removedRequestIds) state.requestIdByTurn.delete(`${local.key}\u0000${id}`);
      if (result.thread) updateConversationFromThread(local, result.thread);
      else local.thread.turns = local.thread.turns?.filter(t => !result.removedRequestIds.includes(t.id));
      local.activeTurnId = undefined; state.activeRequestByThread.delete(local.key);
      emitRequestsChanged(local); emitLocal(local, "historyLoaded"); emitLocal(local, "artifactUpdate");
      local.contextUsageLoaded = false; void refreshPiContextUsage(local);
      return { ok: true, branchChanged: true, truncatedFromRequestId: truncated, removedRequestIds: removed };
    }
    function isCompactInput(blocks) {
      const list = typeof blocks === "string" ? [{ type: "text", text: blocks }] : Array.isArray(blocks) ? blocks : [];
      return list.some(block => block?.type === "text" && ["/compact", "/总结"].includes(String(block.text ?? "").trim().toLowerCase())
        || block?.type === "resource_link" && String(block.uri ?? "").trim() === "command://compact");
    }
    const fileManager = {
      artifacts: async () => { const items = (await loadFiles()).artifacts; return { items, total: items.length, hasMore: false }; },
      readArtifact: async id => (await loadFiles()).artifacts.find(a => a.id === id),
      files: async () => (await loadFiles()).files,
      changes: async () => (await loadFiles()).manifests,
    };

    local.controller = {
      info: local.info,
      configManager: configManagerFor(local),
      queueManager,
      fileManager,
      on(event, listener) {
        const listeners = local.handlers.get(event) ?? new Set();
        listeners.add(listener);
        local.handlers.set(event, listeners);
        if (event === "requestsChanged") queueMicrotask(() => listener([...local.requests.values()]));
        if (config.nativeUi && event === "contextUsageChanged") queueMicrotask(() => {
          if (!listeners.has(listener) || state.disposed) return;
          const payload = contextUsagePayload(local); if (payload) listener(payload);
          if (currentRouteId() === local.id) void refreshPiContextUsage(local);
        });
        return () => listeners.delete(listener);
      },
      start: async () => undefined,
      async sendPrompt(blocks, options = {}) {
        if (config.nativeUi) { await local.pendingExpert; await local.pendingContext; await local.pendingConfiguration; }
        if (config.nativeUi && isCompactInput(blocks)) {
          await local.controller.compact(); return { ok: true };
        }
        if (!["idle", "error"].includes(local.info.state)) {
          throw new Error("External conversation is busy");
        }
        let model;
        if (config.nativeUi && options.modelId !== undefined) {
          if (typeof options.modelId !== "string" || !options.modelId.trim() || options.modelId.includes("\u0000")) {
            throw new Error("Pi model id must be a non-empty string");
          }
          model = options.modelId.trim();
        }
        const nativeInput = config.nativeUi ? await prepareNativeBlocks(blocks, local) : null;
        const prompt = nativeInput?.prompt ?? extractPrompt(blocks);
        if (!prompt && !nativeInput?.promptContentBlocks.length) throw new Error("Prompt is empty");
        const requestId = String(options.clientRequestId ?? `wbhost:req:${Date.now()}`);
        const request = {
          id: requestId,
          conversationRequestId: requestId,
          identity: {
            requestId,
            forkMessageId: requestId,
            forkRequestId: requestId,
          },
          requestSeq: local.requests.size,
          state: "streaming",
          timestamp: Date.now(),
          responseModel: responseModelFor(local),
          userMessage: { type: "text", state: "completed", content: Array.isArray(blocks) ? blocks : [] },
          assistantMessage: {
            type: "text",
            state: "streaming",
            contentIdentity: "message",
            content: [],
          },
          getAgentTeams: () => [],
          getArtifacts: () => [],
          like: () => undefined,
          dislike: () => undefined,
          share: () => undefined,
        };
        local.requests.set(requestId, request);
        state.activeRequestByThread.set(local.key, requestId);
        emitState(local, "working");
        emitRequestUpdate(local, requestId, `${requestId}-user`, {
          update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: prompt } },
        });
        try {
          const result = await rpc("turn.start", {
            harnessId, threadId, prompt,
            ...(nativeInput ?? {}),
            ...(model === undefined ? {} : { model }),
          });
          const turnId = String(result?.turn?.id ?? result?.turnId ?? "");
          if (turnId && state.activeRequestByThread.get(local.key) === requestId) {
            local.activeTurnId = turnId;
            state.requestIdByTurn.set(`${local.key}\u0000${turnId}`, requestId);
          }
          return undefined;
        } catch (error) {
          request.state = "error";
          request.assistantMessage.state = "error";
          request.completedAt = Date.now();
          request.finishTimestamp = request.completedAt;
          replaceRequestSnapshot(local, request);
          emitRequestsChanged(local);
          emitLocal(local, "historyLoaded");
          emitState(local, "error", "error", { stopReason: "external_error", message: error.message });
          throw error;
        }
      },
      async runPrompt() { return unsupported("runPrompt"); },
      async cancel() {
        if (local.info.state === "idle") return;
        const result = await rpc("turn.cancel", {
          harnessId,
          threadId,
          ...(local.activeTurnId ? { turnId: local.activeTurnId } : {}),
        });
        if (result?.turn?.status === "failed") {
          throw new Error(result.turn.error?.message ?? "无法确认 Pi 已停止");
        }
      },
      async cancelByUser(requestId) {
        if (requestId && requestId !== state.activeRequestByThread.get(local.key)) return;
        return local.controller.cancel();
      },
      async resolvePending(toolCallId, answer = {}) {
        const pending = local.pending;
        if (!pending || pending.id !== toolCallId) return;
        await rpc("interaction.respond", {
          harnessId,
          interactionId: pending.hostInteractionId,
          response: {
            optionId: answer.optionId ?? answer.decision ?? "allow-once",
            ...(answer.answers === undefined ? {} : { answers: answer.answers }),
            ...(answer.userMessage === undefined ? {} : { userMessage: answer.userMessage }),
          },
        });
      },
      async rejectPending(toolCallId) {
        const pending = local.pending;
        if (!pending || pending.id !== toolCallId) return;
        await rpc("interaction.respond", {
          harnessId,
          interactionId: pending.hostInteractionId,
          response: { decision: "deny" },
        });
      },
      getPendingInfo: () => local.pending,
      requests: async () => {
        const page = pageFor(local);
        return { items: page.requests, total: page.requests.length, page: 1, hasOlder: false };
      },
      requestEntries: async () => pageFor(local),
      getRequest: (requestId) => local.requests.get(requestId),
      getRequestByClientRequestId: (requestId) => local.requests.get(requestId),
      getBackgroundTerminals: async () => [],
      userPrompts: async () => [],
      inputHistory: async () => [],
      artifacts: async () => (await loadFiles()).artifacts,
      files: async () => (await loadFiles()).files,
      changes: async () => (await loadFiles()).manifests,
      changeManifests: async () => (await loadFiles()).manifests,
      changeDetail: async value => loadFiles(value.detailRef),
      getCapacityQueueState: async () => null,
      cancelCapacityQueue: async () => undefined,
      getCloudServiceConfirmation: async () => undefined,
      getPluginRecommendation: async () => undefined,
      getSubAgents: () => [],
      getAgentTeams: () => [],
      onChildAgentEvent: () => () => {},
      clear: async () => unsupported("clear"),
      async compact() {
        await local.pendingConfiguration;
        const result = await rpc("thread.compact", { harnessId, threadId });
        local.contextUsageLoaded = false; void refreshPiContextUsage(local);
        emitLocal(local, "historyLoaded"); return result;
      },
      compactConversation: () => local.controller.compact(),
      resend: async () => unsupported("resend"),
      rewind,
      checkpointRead: readCheckpoint,
      rename: async (title) => renameExternal(id, title),
      preload: () => undefined,
      ensureRuntime: () => undefined,
      releaseRuntimeHold: () => undefined,
      async refreshContextUsage() {
        await refreshPiContextUsage(local);
        // This return value means category breakdown is unsupported. The native
        // provider clears its loading state immediately, without a 15s timeout.
        return { errorCode: "NOT_SUPPORTED", message: "Pi 仅提供当前上下文总量估算，原生分类明细暂不支持。" };
      },
      updateEstimatedCost: async () => undefined,
      loadToolDetail: async () => undefined,
      cancelBackgroundTask: async () => undefined,
      registerClientTools: async () => unsupported("client tools"),
      unregisterClientTools: async () => undefined,
      log: () => undefined,
      markExcludeLaunchSpecServers: async () => undefined,
      dispose: () => local.handlers.clear(),
    };

    const uiInput = {
      canSubmit: () => ["idle", "error"].includes(local.info.state),
      wouldQueue: () => false,
      canRegenerate: () => false,
      async sendPrompt(input, options) {
        const blocks = input?.blocks ?? input;
        if (config.nativeUi && isCompactInput(blocks)) {
          try { await local.controller.compact(); return { ok: true }; }
          catch (cause) { return { ok: false, error: { code: "conversation-compact-error", message: cause.message } }; }
        }
        return local.controller.sendPrompt(blocks, options);
      },
      cancel: () => local.controller.cancel(),
      resend: async () => unsupported("resend"),
      rewind,
      checkpointRead: readCheckpoint,
      resumeFromMessage: async () => unsupported("resumeFromMessage"),
      previewPrompt: () => undefined,
      getDraftBlocks: () => [...local.draftBlocks],
      applyPrefill: (blocks) => {
        local.draftBlocks = Array.isArray(blocks) ? [...blocks] : [];
        return "applied";
      },
      setDraftBlocks: (blocks) => {
        local.draftBlocks = Array.isArray(blocks) ? [...blocks] : [];
      },
      updateDraftBlocks: (updater) => {
        if (typeof updater !== "function") return;
        const next = updater([...local.draftBlocks]);
        if (Array.isArray(next)) local.draftBlocks = [...next];
      },
      insertDraftBlocks: (blocks, options) => {
        const values = Array.isArray(blocks) ? blocks : [];
        local.draftBlocks = options?.position === "start"
          ? [...values, ...local.draftBlocks]
          : [...local.draftBlocks, ...values];
      },
      setExpertSelection: (expert) => local.controller.configManager.setExpert(expert),
      focus: () => false,
    };
    const uiFacade = {
      input: uiInput,
      interaction: {
        resolve: (toolCallId, answer) => local.controller.resolvePending(toolCallId, answer),
        reject: (toolCallId) => local.controller.rejectPending(toolCallId),
        approvePlan: async () => unsupported("approvePlan"),
        adjustPlan: async () => unsupported("adjustPlan"),
        retryPlanAdjustment: async () => unsupported("retryPlanAdjustment"),
      },
      lifecycle: {
        clear: () => local.controller.clear(),
        rename: (title) => local.controller.rename(title),
        listUserPrompts: () => local.controller.userPrompts(),
        listInputHistory: () => local.controller.inputHistory(),
        ensureRequestLoaded: async (id) => local.controller.getRequest(id),
      },
      config: {
        setMode: (value) => local.controller.configManager.setMode(value),
        setModeLocal: (value) => local.controller.configManager.setMode(value),
        setModel: (value) => local.controller.configManager.setModel(value),
        setConnectors: (value) => local.controller.configManager.setConnectors(value),
        setExpertId: (value, options) => local.controller.configManager.setExpertId(value, options),
        setExpertLocal: (value, options) => local.controller.configManager.setExpertId(value, options),
        setPermissionMode: (value) => local.controller.configManager.setPermissionMode(value),
        setThoughtLevel: (value) => local.controller.configManager.setThoughtLevel(value),
        setPreMessageCompactPct: (value) => local.controller.configManager.setPreMessageCompactPct(value),
        setContextWindow: (value) => local.controller.configManager.setContextWindow(value),
      },
      assistant: {
        setDisplaySource: () => undefined,
        getDisplaySnapshot: () => ({ name: "Pi Agent" }),
      },
      error: { clear: () => undefined, retryLast: async () => false, canRetryLast: () => false },
      promptQueue: {
        sendNow: (id) => queueManager.sendNow(id),
        delete: (id) => queueManager.delete(id),
        move: (id, index) => queueManager.move(id, index),
      },
      task: { open: () => undefined },
      capacityQueue: { cancel: () => undefined },
      view: {
        detail: {
          open: async () => undefined,
          registerBeforeTargetChange: () => () => {},
        },
      },
    };
    Object.defineProperty(local.controller, "ui", {
      configurable: true,
      enumerable: false,
      value: uiFacade,
    });

    (thread.turns ?? []).forEach((turn, index) => makeRequest(local, turn, index));
    const pendingInteractions = (thread.turns ?? []).flatMap((turn) => [
      ...(turn.interaction ? [turn.interaction] : []),
      ...(Array.isArray(turn.interactions) ? turn.interactions : []),
    ]).filter((interaction) => interaction?.status === "pending");
    replacePendingQueue(local, pendingInteractions);
    return local;
  }

  function updateConversationFromThread(local, thread) {
    const previousWindow = local.thread?.contextWindow;
    const previousModel = local.thread?.models?.currentModelId;
    const previousSettings = JSON.stringify(local.thread?.executionSettings);
    local.thread = { ...local.thread, ...thread };
    local.info.title = conversationTitle(local.thread);
    local.info.isUserDefinedTitle = local.thread.userDefinedTitle ? 1 : 0;
    local.info.cwd = String(thread.cwd ?? local.info.cwd ?? "");
    local.info.space = { type: "local", cwd: local.info.cwd, autoGenerated: !local.info.cwd };
    if (config.nativeUi) local.info.space.autoGenerated = local.thread.workspaceAutoGenerated !== false;
    local.info.space.name = workspaceName(local.info.cwd);
    local.info.updatedAt = toTimestamp(thread.updatedAt ?? thread.completedAt, local.info.updatedAt);
    local.info.lastActivityAt = config.nativeUi ? conversationActivity(local.thread)
      : toTimestamp(thread.updatedAt ?? thread.completedAt, local.info.lastActivityAt);
    local.info.state = infoState(thread.status ?? local.info.state);
    const latestTurn = Array.isArray(thread.turns) ? thread.turns.at(-1) : undefined;
    if (
      local.info.state === "idle" &&
      ["failed", "error"].includes(String(latestTurn?.status ?? "").toLowerCase())
    ) local.info.state = "error";
    local.info.hasRunningBackgroundTasks = ["working", "pending"].includes(local.info.state);
    if (thread.activeTurnId !== undefined) local.activeTurnId = thread.activeTurnId ?? undefined;
    if (config.nativeUi && local.controller && (previousWindow !== local.thread.contextWindow
      || previousModel !== local.thread.models?.currentModelId)) emitContextWindowChange(local);
    if (config.nativeUi && local.controller && previousSettings !== JSON.stringify(local.thread.executionSettings)) emitExecutionSettingsChange(local);
  }

  function upsertThread(thread, { announce = true } = {}) {
    const threadId = String(thread?.id ?? thread?.threadId ?? "");
    const harnessId = String(thread?.harnessId ?? "");
    if (!threadId || !harnessId) return undefined;
    const key = threadKey(harnessId, threadId);
    state.threads.set(key, thread);
    let local = state.conversations.get(externalId(harnessId, threadId));
    if (!local) {
      local = createConversation(thread);
      state.conversations.set(local.id, local);
      if (announce) publishListChange([local.info], [], []);
    } else {
      const previousModel = local.thread?.models?.currentModelId;
      const previousCatalog = JSON.stringify(local.thread?.models?.availableModels ?? []);
      updateConversationFromThread(local, thread);
      const currentModel = local.thread?.models?.currentModelId;
      const catalogChanged = config.nativeUi
        && JSON.stringify(local.thread?.models?.availableModels ?? []) !== previousCatalog;
      if (currentModel !== previousModel || catalogChanged) {
        emitExternalModelChange(local);
        if (currentRouteId() === local.id) scheduleModelSelectorSync();
      }
      if (announce) emitInfo(local);
    }
    return local;
  }

  function dropThread(threadId, { harnessId, announce = true } = {}) {
    const parsed = parseExternalId(threadId);
    const rawThreadId = parsed?.threadId ?? String(threadId ?? "");
    const rawHarnessId = parsed?.harnessId ?? String(harnessId ?? "");
    const local = rawHarnessId
      ? state.conversations.get(externalId(rawHarnessId, rawThreadId))
      : [...state.conversations.values()].find((candidate) => candidate.threadId === rawThreadId);
    if (!local) return;
    const wasCurrent = currentRouteId() === local.id;
    local.controller.dispose();
    state.conversations.delete(local.id);
    state.threads.delete(local.key);
    state.activeRequestByThread.delete(local.key);
    state.pinnedExternalIds = state.pinnedExternalIds.filter((candidate) => candidate !== local.id);
    if (
      state.activeThreadId === local.threadId &&
      state.selectedHarnessId === local.harnessId
    ) state.activeThreadId = undefined;
    if (announce) publishListChange([], [], [local.id]);
    if (wasCurrent && state.wb) {
      void navigationGoto({ tab: "home" }).catch(() => {});
      void persistUiState({ active: false, activeThreadId: null }).catch(() => {});
    }
  }

  function matchesFilter(info, filter, space) {
    const effective = {
      ...(filter && typeof filter === "object" ? filter : {}),
      ...(filter?.filters && typeof filter.filters === "object" ? filter.filters : {}),
    };
    const requestedSpaceType = typeof space === "string" ? space : space?.type;
    if (requestedSpaceType && requestedSpaceType !== "local") return false;
    if (effective.view && effective.view !== "active") return false;
    if (effective.archived === true || effective.isArchived === true) return false;
    if (effective.transport && effective.transport !== "local") return false;
    const filterSpace = typeof effective.space === "string" ? effective.space : effective.space?.type;
    if (filterSpace && filterSpace !== "local") return false;
    if (config.nativeUi) {
      const requestedCwd = effective.workspacePath ?? effective.cwd ?? effective.space?.cwd ?? (typeof space === "object" ? space?.cwd : undefined);
      if (effective.workspacePath && effective.excludeWorkspace === true) throw new Error("工作区筛选不能同时排除工作区");
      if (effective.excludeWorkspace === true && info.space?.autoGenerated !== true) return false;
      if (typeof requestedCwd === "string") {
        const normalize = value => String(value ?? "").replace(/[\\/]+$/, "") || "/";
        if (requestedCwd === "") {
          if (info.space?.autoGenerated !== true) return false;
        } else if (info.space?.autoGenerated === true || normalize(requestedCwd) !== normalize(info.cwd)) return false;
      }
    }
    if (effective.status) {
      const statuses = Array.isArray(effective.status) ? effective.status : [effective.status];
      if (!statuses.includes(info.state)) return false;
    }
    if (effective.keyword && !info.title.toLowerCase().includes(String(effective.keyword).toLowerCase())) return false;
    const originFilter = effective.conversationOrigin;
    if (originFilter) {
      const origins = Array.isArray(originFilter)
        ? originFilter
        : String(originFilter).split(",").map((entry) => entry.trim());
      if (!origins.includes(info.conversationOrigin) && !origins.includes("local")) return false;
    }
    return config.nativeUi || Number(effective.page ?? 1) <= 1;
  }

  function externalInfos(filter, space) {
    return [...state.conversations.values()]
      .map((local) => local.info)
      .filter((info) => matchesFilter(info, filter, space));
  }

  function appendUnique(items, additions) {
    const source = Array.isArray(items) ? items : [];
    const seen = new Set(source.map((item) => item?.id));
    return [...source, ...additions.filter((item) => !seen.has(item.id))];
  }

  function mergeListResult(result, additions) {
    if (!additions.length) return result;
    if (Array.isArray(result)) return appendUnique(result, additions);
    if (!result || typeof result !== "object") return result;
    const merged = { ...result };
    const existing = Array.isArray(result.items) ? result.items : Array.isArray(result.conversations) ? result.conversations : [];
    const existingIds = new Set(existing.map((item) => item?.id));
    const uniqueAdditions = additions.filter((item) => !existingIds.has(item.id));
    const addedCount = config.nativeUi ? uniqueAdditions.length : additions.length;
    if (Array.isArray(result.items)) merged.items = appendUnique(result.items, additions);
    if (Array.isArray(result.conversations)) merged.conversations = appendUnique(result.conversations, additions);
    if (!Array.isArray(result.items) && !Array.isArray(result.conversations)) merged.items = additions;
    if (typeof result.total === "number") merged.total = result.total + addedCount;
    if (typeof result.independentTotal === "number") {
      merged.independentTotal = result.independentTotal + (config.nativeUi
        ? uniqueAdditions.filter((item) => item.space?.type === "local" && item.space.autoGenerated === true).length
        : addedCount);
    }
    if (typeof result.totalCount === "number") merged.totalCount = result.totalCount + addedCount;
    return merged;
  }

  function nativeListPage(result, additions, filter = {}) {
    if (!result || typeof result !== "object" || Array.isArray(result) || !Array.isArray(result.items)) return mergeListResult(result, additions);
    const page = Math.max(1, Number(filter.page ?? 1)), size = Math.max(1, Number(filter.size ?? 50));
    if (!Number.isSafeInteger(page) || !Number.isSafeInteger(size) || !Number.isSafeInteger(page * size)) throw new Error("Invalid task list pagination");
    const merged = mergeListResult(result, additions);
    const items = [...merged.items].sort((a, b) => Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned))
      || toTimestamp(b.lastActivityAt ?? b.createdAt, 0) - toTimestamp(a.lastActivityAt ?? a.createdAt, 0));
    return { ...merged, items: items.slice((page - 1) * size, page * size), page: { current: page, size },
      ...(typeof result.hasMore === "boolean" && typeof merged.total === "number" ? { hasMore: page * size < merged.total } : {}) };
  }

  async function callOriginal(method, ...args) {
    const fn = state.originalConversations?.[method];
    if (typeof fn !== "function") throw new Error(`WorkBuddy conversations.${method} is unavailable`);
    return fn.apply(state.originalConversations, args);
  }

  async function renameExternal(id, title) {
    const local = state.conversations.get(id);
    if (!local) return;
    const value = String(title ?? "").trim();
    if (!value) throw new Error("Conversation title cannot be empty");
    if (config.nativeUi) {
      const result = await rpc("thread.rename", { harnessId: local.harnessId, threadId: local.threadId, title: value });
      updateConversationFromThread(local, result?.thread ?? result);
      emitInfo(local);
      return;
    }
    local.info.title = value;
    local.info.updatedAt = Date.now();
    local.info.lastActivityAt = local.info.updatedAt;
    local.thread = { ...local.thread, title: value };
    emitInfo(local);
  }

  async function deleteExternal(id) {
    const local = state.conversations.get(id);
    if (!local) return;
    await rpc("thread.delete", { harnessId: local.harnessId, threadId: local.threadId });
    dropThread(local.threadId, { harnessId: local.harnessId });
    if (currentRouteId() === id) await navigationGoto({ tab: "home" });
  }

  function currentRouteId() {
    const route = String(state.wb?.navigation?.route ?? globalThis.location?.pathname ?? "");
    const matched = /^\/(?:conversation|task)\/([^/?#]+)/.exec(route);
    if (matched) {
      try {
        return decodeURIComponent(matched[1]);
      } catch {
        return matched[1];
      }
    }
    const currentId = state.wb?.conversations?.currentId;
    return typeof currentId === "string" && currentId ? currentId : undefined;
  }

  function externalModelOptions(local) {
    const available = Array.isArray(local?.thread?.models?.availableModels)
      ? local.thread.models.availableModels
      : [];
    const seen = new Set();
    const result = [];
    for (const model of available) {
      const id = typeof model?.id === "string" ? model.id.trim() : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push({
        id,
        name: typeof model.name === "string" && model.name.trim() ? model.name : id,
        ...(typeof model.description === "string" && model.description
          ? { description: model.description }
          : {}),
        ...(model.isDefault === true ? { isDefault: true } : {}),
        disabled: model.disabled === true,
        configurable: false,
        configured: true,
        supportsImages: model.supportsImages === true || model.input?.includes?.("image") === true,
        supportsReasoning: model.supportsReasoning === true || model.reasoning === true,
        ...(Number.isSafeInteger(model.contextWindow) ? {
          maxInputTokens: model.maxInputTokens ?? model.contextWindow,
          contextWindow: { defaultLength: model.contextWindow,
            supportedLengths: model.supportedContextWindows ?? [model.contextWindow] },
        } : {}),
      });
    }
    const currentModelId = local?.thread?.models?.currentModelId;
    if (typeof currentModelId === "string" && currentModelId && !seen.has(currentModelId)) {
      result.push({
        id: currentModelId,
        name: currentModelId,
        disabled: false,
        configurable: false,
        configured: true,
        supportsImages: false,
        supportsReasoning: false,
      });
    }
    return result;
  }

  function emitExternalModelChange(local) {
    const currentModel = String(local?.thread?.models?.currentModelId ?? "");
    if (!currentModel && !config.nativeUi) return;
    emitLocal(local, "modelChange", {
      conversationId: local.id,
      models: externalModelOptions(local),
      currentModel,
    });
  }

  function emitContextWindowChange(local) {
    if (!config.nativeUi || !Number.isSafeInteger(local.thread.contextWindow) || local.thread.contextWindow <= 1) return;
    const key = `${local.thread.models?.currentModelId}\u0000${local.thread.contextWindow}`;
    if (local.contextWindowEventKey === key) { publishContextUsage(local); return; }
    local.contextWindowEventKey = key;
    local.contextUsageVersion = (local.contextUsageVersion ?? 0) + 1;
    local.contextUsageWindow = local.thread.contextWindow;
    local.contextUsageLoaded = false;
    emitLocal(local, "configUpdate", { conversationId: local.id,
      options: [{ key: "context_window", value: String(local.thread.contextWindow) }] });
    publishContextUsage(local);
  }

  function emitExecutionSettingsChange(local) {
    if (!config.nativeUi || local.thread.executionSettings?.status !== "available") return;
    const value = local.thread.executionSettings, key = `${value.thinkingLevel}\u0000${value.preMessageCompactPct}`;
    if (local.executionSettingsKey === key) return;
    local.executionSettingsKey = key;
    emitLocal(local, "configUpdate", { conversationId: local.id, options: [
      { key: "thought_level", value: value.thinkingLevel === "off" ? "disabled" : value.thinkingLevel },
      { key: "preMessageCompactPct", value: value.preMessageCompactPct == null ? "" : String(value.preMessageCompactPct) },
    ] });
  }

  function activeExternalConversation() {
    return state.conversations.get(currentRouteId());
  }

  function closeModelPopover() {
    try {
      state.releaseModelPopoverGuards?.();
    } catch {}
    state.releaseModelPopoverGuards = undefined;
    const retainedListeners = [];
    for (const entry of state.modelSelectorListeners) {
      if (!entry.popover) {
        retainedListeners.push(entry);
        continue;
      }
      try {
        entry.node.removeEventListener(entry.type, entry.listener);
      } catch {}
    }
    state.modelSelectorListeners = retainedListeners;
    try {
      state.modelPopoverNode?.remove();
    } catch {}
    state.modelPopoverNode = undefined;
    const button = state.modelSelectorNode?.__workbuddyHostButton;
    button?.setAttribute?.("aria-expanded", "false");
    button?.classList?.remove?.("cr-model-selector__trigger--open");
  }

  function updateModelSelectorNode() {
    const node = state.modelSelectorNode;
    if (!node) return;
    const local = activeExternalConversation();
    const models = externalModelOptions(local);
    const currentModelId = String(local?.thread?.models?.currentModelId ?? "");
    const selected = models.find((model) => model.id === currentModelId);
    const label = node.__workbuddyHostLabel;
    const button = node.__workbuddyHostButton;
    const nextLabel = selected?.name || currentModelId || (config.officialModels ? "选择官方模型" : "选择模型");
    if (label && label.textContent !== nextLabel) label.textContent = nextLabel;
    if (button) {
      const disabled = !local || models.length === 0 || state.modelSwitchBusy;
      button.disabled = disabled;
      button.setAttribute("aria-disabled", String(disabled));
      button.classList?.toggle?.("cr-model-selector__trigger--disabled", disabled);
      button.title = selected?.description || nextLabel;
    }
  }

  async function selectExternalModel(local, modelId) {
    if (state.modelSwitchBusy || !local) return;
    state.modelSwitchBusy = true;
    updateModelSelectorNode();
    try {
      await local.controller.configManager.setModel(modelId);
      closeModelPopover();
    } catch {
      try {
        state.wb?.ui?.toast?.({ message: "外部模型切换失败", type: "error" });
      } catch {}
    } finally {
      state.modelSwitchBusy = false;
      updateModelSelectorNode();
    }
  }

  function openModelPopover() {
    const document = globalThis.document;
    const local = activeExternalConversation();
    const models = externalModelOptions(local);
    const node = state.modelSelectorNode;
    const trigger = node?.__workbuddyHostButton;
    if (!document?.body || !local || !trigger || models.length === 0) return;
    if (state.modelPopoverNode) {
      closeModelPopover();
      return;
    }

    const popover = document.createElement("div");
    popover.className = "cr-popover cr-model-selector__popover workbuddy-host-model-popover";
    popover.dataset.workbuddyHostModelPopover = config.bindingName;
    popover.setAttribute("role", "listbox");
    const rect = trigger.getBoundingClientRect?.() ?? {
      left: 16,
      top: Math.max(48, Number(globalThis.innerHeight ?? 800) - 160),
      bottom: Math.max(80, Number(globalThis.innerHeight ?? 800) - 128),
      width: 180,
    };
    popover.style.position = "fixed";
    const viewportWidth = Number(globalThis.innerWidth) || 1024;
    const popoverWidth = Math.min(320, Math.max(160, viewportWidth - 16));
    popover.style.width = `${popoverWidth}px`;
    popover.style.left = `${Math.max(8, Math.min(Number(rect.left) || 8, viewportWidth - popoverWidth - 8))}px`;
    popover.style.bottom = `${Math.max(8, Number(globalThis.innerHeight ?? 800) - (Number(rect.top) || 0) + 4)}px`;
    popover.style.zIndex = "2147483000";
    popover.style.maxHeight = `${Math.max(120, Math.min(480, (Number(rect.top) || 480) - 16))}px`;
    popover.style.overflowY = "auto";

    const menu = document.createElement("div");
    menu.className = "cr-menu cr-model-selector__menu";
    const selectedId = String(local.thread?.models?.currentModelId ?? "");
    for (const model of models) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `cr-menu-item cr-model-selector__item${model.id === selectedId ? " cr-model-selector__item--selected" : ""}`;
      item.dataset.modelId = model.id;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(model.id === selectedId));
      item.disabled = model.disabled === true;
      if (item.disabled) item.title = "当前账号暂不可用，请检查官方模型权限。";
      const content = document.createElement("span");
      content.className = "cr-model-selector__item-content";
      const info = document.createElement("span");
      info.className = "cr-model-selector__item-info";
      const name = document.createElement("span");
      name.className = "cr-model-selector__item-name";
      name.textContent = model.name;
      info.append(name);
      if (model.description && model.description !== model.name) {
        const description = document.createElement("span");
        description.className = "workbuddy-host-model-description";
        description.textContent = model.description;
        info.append(description);
      }
      content.append(info);
      item.append(content);
      if (model.id === selectedId) {
        const check = document.createElement("span");
        check.className = "cr-model-selector__item-check";
        check.textContent = "✓";
        item.append(check);
      }
      const listener = (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        void selectExternalModel(local, model.id);
      };
      item.addEventListener("click", listener);
      state.modelSelectorListeners.push({ node: item, type: "click", listener, popover: true });
      menu.append(item);
    }
    popover.append(menu);
    document.body.append(popover);
    state.modelPopoverNode = popover;
    trigger.setAttribute("aria-expanded", "true");
    trigger.classList?.add?.("cr-model-selector__trigger--open");

    const closeOnPointer = (event) => {
      if (node.contains?.(event.target) || popover.contains?.(event.target)) return;
      closeModelPopover();
    };
    const closeOnKey = (event) => {
      if (event.key === "Escape") closeModelPopover();
    };
    document.addEventListener?.("pointerdown", closeOnPointer, true);
    document.addEventListener?.("keydown", closeOnKey, true);
    state.releaseModelPopoverGuards = () => {
      document.removeEventListener?.("pointerdown", closeOnPointer, true);
      document.removeEventListener?.("keydown", closeOnKey, true);
    };
  }

  function removeModelSelectorNode() {
    closeModelPopover();
    for (const entry of state.modelSelectorListeners.splice(0)) {
      try {
        entry.node.removeEventListener(entry.type, entry.listener);
      } catch {}
    }
    try {
      state.modelSelectorNode?.remove();
    } catch {}
    state.modelSelectorNode = undefined;
  }

  function ensureModelSelectorNode() {
    if (config.nativeUi) return;
    if (state.disposed || sourceMode() !== "external") {
      removeModelSelectorNode();
      return;
    }
    const document = globalThis.document;
    const nativeTrigger = document?.querySelector?.(
      '[data-view-id="main-content"] .cr-model-selector__trigger',
    ) ?? document?.querySelector?.(".cr-model-selector__trigger");
    const nativeRoot = nativeTrigger?.closest?.(".cr-model-selector") ?? nativeTrigger?.parentNode;
    const host = nativeRoot?.parentNode;
    if (!document || !host) {
      removeModelSelectorNode();
      return;
    }
    if (state.modelSelectorNode?.parentNode === host) {
      updateModelSelectorNode();
      return;
    }
    removeModelSelectorNode();
    const root = document.createElement("span");
    root.className = "cr-model-selector workbuddy-host-model-selector";
    root.dataset.workbuddyHostModelSelector = config.bindingName;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cr-model-selector__trigger";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    const left = document.createElement("span");
    left.className = "cr-model-selector__trigger-left";
    const label = document.createElement("span");
    label.className = "cr-model-selector__trigger-label";
    left.append(label);
    const arrow = document.createElement("span");
    arrow.className = "cr-model-selector__trigger-arrow";
    arrow.textContent = "⌄";
    button.append(left, arrow);
    root.append(button);
    root.__workbuddyHostButton = button;
    root.__workbuddyHostLabel = label;
    const listener = (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      openModelPopover();
    };
    button.addEventListener("click", listener);
    state.modelSelectorListeners.push({ node: button, type: "click", listener });
    if (typeof nativeRoot.after === "function") nativeRoot.after(root);
    else host.append(root);
    state.modelSelectorNode = root;
    updateModelSelectorNode();
  }

  function scheduleModelSelectorSync() {
    if (config.nativeUi || state.disposed || state.modelSelectorSyncScheduled) return;
    state.modelSelectorSyncScheduled = true;
    queueMicrotask(() => {
      state.modelSelectorSyncScheduled = false;
      ensureModelSelectorNode();
    });
  }

  function isOwnedExternalId(id) {
    return isExternalId(id) && state.conversations.has(id);
  }

  function sourceMode() {
    return config.exclusive || isOwnedExternalId(currentRouteId()) || state.externalCreatePending
      ? "external"
      : "native";
  }

  function isHomeRoute() {
    const route = String(state.wb?.navigation?.route ?? globalThis.location?.pathname ?? "");
    return route === "/" || route === "/home";
  }

  function installExternalCreateIntentListener() {
    if (config.nativeUi) return;
    if (state.releaseExternalCreateIntent) return;
    const document = globalThis.document;
    if (typeof document?.addEventListener !== "function") return;
    const listener = (event) => {
      const trigger = event?.target?.closest?.(
        '[data-track-id="agent_new_task_button_clicked"]',
      );
      if (!trigger || (!config.exclusive && !isOwnedExternalId(currentRouteId()))) return;
      if (config.exclusive) {
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        void openExclusiveComposer().catch((error) => {
          state.error = error instanceof Error ? error : new Error(String(error));
        });
        return;
      }
      state.externalCreatePending = true;
      setExternalControlsActive(config.exclusive);
      scheduleSourceSwitchSync();
    };
    document.addEventListener("click", listener, true);
    state.releaseExternalCreateIntent = () => {
      document.removeEventListener("click", listener, true);
    };
  }

  function removeSourceSwitchNode() {
    for (const { node, type, listener } of state.sourceSwitchListeners.splice(0)) {
      try {
        node.removeEventListener(type, listener);
      } catch {}
    }
    try {
      state.sourceSwitchNode?.remove();
    } catch {}
    state.sourceSwitchNode = undefined;
    state.officeRestoreNode?.remove();
    state.officeRestoreNode = undefined;
  }

  function syncOfficeRestoreButton(host) {
    const local = state.conversations.get(currentRouteId());
    const turnId = local?.thread?.officeRestoreTurnId;
    const enabled = state.harnesses.get(local?.harnessId)?.capabilities?.officeRestore === true;
    if (!enabled || !turnId || !["idle", "error"].includes(local.info.state)) {
      state.officeRestoreNode?.remove();
      state.officeRestoreNode = undefined;
      return;
    }
    if (!state.officeRestoreNode) {
      const button = globalThis.document.createElement("button");
      button.type = "button";
      button.className = "wb-segmented__item wb-segmented__item--string-label";
      button.textContent = "恢复本轮文档";
      button.addEventListener("click", async () => {
        const target = state.conversations.get(currentRouteId());
        const targetTurnId = target?.thread?.officeRestoreTurnId;
        if (state.officeRestorePending || !targetTurnId || !["idle", "error"].includes(target.info.state)) return;
        if (!globalThis.confirm("恢复本轮保存前的本机文档？远端对话历史会保留。")) return;
        state.officeRestorePending = true;
        button.disabled = true;
        try {
          const result = await rpc("thread.office.restore", {
            harnessId: target.harnessId, threadId: target.threadId, turnId: targetTurnId,
          });
          if (result?.ok !== true || result.scope !== "local-files") throw new Error("本机文档恢复未完成");
          if (result.thread) updateConversationFromThread(target, result.thread);
          state.wb.ui?.toast?.({ message: "本机文档已恢复", type: "success" });
        } catch (error) {
          state.wb.ui?.toast?.({ message: error.message, type: "error" });
        } finally {
          state.officeRestorePending = false;
          button.disabled = false;
          scheduleSourceSwitchSync();
        }
      });
      state.officeRestoreNode = button;
      host.append(button);
    }
  }

  function sourceSwitchHost() {
    const document = globalThis.document;
    return document?.querySelector?.(
      '[data-testid="conversation-topbar"] .workbuddy-topbar-actions',
    )
      ?? document?.querySelector?.(
        '[data-testid="conversation-topbar"] .workbuddy-topbar__actions',
      )
      ?? document?.querySelector?.('.workbuddy-topbar-actions')
      ?? document?.querySelector?.('.workbuddy-topbar__actions')
      ?? document?.querySelector?.('[class*="conversation-topbar"] [class*="topbar-actions"]')
      ?? (isHomeRoute() && ["5.11.2", "5.11.3"].includes(readWorkBuddyRendererIdentity().version)
        ? document?.querySelector?.('[data-testid="titlebar-row"] .titlebar-row__actions')
        : undefined);
  }

  function updateSourceSwitchNode() {
    const node = state.sourceSwitchNode;
    if (!node) return;
    if (config.exclusive) {
      const loading = state.waitReason === "official-models";
      const label = loading ? "Pi · 正在连接官方模型" : "Pi 引擎";
      if (node.textContent !== label) node.textContent = label;
      node.title = loading ? state.error?.message ?? "正在等待官方模型目录" : "任务由 Pi Agent 执行，仅支持文本和已启用的工具";
      return;
    }
    const mode = sourceMode();
    const busy = state.sourceSwitchBusy > 0;
    let activeButton;
    let thumb;
    for (const button of node.children ?? []) {
      if (button.classList?.contains?.("wb-segmented__thumb")) {
        thumb = button;
        continue;
      }
      const buttonMode = button.dataset?.sourceMode;
      if (!buttonMode) continue;
      const checked = buttonMode === mode;
      button.setAttribute("aria-checked", String(checked));
      button.classList?.toggle?.("wb-segmented__item--active", checked);
      button.tabIndex = checked ? 0 : -1;
      button.disabled = busy;
      button.setAttribute("aria-disabled", String(busy));
      if (checked) activeButton = button;
    }
    const width = Number(activeButton?.offsetWidth);
    const left = Number(activeButton?.offsetLeft);
    if (thumb && width > 0 && Number.isFinite(left)) {
      node.style?.setProperty?.("--wb-segmented-thumb-width", `${width}px`);
      node.style?.setProperty?.("--wb-segmented-thumb-left", `${left}px`);
      thumb.classList?.add?.("wb-segmented__thumb--measured");
    }
  }

  function rememberCurrentSource() {
    const id = currentRouteId();
    if (isOwnedExternalId(id)) state.lastExternalId = id;
    else if (id && !isExternalId(id)) state.lastNativeConversationId = id;
    const isExternal = isOwnedExternalId(id);
    setExternalControlsActive(isExternal || (config.exclusive && isHomeRoute()));
    if (isExternal) {
      void persistCurrentExternalRoute().catch((error) => {
        state.error = error instanceof Error ? error : new Error(String(error));
      });
    }
  }

  function ensureSourceSwitchNode() {
    if (config.nativeUi || state.disposed) return;
    rememberCurrentSource();
    if (config.exclusive && state.status === "ready" && isHomeRoute()) {
      void openExclusiveComposer().catch((error) => {
        state.error = error instanceof Error ? error : new Error(String(error));
      });
    }
    const host = sourceSwitchHost();
    if (!host) {
      removeSourceSwitchNode();
      return;
    }
    if (state.sourceSwitchNode?.parentNode === host) {
      updateSourceSwitchNode();
      syncOfficeRestoreButton(host);
      return;
    }
    removeSourceSwitchNode();
    const document = globalThis.document;
    if (typeof document?.createElement !== "function") return;
    const segmented = document.createElement("div");
    if (config.exclusive) {
      segmented.className = "workbuddy-host-engine-label";
      segmented.dataset.workbuddyHostEngine = "pi";
      segmented.setAttribute("role", "status");
      segmented.setAttribute("aria-label", "执行引擎：Pi Agent");
      segmented.title = "任务由 Pi Agent 执行，仅支持文本和已启用的工具";
      segmented.textContent = "Pi 引擎";
      host.append(segmented);
      state.sourceSwitchNode = segmented;
      updateSourceSwitchNode();
      return;
    }
    segmented.className = "wb-segmented wb-segmented--small wb-segmented--round workbuddy-host-source-switch";
    segmented.dataset.workbuddyHostSourceSwitch = config.bindingName;
    segmented.setAttribute("role", "radiogroup");
    segmented.setAttribute("aria-label", "会话来源");
    const thumb = document.createElement("span");
    thumb.className = "wb-segmented__thumb";
    thumb.setAttribute("aria-hidden", "true");
    segmented.append(thumb);
    for (const [mode, label] of [["native", "原生"], ["external", "Pi 外部"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wb-segmented__item wb-segmented__item--string-label";
      button.dataset.sourceMode = mode;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-label", label);
      const text = document.createElement("span");
      text.className = "wb-segmented__item-label";
      text.textContent = label;
      button.append(text);
      const listener = () => {
        void switchSource(mode).catch((error) => {
          state.error = error instanceof Error ? error : new Error(String(error));
        });
      };
      button.addEventListener("click", listener);
      state.sourceSwitchListeners.push({ node: button, type: "click", listener });
      segmented.append(button);
    }
    host.append(segmented);
    state.sourceSwitchNode = segmented;
    updateSourceSwitchNode();
    syncOfficeRestoreButton(host);
  }

  function scheduleSourceSwitchSync() {
    scheduleContextUsageTipSync();
    if (config.nativeUi || state.disposed || state.sourceSwitchSyncScheduled) return;
    state.sourceSwitchSyncScheduled = true;
    queueMicrotask(() => {
      state.sourceSwitchSyncScheduled = false;
      ensureSourceSwitchNode();
      ensureModelSelectorNode();
    });
  }

  function installSourceSwitchObserver() {
    if (config.nativeUi) return;
    scheduleSourceSwitchSync();
    const Observer = globalThis.MutationObserver;
    const root = globalThis.document?.documentElement;
    if (typeof Observer !== "function" || !root || state.sourceSwitchObserver) return;
    state.sourceSwitchObserver = new Observer(() => {
      scheduleSourceSwitchSync();
      scheduleModelSelectorSync();
    });
    state.sourceSwitchObserver.observe(root, { childList: true, subtree: true });
  }

  function setExternalControlsActive(active) {
    if (config.nativeUi) return;
    const body = globalThis.document?.body;
    if (active) body?.classList?.add(config.activeBodyClass);
    else body?.classList?.remove(config.activeBodyClass);
  }

  function installControlGuardStyle() {
    if (config.nativeUi) return;
    const document = globalThis.document;
    if (!document?.head || state.controlStyle) return;
    const style = document.createElement("style");
    style.dataset.workbuddyHostOwner = config.bindingName;
    style.textContent = `
      body.${config.activeBodyClass} [data-view-id="main-content"] .cr-add-menu__trigger,
      body.${config.activeBodyClass} [data-view-id="main-content"] .cr-permission-setting,
      body.${config.activeBodyClass} [data-conversation-id^="wbhost:"] button,
      body.${config.activeBodyClass} [data-view-id="main-content"] .workbuddy-topbar-edit-button,
      body.${config.activeBodyClass} [data-view-id="main-content"] button[aria-label="分享"],
      body.${config.activeBodyClass} [data-view-id="main-content"] button[aria-label="编辑"],
      body.${config.activeBodyClass} [data-view-id="main-content"] button[aria-label="点赞"],
      body.${config.activeBodyClass} [data-view-id="main-content"] button[aria-label="点踩"],
      body.${config.activeBodyClass} [data-view-id="main-content"] button[aria-label="更多操作"],
      body.${config.activeBodyClass} [data-view-id="main-content"] button[aria-label^="点击将重新生成"] {
        display: none !important;
      }
      body.${config.activeBodyClass} [data-view-id="main-content"] .cr-model-selector__trigger {
        display: none !important;
      }
      body.${config.activeBodyClass} [data-workbuddy-host-model-selector] .cr-model-selector__trigger,
      body.${config.activeBodyClass} [data-workbuddy-host-model-popover] .cr-model-selector__item {
        display: flex !important;
      }
      [data-workbuddy-host-model-popover] {
        box-sizing: border-box;
        padding: 6px;
        border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
        border-radius: 12px;
        background: Canvas;
        color: CanvasText;
        color-scheme: light dark;
        box-shadow: 0 8px 28px #0003;
      }
      [data-workbuddy-host-model-popover] .cr-model-selector__item {
        box-sizing: border-box;
        width: 100%;
        min-height: 36px;
        padding: 8px 10px;
        gap: 8px;
        justify-content: space-between;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      [data-workbuddy-host-model-popover] .cr-model-selector__item:hover,
      [data-workbuddy-host-model-popover] .cr-model-selector__item--selected {
        background: color-mix(in srgb, CanvasText 8%, transparent);
      }
      [data-workbuddy-host-model-popover] .cr-model-selector__item:disabled {
        opacity: .45;
        cursor: default;
      }
      [data-workbuddy-host-model-popover] .cr-model-selector__item-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
        overflow-wrap: anywhere;
      }
      [data-workbuddy-host-model-popover] .workbuddy-host-model-description {
        font-size: 11px;
        opacity: .65;
      }
      [data-workbuddy-host-source-switch] {
        flex: 0 0 auto;
      }
      body.${config.activeBodyClass} [data-view-id="main-content"] [data-workbuddy-host-source-switch] button {
        display: inline-flex !important;
      }
      body.${config.activeBodyClass} [data-view-id="main-content"] [data-slate-placeholder="true"] {
        font-size: 0 !important;
      }
      body.${config.activeBodyClass} [data-view-id="main-content"] [data-slate-placeholder="true"]::after {
        content: "仅支持文本，发送给外部 Harness";
        font-size: 14px;
      }
    `;
    document.head.append(style);
    state.controlStyle = style;
  }

  function createConversationsMux(original) {
    const bound = new Map();
    const includeNativeLists = !config.exclusive || config.nativeUi;
    const nativeHistoryFacades = new Map();
    const nativeHistoryLoads = new Map();
    const nativeListFilters = new Map();
    let latestLocalFilter = {};
    async function nativeList(query, filter, space) {
      if (!config.nativeUi) return mergeListResult(await query(filter), externalInfos(filter, space));
      const originalFilter = filter ?? {}, page = Math.max(1, Number(originalFilter.page ?? 1)), size = Math.max(1, Number(originalFilter.size ?? 50));
      if (!Number.isSafeInteger(page) || !Number.isSafeInteger(size) || !Number.isSafeInteger(page * size)) throw new Error("Invalid task list pagination");
      // Keep the original provider family; local's large Sidebar query must not
      // be converted into a generic list query that also reaches cloud providers.
      const base = await query({ ...originalFilter, page: 1, size: page * size });
      return nativeListPage(base, externalInfos(originalFilter, space), originalFilter);
    }
    const historyReadMethods = new Set([
      "on", "onChildAgentEvent", "requests", "requestEntries", "getRequest",
      "getRequestByClientRequestId", "userPrompts", "inputHistory",
    ]);
    const historyNoopMethods = new Set([
      "start", "preload", "ensureRuntime", "releaseRuntimeHold",
      "refreshContextUsage", "updateEstimatedCost", "dispose",
    ]);
    const readonlyHistoryError = () => new Error("此原生历史会话只读，请新建对话使用 Pi。该操作不会启动原生执行引擎。");
    function nativeHistoryFacade(controller) {
      const objects = new WeakMap();
      const methods = new WeakMap();
      function wrap(target, path = "") {
        if (!target || typeof target !== "object") return target;
        if (objects.has(target)) return objects.get(target);
        const proxy = new Proxy(target, {
          get(object, property) {
            const value = Reflect.get(object, property, object);
            if (typeof value !== "function") return wrap(value, path ? `${path}.${String(property)}` : String(property));
            let cached = methods.get(object);
            if (!cached) { cached = new Map(); methods.set(object, cached); }
            if (cached.has(property)) return cached.get(property);
            const name = String(property);
            let method;
            if (!path && historyReadMethods.has(name)) method = value.bind(object);
            else if (!path && historyNoopMethods.has(name)) method = async () => undefined;
            else if (path === "configManager" && name === "setSandboxMode") method = async () => false;
            else if (path === "configManager" && name === "setPermissionMode") method = async () => undefined;
            else if (path === "ui.input" && ["canSubmit", "canRegenerate", "wouldQueue", "focus"].includes(name)) method = () => false;
            else if (path === "ui.input" && name === "getDraftBlocks") method = () => [];
            else if (Array.isArray(object) && (
              property === Symbol.iterator
              || ["at", "concat", "entries", "every", "filter", "find", "findIndex", "flat", "flatMap", "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf", "map", "reduce", "reduceRight", "slice", "some", "toReversed", "toSorted", "toString", "values", "with"].includes(name)
            )) method = value.bind(proxy);
            else method = () => { throw readonlyHistoryError(); };
            cached.set(property, method);
            return method;
          },
          set() { throw readonlyHistoryError(); },
          defineProperty() { throw readonlyHistoryError(); },
          deleteProperty() { throw readonlyHistoryError(); },
        });
        objects.set(target, proxy);
        return proxy;
      }
      return wrap(controller);
    }
    async function getNativeHistory(id) {
      if (nativeHistoryFacades.has(id)) return nativeHistoryFacades.get(id);
      if (nativeHistoryLoads.has(id)) return nativeHistoryLoads.get(id);
      const operation = (async () => {
        // Metadata lookup cannot create a native runtime. Do not call get for
        // cloud or unknown transports, whose lazy creation is not established.
        const result = await callOriginal("listByIds", [id]);
        const infos = Array.isArray(result) ? result
          : Array.isArray(result?.items) ? result.items
            : Array.isArray(result?.conversations) ? result.conversations : [];
        const info = infos.find((candidate) => candidate?.id === id);
        if (info?.transport !== "local") {
          throw new Error("该历史会话尚未接入 Pi，目前仅支持查看本地历史。请新建对话使用 Pi。");
        }
        const controller = await callOriginal("get", id);
        if (!controller || controller.info?.transport !== "local") {
          throw new Error("本地历史会话不可用，请新建对话使用 Pi。");
        }
        const facade = nativeHistoryFacade(controller);
        nativeHistoryFacades.set(id, facade);
        return facade;
      })();
      nativeHistoryLoads.set(id, operation);
      try { return await operation; }
      finally { nativeHistoryLoads.delete(id); }
    }
    const exclusiveList = (filter, space) => {
      const items = externalInfos(filter, space);
      return {
        items,
        total: items.length,
        totalCount: items.length,
        independentTotal: items.length,
        page: Number(filter?.page ?? 1),
      };
    };
    const overrides = {
      async get(id) {
        if (isExternalId(id)) {
          // Sidebar routes can load a conversation without reporting it through
          // setCurrentConversation. Only the actual route may persist selection.
          if (currentRouteId() === id) rememberCurrentSource();
          return state.conversations.get(id)?.controller;
        }
        if (config.nativeUi && config.exclusive) return getNativeHistory(id);
        return config.exclusive ? undefined : callOriginal("get", id);
      },
      async list(filter) {
        if (!includeNativeLists) return exclusiveList(filter);
        return nativeList((value) => callOriginal("list", value), filter);
      },
      async listScope(space, filter) {
        if (!includeNativeLists) return exclusiveList(filter, space);
        return nativeList((value) => callOriginal("listScope", space, value), filter, space);
      },
      async listByIds(ids) {
        const requested = Array.isArray(ids) ? ids : [];
        const nativeIds = requested.filter((id) => !isExternalId(id));
        const native = includeNativeLists && nativeIds.length ? await callOriginal("listByIds", nativeIds) : [];
        const additions = requested
          .filter((id) => isExternalId(id))
          .map((id) => state.conversations.get(id)?.info)
          .filter(Boolean);
        return mergeListResult(native, additions);
      },
      async ensureList(space, filter) {
        if (config.nativeUi && space === "local") {
          latestLocalFilter = { ...(filter ?? {}) };
          if (typeof filter?.traceId === "string") {
            nativeListFilters.set(filter.traceId, latestLocalFilter);
            if (nativeListFilters.size > 64) nativeListFilters.delete(nativeListFilters.keys().next().value);
          }
        }
        if (includeNativeLists) {
          if (config.nativeUi && space === "local") {
            const page = Math.max(1, Number(filter?.page ?? 1)), size = Math.max(1, Number(filter?.size ?? 50));
            if (!Number.isSafeInteger(page) || !Number.isSafeInteger(size) || !Number.isSafeInteger(page * size)) throw new Error("Invalid task list pagination");
            return callOriginal("ensureList", space, { ...(filter ?? {}), page: 1, size: page * size });
          }
          return callOriginal("ensureList", space, filter);
        }
      },
      on(event, listener) {
        if (config.nativeUi && event === "listChange" && typeof listener === "function") {
          return state.originalConversations.on(event, (space, snapshot, traceId) => {
            if (space !== "local") return listener(space, snapshot, traceId);
            const filter = nativeListFilters.get(traceId) ?? latestLocalFilter;
            return listener(space, nativeListPage(snapshot, externalInfos(filter, space), filter), traceId);
          });
        }
        return state.originalConversations.on(event, listener);
      },
      async create(params) {
        if (config.exclusive) {
          if (state.status !== "ready") throw new Error("Pi 执行引擎尚未就绪，请检查配置后重试");
          if (params?.transport === "cloud") throw new Error("Pi 执行引擎仅支持本地任务");
          return createExternalThread(params);
        }
        if (!state.externalCreatePending) return callOriginal("create", params);
        if (params?.transport === "cloud") {
          state.externalCreatePending = false;
          scheduleSourceSwitchSync();
          return callOriginal("create", params);
        }
        return createExternalThread(params);
      },
      async fork(id) {
        return config.exclusive || isExternalId(id) ? unsupported("fork") : callOriginal("fork", id);
      },
      async delete(id, transport) {
        return isExternalId(id) ? deleteExternal(id) : callOriginal("delete", id, transport);
      },
      async rename(id, title, transport) {
        return isExternalId(id) ? renameExternal(id, title) : callOriginal("rename", id, title, transport);
      },
      async archive(id, transport) {
        if (isExternalId(id)) throw new Error(unsupported("archive").message);
        return callOriginal("archive", id, transport);
      },
      async unarchive(id, transport) {
        if (isExternalId(id)) throw new Error(unsupported("unarchive").message);
        return callOriginal("unarchive", id, transport);
      },
      async move(id, cwd, transport) {
        if (isExternalId(id)) throw new Error(unsupported("move").message);
        return callOriginal("move", id, cwd, transport);
      },
      async pin(id) {
        if (!isExternalId(id)) return callOriginal("pin", id);
        if (!state.pinnedExternalIds.includes(id)) state.pinnedExternalIds.push(id);
        const local = state.conversations.get(id);
        if (local) {
          local.info.isPinned = true;
          emitInfo(local);
        }
        state.wb.$bus.emit(PINNED, { conversationId: id });
      },
      async unpin(id) {
        if (!isExternalId(id)) return callOriginal("unpin", id);
        state.pinnedExternalIds = state.pinnedExternalIds.filter((candidate) => candidate !== id);
        const local = state.conversations.get(id);
        if (local) {
          local.info.isPinned = false;
          emitInfo(local);
        }
        state.wb.$bus.emit(UNPINNED, { conversationId: id });
      },
      async listPinned() {
        const native = includeNativeLists ? await callOriginal("listPinned") : [];
        const additions = state.pinnedExternalIds
          .map((id) => state.conversations.get(id)?.info)
          .filter(Boolean);
        return appendUnique(native, additions);
      },
      async reorderPinned(orderedIds) {
        const nativeIds = orderedIds.filter((id) => !isExternalId(id));
        const externalIds = orderedIds.filter((id) => isExternalId(id) && state.conversations.has(id));
        if (includeNativeLists && nativeIds.length) await callOriginal("reorderPinned", nativeIds);
        state.pinnedExternalIds = externalIds;
        state.wb.$bus.emit(PINS_REORDERED, {});
      },
      setCurrentConversation(id) {
        if (isExternalId(id)) {
          const local = state.conversations.get(id);
          if (local) {
            state.externalCreatePending = false;
            const setNativeCurrent = original.setCurrentConversation;
            if (typeof setNativeCurrent === "function") {
              try {
                setNativeCurrent.call(original, null);
              } catch {}
            }
            setExternalControlsActive(true);
            state.lastExternalId = local.id;
            state.selectedHarnessId = local.harnessId;
            state.activeThreadId = local.threadId;
            void persistUiState({
              active: true,
              activeThreadId: local.threadId,
              selectedHarnessId: local.harnessId,
            }).catch(() => {});
            scheduleSourceSwitchSync();
          }
          return;
        }
        if (typeof id === "string" && id) {
          if (config.exclusive && !config.nativeUi) return;
          if (config.nativeUi && config.exclusive && !nativeHistoryFacades.has(id)) {
            throw new Error("请先打开已确认的本地历史会话，或新建对话使用 Pi。");
          }
          state.lastNativeConversationId = id;
          state.externalCreatePending = false;
        }
        setExternalControlsActive(config.exclusive && isHomeRoute());
        if (config.exclusive && !config.nativeUi) {
          scheduleSourceSwitchSync();
          return;
        }
        void persistUiState({ active: false }).catch(() => {});
        const fn = original.setCurrentConversation;
        const result = typeof fn === "function" ? fn.call(original, id) : undefined;
        scheduleSourceSwitchSync();
        return result;
      },
    };

    const localView = {
      ...(original.local ?? {}),
      list: async (filter) => {
        if (!includeNativeLists) return exclusiveList(filter, "local");
        return nativeList((value) => original.local?.list
          ? original.local.list(value)
          : callOriginal("listScope", "local", value), filter, "local");
      },
    };

    return new Proxy(original, {
      get(target, property) {
        if (property === "local") return localView;
        if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (!bound.has(value)) bound.set(value, value.bind(target));
        return bound.get(value);
      },
    });
  }

  function requestForEvent(local, event) {
    const turnId = String(event.turnId ?? event.payload?.turn?.id ?? "");
    const turnKey = `${local.key}\u0000${turnId}`;
    let requestId = (turnId && state.requestIdByTurn.get(turnKey))
      ?? state.activeRequestByThread.get(local.key);
    if (!requestId || !local.requests.has(requestId)) {
      const turn = event.payload?.turn ?? {
        id: turnId || `event-${event.seq}`,
        prompt: "",
        status: "running",
        items: [],
      };
      requestId = makeRequest(local, turn).id;
    }
    if (turnId) state.requestIdByTurn.set(turnKey, requestId);
    state.activeRequestByThread.set(local.key, requestId);
    return local.requests.get(requestId);
  }

  function appendAssistantText(request, text, messageId, type = "text") {
    const normalizedMessageId = requestScopedMessageId(request.id, messageId);
    if (!text) return normalizedMessageId;
    const content = request.assistantMessage.content;
    const last = content[content.length - 1];
    if (last?.type === type && (!last.messageId || last.messageId === normalizedMessageId)) {
      last.text = `${last.text ?? ""}${text}`;
      last.messageId = normalizedMessageId;
    } else {
      content.push({ type, text, messageId: normalizedMessageId });
    }
    return normalizedMessageId;
  }

  function upsertToolBlock(request, item, isUpdate) {
    const block = itemToHistoryBlock(item, request.id);
    if (!block) return undefined;
    block.sessionUpdate = isUpdate ? "tool_call_update" : "tool_call";
    const index = request.assistantMessage.content.findIndex(
      (candidate) => candidate?.type === "tool" && candidate.toolCallId === block.toolCallId,
    );
    if (index < 0) request.assistantMessage.content.push({ ...block, sessionUpdate: "tool_call" });
    else request.assistantMessage.content[index] = { ...request.assistantMessage.content[index], ...block };
    return block;
  }

  function completeRequest(local, event, finalState) {
    const request = requestForEvent(local, event);
    const turn = event.payload?.turn;
    if (turn?.items) {
      request.assistantMessage.content = turn.items
        .map((item) => itemToHistoryBlock(item, request.id))
        .filter(Boolean);
    }
    request.responseModel = responseModelFor(local, turn);
    applyTokenUsage(request, turn?.usage);
    request.state = finalState;
    request.assistantMessage.state = finalState === "completed" ? "completed" : finalState;
    request.completedAt = toTimestamp(turn?.completedAt);
    request.finishTimestamp = request.completedAt;
    replaceRequestSnapshot(local, request);
    local.pendingById.clear();
    local.pending = undefined;
    local.activeTurnId = undefined;
    state.activeRequestByThread.delete(local.key);
    if (turn?.id) {
      const turns = [...(local.thread.turns ?? [])], index = turns.findIndex(t => t.id === turn.id);
      if (index >= 0) turns[index] = { ...turn }; else turns.push({ ...turn });
      local.thread = { ...local.thread, turns, activeTurnId: null, status: finalState === "error" ? "error" : "idle",
        updatedAt: turn.completedAt ?? new Date(request.completedAt).toISOString() };
      state.threads.set(local.key, local.thread);
    }
    emitRequestsChanged(local);
    emitLocal(local, "historyLoaded");
    if (finalState === "cancelled") {
      emitState(local, "idle", "cancelled", { stopReason: "cancelled" });
    } else if (finalState === "error") {
      const rawError = event.payload?.error ?? turn?.error;
      const terminalError = rawError && typeof rawError === "object"
        ? { stopReason: "external_error", ...rawError }
        : { stopReason: "external_error", ...(rawError ? { message: String(rawError) } : {}) };
      emitState(local, "error", "error", terminalError);
    } else {
      const stopReason = String(turn?.stopReason ?? "end_turn");
      emitState(local, "idle", "completed", undefined, { stopReason });
    }
    // Native lists cache the full info independently of stateChange. Publish
    // the terminal busy flag as well as the timeline's terminal event.
    emitInfo(local);
    if (config.nativeUi) { local.contextUsageLoaded = false; scheduleContextUsageTipSync(); }
  }

  function applyHostEvent(rawEvent) {
    const event = rawEvent?.event ?? rawEvent;
    if (!event || typeof event !== "object" || state.disposed) return;
    if (Number.isFinite(event.seq)) {
      if (event.seq <= state.lastEventSequence) return;
      state.lastEventSequence = event.seq;
    }
    const type = String(event.type ?? "").toLowerCase();
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};

    if (type === "runtime.closed") {
      state.status = "disconnected";
      queueMicrotask(() => dispose());
      return;
    }
    if (type.startsWith("harness.")) {
      void refresh().catch(() => {});
      return;
    }
    if (type === "thread.created" || type === "thread.updated") {
      upsertThread({ harnessId: event.harnessId, ...(payload.thread ?? payload) });
      scheduleSourceSwitchSync();
      return;
    }
    if (type === "thread.deleted") {
      dropThread(event.threadId ?? payload.threadId, { harnessId: event.harnessId });
      return;
    }

    const rawThreadId = String(event.threadId ?? payload.threadId ?? "");
    const local = state.conversations.get(externalId(event.harnessId, rawThreadId));
    if (!local) {
      state.pendingEvents.push(event);
      void refresh().catch(() => {});
      return;
    }
    if (type === "context.usage.updated") {
      local.thread.piContextUsage = payload.summary;
      publishContextUsage(local);
      return;
    }
    if (type === "files.updated") {
      emitLocal(local, "artifactUpdate");
      const paths = Array.isArray(payload.paths) ? payload.paths.filter(p => typeof p === "string" && p.startsWith("/") && p.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(p)).slice(0, 2048) : [];
      const files = Array.isArray(payload.files) ? payload.files.filter(f => f && paths.includes(f.path)
        && (f.size === null || Number.isSafeInteger(f.size) && f.size >= 0)).slice(0, 2048).map(f => ({ path: f.path, size: f.size })) : [];
      if ((paths.length || payload.invalidateAll === true) && typeof globalThis.dispatchEvent === "function" && typeof globalThis.CustomEvent === "function") {
        void rpc("runtime.preview.note", { reason: "event-sent" }).catch(() => {});
        globalThis.dispatchEvent(new CustomEvent("workbuddy-pi:files-changed", { detail: { paths, files, invalidateAll: payload.invalidateAll === true } }));
      }
      return;
    }
    if (type === "turn.started") {
      const request = requestForEvent(local, event);
      local.activeTurnId = String(event.turnId ?? payload.turn?.id ?? "") || undefined;
      request.state = "streaming";
      request.assistantMessage.state = "streaming";
      local.thread.piContextUsage = { source: "pi-context-estimate", status: "unknown", tokens: null, contextWindow: null, breakdown: null };
      publishContextUsage(local);
      if (local.info.state !== "working") emitState(local, "working");
      return;
    }
    if (type === "turn.usage") {
      if (config.nativeUi) { applyTokenUsage(requestForEvent(local, event), payload.usage); return; }
      const request = requestForEvent(local, event), usage = nativeUsage(payload.usage);
      if (!usage) return;
      request.usage = usage; request.assistantMessage.usage = usage;
      emitLocal(local, "requestUpdate", request.id, `${request.id}-usage`,
        { update: { sessionUpdate: "usage", usage } }, [{
          kind: "assistant-usage-updated", requestId: request.id, usage,
          context: { timestamp: request.timestamp, conversationRequestId: request.conversationRequestId,
            responseModel: request.responseModel },
        }]);
      return;
    }
    if (["thinking.created", "thinking.delta", "thinking.updated"].includes(type)) {
      const request = requestForEvent(local, event);
      const rawId = payload.id ?? payload.messageId ?? `${request.id}-thinking`;
      const text = textFrom(type === "thinking.delta" ? payload.delta : payload.thinking ?? payload.text);
      if (!text) return;
      const id = requestScopedMessageId(request.id, rawId);
      const existing = request.assistantMessage.content.find((block) => block.type === "reasoning" && block.messageId === id);
      if (type === "thinking.updated" && existing) existing.text = text;
      else appendAssistantText(request, text, rawId, "reasoning");
      emitRequestUpdate(local, request.id, id,
        { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } } });
      return;
    }
    if (type === "message.delta" || type === "text.delta") {
      const request = requestForEvent(local, event);
      const delta = textFrom(payload.delta ?? payload.text ?? payload.content);
      const rawMessageId = payload.messageId ?? payload.id ?? `${request.id}-assistant`;
      const messageId = appendAssistantText(request, delta, rawMessageId);
      emitRequestUpdate(local, request.id, messageId, {
        update: { sessionUpdate: "agent_message_chunk", content: { text: delta } },
      });
      return;
    }
    if (type === "message.created") {
      const request = requestForEvent(local, event);
      const text = textFrom(payload.text ?? payload.content);
      if (text) {
        const rawMessageId = payload.messageId ?? payload.id ?? `${request.id}-assistant`;
        const messageId = appendAssistantText(request, text, rawMessageId);
        emitRequestUpdate(local, request.id, messageId, {
          update: { sessionUpdate: "agent_message_chunk", content: { text } },
        });
      }
      return;
    }
    if (type === "tool.created" || type === "tool.updated" || type === "diff.created" || type === "diff.updated") {
      const request = requestForEvent(local, event);
      const block = upsertToolBlock(request, payload.item ?? payload, type.endsWith("updated"));
      if (block) {
        emitRequestUpdate(local, request.id, block.toolCallId, {
          update: block,
          _meta: { "codebuddy.ai": { toolName: block.name } },
        });
      }
      return;
    }
    if (type === "interaction.requested") {
      const changed = enqueuePending(local, {
        ...payload,
        interactionId: payload.interactionId ?? event.interactionId,
      });
      if (changed) emitLocal(local, "pendingRequest", local.pending);
      if (local.info.state !== "pending") emitState(local, "pending");
      return;
    }
    if (["interaction.resolved", "interaction.responded", "interaction.cancelled"].includes(type)) {
      const changed = removePending(
        local,
        event.interactionId ?? payload.interactionId ?? payload.id,
      );
      if (changed) emitLocal(local, "pendingRequest", local.pending);
      if (!local.pending && local.info.state === "pending") emitState(local, "working");
      return;
    }
    if (type === "turn.completed") return completeRequest(local, event, "completed");
    if (type === "turn.cancelled") return completeRequest(local, event, "cancelled");
    if (type === "turn.failed" || type === "turn.error") return completeRequest(local, event, "error");
  }

  function applyRuntimeSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    const seen = new Set();
    state.harnesses.clear();
    for (const harnessSnapshot of Array.isArray(snapshot.harnesses) ? snapshot.harnesses : []) {
      const harness = harnessSnapshot.harness ?? harnessSnapshot;
      const harnessId = String(harness.id ?? harness.harnessId ?? "");
      if (harnessId) state.harnesses.set(harnessId, harness);
      for (const thread of Array.isArray(harnessSnapshot.threads) ? harnessSnapshot.threads : []) {
        const local = upsertThread({ harnessId, ...thread }, { announce: false });
        if (!local) continue;
        const previousState = local.info.state;
        const previousPendingId = local.pending?.id;
        const previousRequests = new Map(local.requests);
        local.requests.clear();
        local.pendingById.clear();
        local.pending = undefined;
        updateConversationFromThread(local, thread);
        (thread.turns ?? []).forEach((turn, index) => makeRequest(local, turn, index));
        for (const [requestId, request] of previousRequests) {
          if (!local.requests.has(requestId) && request?.state === "streaming") {
            local.requests.set(requestId, request);
          }
        }
        const pending = (thread.turns ?? []).flatMap((turn) => [
          ...(turn.interaction ? [turn.interaction] : []),
          ...(Array.isArray(turn.interactions) ? turn.interactions : []),
        ]).filter((interaction) => interaction?.status === "pending");
        replacePendingQueue(local, pending);
        if (local.handlers.size > 0) {
          emitRequestsChanged(local);
          emitLocal(local, "historyLoaded");
          emitLocal(local, "infoChange", local.info);
          if (previousState !== local.info.state) {
            const latestTurn = Array.isArray(thread.turns) ? thread.turns.at(-1) : undefined;
            const latestStatus = String(latestTurn?.status ?? "").toLowerCase();
            let finalState;
            let terminalError;
            let promptResponseMeta;
            if (latestStatus === "completed") {
              finalState = "completed";
              promptResponseMeta = { stopReason: latestTurn?.stopReason ?? "end_turn" };
            } else if (["cancelled", "canceled"].includes(latestStatus)) {
              finalState = "cancelled";
              terminalError = { stopReason: "cancelled" };
            } else if (["failed", "error"].includes(latestStatus)) {
              finalState = "error";
              terminalError = latestTurn?.error ?? { stopReason: "external_error" };
            }
            emitLocal(
              local,
              "stateChange",
              previousState,
              local.info.state,
              finalState,
              terminalError,
              undefined,
              promptResponseMeta,
            );
          }
          if (previousPendingId !== local.pending?.id) {
            emitLocal(local, "pendingRequest", local.pending);
          }
        }
        seen.add(local.key);
      }
    }
    for (const key of [...state.threads.keys()]) {
      if (seen.has(key)) continue;
      const local = [...state.conversations.values()].find((candidate) => candidate.key === key);
      if (local) dropThread(local.id, { announce: false });
    }
    state.selectedHarnessId = snapshot.defaultHarnessId
      ?? state.selectedHarnessId
      ?? state.harnesses.keys().next().value;
    const recent = Array.isArray(snapshot.recentEvents) ? snapshot.recentEvents : [];
    state.lastEventSequence = Math.max(
      state.lastEventSequence,
      ...recent.map((event) => Number(event.seq) || 0),
    );
  }

  async function refresh() {
    const beforeIds = new Set(state.conversations.keys());
    const [runtimeSnapshot, uiSnapshot] = await Promise.all([
      rpc("runtime.snapshot"),
      rpc("ui.snapshot"),
    ]);
    assertRendererLifecycle();
    applyRuntimeSnapshot(runtimeSnapshot);
    const uiState = uiSnapshot?.uiState ?? {};
    state.selectedHarnessId = uiState.selectedHarnessId ?? state.selectedHarnessId;
    state.activeThreadId = uiState.activeThreadId ?? state.activeThreadId;
    const afterIds = new Set(state.conversations.keys());
    const added = [...afterIds]
      .filter((id) => !beforeIds.has(id))
      .map((id) => state.conversations.get(id).info);
    const updated = [...afterIds]
      .filter((id) => beforeIds.has(id))
      .map((id) => state.conversations.get(id).info);
    const deleted = [...beforeIds].filter((id) => !afterIds.has(id));
    if (added.length || updated.length || deleted.length) publishListChange(added, updated, deleted);

    const queued = state.pendingEvents.splice(0);
    for (const event of queued) applyHostEvent(event);
    return { runtimeSnapshot, uiState };
  }

  async function createDemoThread() {
    const harnessId = state.selectedHarnessId ?? state.harnesses.keys().next().value;
    if (!harnessId) throw new Error("No external harness is available");
    const harnessLabel = String(state.harnesses.get(harnessId)?.label ?? "").trim();
    const result = await rpc("thread.create", {
      harnessId,
      title: config.nativeUi ? "新对话" : harnessLabel ? `Pi · ${harnessLabel}` : "Pi 外部会话",
      ...(config.nativeUi ? { workspaceAutoGenerated: true } : {}),
    });
    assertRendererLifecycle();
    const local = upsertThread({ harnessId, ...(result?.thread ?? result) });
    state.selectedHarnessId = harnessId;
    return local;
  }

  function workspaceName(cwd) {
    const value = String(cwd ?? "").replace(/[\\/]+$/, "");
    if (!value) return "WorkBuddy Host";
    return value.split(/[\\/]/).filter(Boolean).at(-1) ?? "WorkBuddy Host";
  }

  function conversationTitle(thread) {
    const title = String(thread.title ?? (config.nativeUi ? "新对话" : "Pi 外部会话"));
    if (!config.nativeUi || thread.userDefinedTitle || !/^(?:Pi\s*·\s*){1,2}(?:官方模型|本地模型)$|^Pi (?:新任务|外部会话)$/.test(title)) return title;
    const prompt = thread.turns?.find((turn) => typeof turn.prompt === "string" && turn.prompt.trim())?.prompt ?? "";
    return prompt.trim().split(/\r?\n/)[0].slice(0, 48) || "新对话";
  }

  function conversationActivity(thread) {
    if (!config.nativeUi) return toTimestamp(thread.updatedAt ?? thread.createdAt);
    const last = thread.turns?.at(-1);
    return toTimestamp(last?.completedAt ?? last?.createdAt ?? thread.createdAt, 0);
  }

  async function createExternalThread(params = {}) {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("External conversation create params must be an object");
    }
    const harnessId = state.selectedHarnessId ?? state.harnesses.keys().next().value;
    if (!harnessId) throw new Error("No external harness is available");
    const rawCwd = params.cwd;
    if (
      rawCwd !== undefined && rawCwd !== ""
      && (typeof rawCwd !== "string" || !rawCwd.startsWith("/") || rawCwd.includes("\u0000"))
    ) {
      throw new Error("External workspace must be an absolute local path");
    }
    const cwd = typeof rawCwd === "string" && rawCwd
      ? rawCwd.replace(/[\\/]+$/, "") || "/"
      : undefined;
    const requestedTitle = typeof params.title === "string" ? params.title.trim() : "";
    const harnessLabel = String(state.harnesses.get(harnessId)?.label ?? "").trim();
    const title = requestedTitle || (config.nativeUi ? "新对话"
      : (cwd ? workspaceName(cwd) : "")
        || (harnessLabel ? `Pi · ${harnessLabel}` : "Pi 外部会话"));
    if (config.nativeUi && params.expert != null && (typeof params.expert !== "object" || Array.isArray(params.expert))) {
      throw new Error("专家选择无效");
    }
    // Native Home/Embed pass their mapped identity as `expert`. Legacy create
    // fields can fill gaps but cannot replace that selected identity.
    const expertSelection = { ...nativeExpertSelection({ id: params.expertId, marketplace: params.expertMarketplace,
      locale: params.locale, runtimeIdentity: params.runtimeIdentity }), ...nativeExpertSelection(params.expert) };
    if (params.expert?.package !== undefined) expertSelection.package = params.expert.package;
    expertSelection.id ??= params.expertId;
    expertSelection.marketplace ??= params.expertMarketplace;
    const hasExpert = params.expert != null || params.expertId || expertSelection.id;
    const connectorIds = config.nativeUi ? params.addonSelection?.connectorIds : undefined;
    if (connectorIds !== undefined && (params.addonSelection.version !== 1 || !Array.isArray(connectorIds)
      || connectorIds.length > 32 || connectorIds.some(id => typeof id !== "string" || !id.trim()
        || id.length > 512 || /[\x00-\x1f]/.test(id)) || new Set(connectorIds).size !== connectorIds.length)) {
      throw new Error("连接器选择无效");
    }
    const initialExpert = config.nativeUi && hasExpert ? await resolveNativeExpert(expertSelection) : null;
    let approvalMode;
    if (config.nativeUi) {
      const saved = await state.wb?.config?.preference?.("localTaskPermissionMode");
      approvalMode = saved === "full-access" ? "auto" : saved === "default-sandbox" ? "manual" : state.harnesses.get(harnessId)?.approvalMode;
    }
    assertRendererLifecycle();
    const result = await rpc("thread.create", {
      harnessId,
      title,
      ...(cwd === undefined ? {} : { cwd }),
      ...(config.nativeUi ? {
        workspaceAutoGenerated: !cwd,
        ...(approvalMode === undefined ? {} : { approvalMode }),
        ...(params.model === undefined ? {} : { model: params.model }),
      } : {}),
    });
    assertRendererLifecycle();
    const local = upsertThread({ harnessId, ...(result?.thread ?? result) });
    if (!local) throw new Error("External harness returned no thread");
    if (initialExpert || connectorIds?.length) {
      const bound = await rpc("thread.context.set", { harnessId, threadId: local.threadId,
        ...(initialExpert ? { expert: initialExpert } : {}),
        ...(connectorIds?.length ? { connectors: connectorIds.map(name => ({ name, displayName: name, activeStatus: true })) } : {}),
      });
      assertRendererLifecycle();
      updateConversationFromThread(local, bound.thread);
      emitLocal(local, "configChange");
      if (initialExpert) emitLocal(local, "expertChange", initialExpert);
    }
    state.externalCreatePending = false;
    state.selectedHarnessId = harnessId;
    state.activeThreadId = local.threadId;
    state.lastExternalId = local.id;
    scheduleSourceSwitchSync();
    return local.controller;
  }

  function openExclusiveComposer() {
    if (state.exclusiveComposerPromise) return state.exclusiveComposerPromise;
    const operation = Promise.resolve().then(async () => {
      assertRendererLifecycle();
      if (state.status !== "ready") throw new Error("Pi 执行引擎尚未就绪，请稍后重试");
      // Legacy exclusive UI opens a Pi controller before editing. Native UI
      // keeps the official home composer and creates at conversations.create.
      const empty = [...state.conversations.values()].find((local) => (
        local.requests.size === 0 && !local.activeTurnId
      ));
      const controller = empty?.controller ?? await createExternalThread();
      await openExternal(controller.info.id);
      return controller;
    });
    state.exclusiveComposerPromise = operation;
    void operation.finally(() => {
      if (state.exclusiveComposerPromise === operation) state.exclusiveComposerPromise = undefined;
    }).catch(() => {});
    return operation;
  }

  function conversationNavigationTarget(id) {
    return id
      ? { tab: "conversation", path: encodeURIComponent(id) }
      : { tab: "home" };
  }

  function navigationGoto(target) {
    const operation = Promise.resolve().then(() => state.wb.navigation.goto(target));
    state.navigationOperations.add(operation);
    void operation.then(
      () => state.navigationOperations.delete(operation),
      () => state.navigationOperations.delete(operation),
    );
    return operation;
  }

  async function restoreNavigation(id) {
    if (!ownsRendererLifecycle()) return false;
    try {
      await navigationGoto(conversationNavigationTarget(id));
      return ownsRendererLifecycle();
    } catch {
      return false;
    }
  }

  async function openExternal(id) {
    assertRendererLifecycle();
    const local = state.conversations.get(id);
    if (!local) throw new Error(`External conversation not found: ${id}`);
    const previousId = currentRouteId();
    const previousSelectedHarnessId = state.selectedHarnessId;
    const previousActiveThreadId = state.activeThreadId;
    const previousLastExternalId = state.lastExternalId;
    publishListChange(externalInfos(undefined, "local"), [], []);
    await navigationGoto({ tab: "conversation", path: encodeURIComponent(id) });
    assertRendererLifecycle();
    try {
      await persistUiState({
        active: true,
        activeThreadId: local.threadId,
        selectedHarnessId: local.harnessId,
      });
      assertRendererLifecycle();
      state.selectedHarnessId = local.harnessId;
      state.activeThreadId = local.threadId;
      state.lastExternalId = local.id;
      setExternalControlsActive(true);
      scheduleModelSelectorSync();
    } catch (error) {
      if (!ownsRendererLifecycle()) throw error;
      state.selectedHarnessId = previousSelectedHarnessId;
      state.activeThreadId = previousActiveThreadId;
      state.lastExternalId = previousLastExternalId;
      setExternalControlsActive(isOwnedExternalId(previousId));
      await restoreNavigation(previousId);
      throw error;
    }
    scheduleSourceSwitchSync();
    return id;
  }

  async function validLastNativeConversationId() {
    const id = state.lastNativeConversationId;
    if (!id || isExternalId(id)) return undefined;
    try {
      return await callOriginal("get", id) ? id : undefined;
    } catch {
      return undefined;
    }
  }

  async function performSourceSwitch(mode) {
    if (!ownsRendererLifecycle() || state.status !== "ready") return false;
    rememberCurrentSource();
    if (sourceMode() === mode && (!config.exclusive || isOwnedExternalId(currentRouteId()))) {
      if (mode === "external") await persistCurrentExternalRoute();
      updateSourceSwitchNode();
      return true;
    }
    try {
      if (mode === "external") {
        let local = isOwnedExternalId(state.lastExternalId)
          ? state.conversations.get(state.lastExternalId)
          : state.conversations.values().next().value;
        if (!local) local = await createDemoThread();
        await openExternal(local.id);
      } else {
        state.externalCreatePending = false;
        const previousId = currentRouteId();
        const nativeId = await validLastNativeConversationId();
        assertRendererLifecycle();
        await navigationGoto(nativeId
          ? { tab: "conversation", path: encodeURIComponent(nativeId) }
          : { tab: "home" });
        assertRendererLifecycle();
        try {
          await persistUiState({ active: false });
          assertRendererLifecycle();
        } catch (error) {
          if (!ownsRendererLifecycle()) throw error;
          setExternalControlsActive(isOwnedExternalId(previousId));
          await restoreNavigation(previousId);
          throw error;
        }
        setExternalControlsActive(false);
        scheduleModelSelectorSync();
        scheduleSourceSwitchSync();
      }
      rememberCurrentSource();
      updateSourceSwitchNode();
      return sourceMode() === mode;
    } catch (error) {
      if (!ownsRendererLifecycle()) throw error;
      rememberCurrentSource();
      updateSourceSwitchNode();
      throw error;
    }
  }

  function switchSource(mode) {
    const normalized = String(mode ?? "").toLowerCase();
    if (normalized !== "native" && normalized !== "external") {
      return Promise.reject(new Error(`Unknown conversation source: ${mode}`));
    }
    if (config.exclusive && normalized === "native") {
      return Promise.reject(new Error("此版本仅使用 Pi 执行引擎"));
    }
    state.sourceSwitchBusy += 1;
    updateSourceSwitchNode();
    const operation = state.sourceSwitchQueue.then(
      () => performSourceSwitch(normalized),
      () => performSourceSwitch(normalized),
    );
    state.sourceSwitchQueue = operation.catch(() => undefined);
    return operation.finally(() => {
      state.sourceSwitchBusy = Math.max(0, state.sourceSwitchBusy - 1);
      updateSourceSwitchNode();
    });
  }

  async function show() {
    await readyPromise;
    if (!ownsRendererLifecycle() || state.status !== "ready") return false;
    let local;
    if (state.activeThreadId) {
      if (state.selectedHarnessId != null) {
        local = state.conversations.get(externalId(
          state.selectedHarnessId,
          state.activeThreadId,
        ));
        if (!local) {
          throw new Error(
            `External thread not found for harness ${state.selectedHarnessId}: ${state.activeThreadId}`,
          );
        }
      } else {
        const matches = [...state.conversations.values()].filter(
          (candidate) => candidate.threadId === state.activeThreadId,
        );
        if (matches.length === 1) local = matches[0];
        else if (matches.length > 1) {
          throw new Error(`Ambiguous external thread owner: ${state.activeThreadId}`);
        } else {
          throw new Error(`External thread not found: ${state.activeThreadId}`);
        }
      }
    }
    if (!local && isOwnedExternalId(state.lastExternalId)) {
      local = state.conversations.get(state.lastExternalId);
    }
    if (!local) local = state.conversations.values().next().value;
    if (!local) local = await createDemoThread();
    await openExternal(local.id);
    return true;
  }

  function waitForWorkBuddy() {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const inspect = async () => {
        if (state.disposed) return reject(new Error("Renderer bridge was disposed during startup"));
        const identity = readWorkBuddyRendererIdentity();
        const supportedVersion = config.supportedAppVersions.includes(identity.version);
        if (identity.version && !supportedVersion) {
          return reject(new Error(
            `Unsupported WorkBuddy version ${identity.version}; expected ${config.supportedAppVersions.join(" or ")}`,
          ));
        }
        const wb = globalThis.wb;
        const hasConversationShell = Boolean(globalThis.document?.querySelector?.(".teams-container"));
        let authenticated = !config.exclusive;
        if (config.exclusive && typeof wb?.account?.status === "function") {
          let timer;
          try {
            authenticated = await Promise.race([
              Promise.resolve(wb.account.status()).then((status) => status === "authenticated"),
              new Promise((resolve) => { timer = setTimeout(() => resolve(false), 2_000); }),
            ]);
          } catch { /* Official login can still be loading; never synthesize it. */ }
          finally { clearTimeout(timer); }
          if (state.disposed) return reject(new Error("Renderer bridge was disposed during startup"));
        }
        const compatible =
          identity.name === "workbuddy"
          && identity.desktop === "true"
          && supportedVersion
          && wb
          && typeof wb.$provide === "function"
          && typeof wb.$bus?.emit === "function"
          && typeof wb.navigation?.goto === "function"
          && wb.conversations
          && typeof wb.conversations.get === "function"
          && typeof wb.conversations.list === "function"
          && typeof wb.conversations.listScope === "function"
          && typeof wb.conversations.ensureList === "function"
          && typeof wb.conversations.on === "function"
          && hasConversationShell
          && authenticated
          && !globalThis.document?.getElementById?.("skeleton-root");
        if (compatible) return resolve(wb);
        // Signing in with the official account is user-paced. A Pi-only build
        // waits for that shell instead of expiring its bridge while login is open.
        if (
          Date.now() - startedAt >= config.contractTimeoutMs
          && (!config.exclusive || (hasConversationShell && authenticated))
        ) {
          return reject(new Error(
            `WorkBuddy ${identity.version ?? config.supportedAppVersions.join(" or ")} native conversation contract is unavailable`,
          ));
        }
        state.bootTimer = setTimeout(inspect, config.exclusive && (!hasConversationShell || !authenticated) ? 250 : 25);
      };
      inspect();
    });
  }

  function scheduleListReannounce() {
    for (const timer of state.announceTimers.splice(0)) clearTimeout(timer);
    for (const delay of [0, 250, 1_000, 3_000]) {
      const timer = setTimeout(() => {
        state.announceTimers = state.announceTimers.filter((candidate) => candidate !== timer);
        if (state.disposed) return;
        const infos = externalInfos(undefined, "local");
        if (infos.length) publishListChange(infos, [], []);
      }, delay);
      timer.unref?.();
      state.announceTimers.push(timer);
    }
  }

  function releaseNativeRegistration({ notifyHost = false } = {}) {
    clearTimeout(state.bootTimer);
    for (const timer of state.announceTimers.splice(0)) clearTimeout(timer);
    try {
      state.sourceSwitchObserver?.disconnect();
    } catch {}
    state.sourceSwitchObserver = undefined;
    state.sourceSwitchSyncScheduled = false;
    try {
      state.releaseExternalCreateIntent?.();
    } catch {}
    state.releaseExternalCreateIntent = undefined;
    state.externalCreatePending = false;
    removeSourceSwitchNode();
    removeModelSelectorNode();
    state.modelSelectorSyncScheduled = false;
    try {
      state.releaseListProgress?.();
    } catch {}
    state.releaseListProgress = undefined;
    try { state.releasePreviewStatus?.(); } catch {}
    state.releasePreviewStatus = undefined;

    const wb = state.wb;
    setExternalControlsActive(false);
    try {
      state.controlStyle?.remove();
    } catch {}
    state.controlStyle = undefined;
    let ownsNamespace = false;
    let navigationCleanup = Promise.resolve();
    try {
      ownsNamespace = Boolean(wb && state.mux && wb.conversations === state.mux);
    } catch {}
    if (ownsNamespace) {
      try {
        if (isExternalId(currentRouteId())) {
          navigationCleanup = Promise.resolve(wb.navigation.goto({ tab: "home" })).catch(() => {});
        }
      } catch {}
      try {
        wb.$provide("conversations", state.originalConversations);
      } catch {}
    }
    const ids = [...state.conversations.keys()];
    if (wb) {
      try {
        wb.$bus.emit(LIST_CHANGED, { added: [], updated: [], deleted: ids });
      } catch {}
    }
    if (notifyHost) {
      try {
        bridgeBinding()(JSON.stringify({
          kind: "request",
          id: `dispose-${Date.now()}`,
          method: "ui.update",
          params: { active: false },
        }));
      } catch {}
    }

    for (const local of state.conversations.values()) {
      try {
        local.controller.dispose();
      } catch {}
    }
    state.conversations.clear();
    state.threads.clear();
    state.requestIdByTurn.clear();
    state.activeRequestByThread.clear();
    state.pendingEvents.length = 0;
    state.pinnedExternalIds.length = 0;
    state.mux = undefined;
    return navigationCleanup;
  }

  async function boot() {
    try {
      await previousCleanup;
      if (!ownsRendererLifecycle()) return false;
      const wb = await waitForWorkBuddy();
      if (!ownsRendererLifecycle()) return false;
      state.wb = wb;
      if (typeof globalThis.addEventListener === "function") {
        const reasons = new Set(["mounted", "event", "matched", "dirty-skipped", "unknown-skipped", "stale-skipped", "reloaded", "read-failed", "size-skipped",
          "nonlocal-skipped", "extension-skipped", "session-skipped", "content-skipped", "reader-skipped", "probe-skipped", "url-skipped", "ref-skipped"]);
        const listener = event => {
          if (!ownsRendererLifecycle() || state.disposed || !reasons.has(event?.detail?.reason)) return;
          void rpc("runtime.preview.note", { reason: event.detail.reason }).catch(() => {});
        };
        globalThis.addEventListener("workbuddy-pi:preview-status", listener);
        state.releasePreviewStatus = () => globalThis.removeEventListener("workbuddy-pi:preview-status", listener);
      }
      state.originalConversations = wb.conversations;
      state.mux = createConversationsMux(state.originalConversations);
      wb.$provide("conversations", state.mux);
      installControlGuardStyle();
      installSourceSwitchObserver();
      installContextUsageTips();
      installExternalCreateIntentListener();
      if (typeof wb.$bus.on === "function") {
        state.releaseListProgress = wb.$bus.on("wb:conversations:listProgress", (payload) => {
          if (payload?.space !== "local") return;
          queueMicrotask(() => {
            const infos = externalInfos(undefined, "local");
            if (infos.length) publishListChange(infos, [], []);
          });
        });
      }
      const { uiState } = await refreshForBoot();
      if (!ownsRendererLifecycle()) return false;

      const persistedExternal = uiState.activeThreadId
        ? state.conversations.get(externalId(
            uiState.selectedHarnessId ?? state.selectedHarnessId,
            uiState.activeThreadId,
          ))
        : undefined;
      if (persistedExternal) state.lastExternalId = persistedExternal.id;
      if (!config.nativeUi) {
        const restored = uiState.active || config.exclusive ? persistedExternal : undefined;
        if (restored) await openExternal(restored.id);
        else if (state.conversations.size === 0) {
          const created = await createDemoThread();
          await openExternal(created.id);
        } else if (config.exclusive && (currentRouteId() || isHomeRoute())) {
          await openExternal(state.conversations.values().next().value.id);
        }
      }
      await seedNativeApprovalPreference(uiState);
      const queued = state.pendingEvents.splice(0);
      for (const event of queued) applyHostEvent(event);
      state.status = "ready";
      scheduleListReannounce();
      rememberCurrentSource();
      scheduleSourceSwitchSync();
      scheduleModelSelectorSync();
      return true;
    } catch (error) {
      if (!ownsRendererLifecycle()) return false;
      state.status = "failed";
      state.error = error instanceof Error ? error : new Error(String(error));
      // A bundled Pi-only build must never recover by handing new tasks back
      // to the native CLI. Keep its registered mux as a visible failed gate.
      if (!config.exclusive) {
        releaseNativeRegistration();
        void persistUiState({ active: false }).catch(() => {});
      }
      return false;
    }
  }

  async function refreshForBoot() {
    for (;;) {
      try {
        const result = await refresh();
        state.waitReason = undefined;
        state.error = undefined;
        return result;
      } catch (error) {
        const retriable = ["OFFICIAL_BRIDGE_UNAVAILABLE", "OFFICIAL_AUTH_REQUIRED"];
        if (!config.officialModels || !ownsRendererLifecycle() || !retriable.includes(error?.code)) throw error;
        state.waitReason = "official-models";
        state.error = new Error("官方模型服务暂未就绪，正在重新连接。请确认官方账号已登录且网络可用。");
        scheduleSourceSwitchSync();
        await new Promise((resolve) => {
          state.bootRetryResolve = resolve;
          state.bootTimer = setTimeout(resolve, 1_000);
        });
        state.bootRetryResolve = undefined;
        assertRendererLifecycle();
      }
    }
  }

  function dispose(options = {}) {
    if (state.disposePromise) return state.disposePromise;
    if (state.disposed) return Promise.resolve();
    state.disposed = true;
    state.contextUsageObserver?.disconnect();
    syncContextUsageTips();
    state.bootRetryResolve?.();
    state.bootRetryResolve = undefined;
    const inFlightSourceSwitch = Promise.resolve(state.sourceSwitchQueue).catch(() => undefined);
    const inFlightNavigation = Promise.allSettled([...state.navigationOperations]);
    let navigationCleanup = Promise.resolve();
    try {
      navigationCleanup = releaseNativeRegistration({
        notifyHost: options?.preserveUiState !== true,
      });
    } finally {
      try {
        router.dispose("WorkBuddy Host renderer removed");
      } catch {}
      if (globalThis[config.globalName] === api) delete globalThis[config.globalName];
    }
    state.disposePromise = Promise.allSettled([
      inFlightSourceSwitch,
      inFlightNavigation,
      navigationCleanup,
    ])
      .then(async () => {
        if (globalThis[config.globalName] !== undefined) return;
        try {
          if (isExternalId(currentRouteId())) {
            await state.wb?.navigation?.goto?.({ tab: "home" });
          }
        } catch {}
      });
    return state.disposePromise;
  }

  router = createRendererMessageRouter({
    onEvent: (event) => {
      if (state.status === "booting") state.pendingEvents.push(event);
      else if (state.status === "ready") applyHostEvent(event);
    },
    onProtocolError: (error) => {
      state.error = error;
    },
  });

  api = {
    version: config.version,
    bindingName: config.bindingName,
    exclusive: config.exclusive,
    officialModels: config.officialModels,
    nativeUi: config.nativeUi,
    receive: router.route,
    invoke: invokeRenderer,
    dispose,
    show,
    open: show,
    switchSource,
    refresh,
    homeConversations(wb) {
      if (config.exclusive && state.status === "ready" && ownsRendererLifecycle()
        && globalThis.wb === state.wb && wb?.conversations === state.mux) return state.mux;
    },
    get ready() { return readyPromise; },
    get status() { return state.status; },
    get error() { return state.error?.message; },
    get waitReason() { return state.waitReason; },
    get sourceMode() { return sourceMode(); },
    get conversationIds() { return [...state.conversations.keys()]; },
  };
  Object.defineProperty(globalThis, config.globalName, { configurable: true, value: api });
  readyPromise = boot();
}

export function buildRendererSource({
  bindingName = DEFAULT_BINDING_NAME,
  globalName = DEFAULT_RENDERER_GLOBAL,
  rootId = DEFAULT_ROOT_ID,
  version = "0.1.0",
  requiredAppVersion,
  conversationPrefix,
  contractTimeoutMs = 120_000,
  exclusive = false,
  officialModels = false,
  nativeUi = false,
} = {}) {
  const ownerToken = /_([0-9a-f]{16})$/i.exec(bindingName)?.[1] ?? "default";
  const resolvedConversationPrefix = conversationPrefix ?? `wbhost:${ownerToken}:`;
  const activeBodyClass = `workbuddy-host-external-${ownerToken}`;
  const config = JSON.stringify({
    bindingName,
    globalName,
    rootId,
    version,
    supportedAppVersions: requiredAppVersion === undefined ? SUPPORTED_WORKBUDDY_VERSIONS : [requiredAppVersion],
    conversationPrefix: resolvedConversationPrefix,
    activeBodyClass,
    contractTimeoutMs,
    exclusive: exclusive === true,
    officialModels: officialModels === true,
    nativeUi: nativeUi === true,
  });
  return `;(() => {\nconst createRendererMessageRouter = ${createRendererMessageRouter.toString()};\nconst readWorkBuddyRendererIdentity = ${readWorkBuddyRendererIdentity.toString()};\nconst installRenderer = ${installRenderer.toString()};\ninstallRenderer(${config});\n})();`;
}

export const rendererSource = buildRendererSource();
