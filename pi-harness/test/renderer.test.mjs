import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import fs from "node:fs";
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from "node:crypto";

import { createRendererMessageRouter } from "../src/renderer/protocol.js";
import { buildRendererSource } from "../src/renderer/source.js";
import { inspectAsar } from '../package-dmg/asar.mjs';
import { applyNativeHomeRoutePatch } from '../package-dmg/native-home-route-patch.mjs';
import { prepareTurnInput } from '../src/turn-input.mjs';
import { resolveNativeContext } from '../src/native-context.mjs';
import { createNativeInputReplay } from './fixtures/native-input-592.replay.mjs';
import { createNativeExpertReplay } from './fixtures/native-expert-592.replay.mjs';
import { replayNativeArtifactBindingFromInfo, replayNativeSidebarConversation, replayNativeArtifactBridge, replayNativeFinalEnvironment,
  replayNativeProjectDetailPanelOptions } from './fixtures/native-artifact-environment-592.replay.mjs';

test("renderer router pairs responses independently from arrival order", async () => {
  const sent = [];
  const router = createRendererMessageRouter({ timeoutMs: 0 });
  const first = router.request("harness.list", {}, (message) => sent.push(JSON.parse(message)));
  const second = router.request("thread.list", {}, (message) => sent.push(JSON.parse(message)));

  assert.equal(router.pendingCount, 2);
  router.route({ kind: "response", id: sent[1].id, ok: true, result: ["thread"] });
  router.route({ kind: "response", id: sent[0].id, ok: true, result: ["harness"] });

  assert.deepEqual(await first, ["harness"]);
  assert.deepEqual(await second, ["thread"]);
  assert.equal(router.pendingCount, 0);
});

test("renderer router separates events and structured request failures", async () => {
  const events = [];
  const invalid = [];
  let outbound;
  const router = createRendererMessageRouter({
    timeoutMs: 0,
    onEvent: (event) => events.push(event),
    onProtocolError: (error) => invalid.push(error.message),
  });
  const request = router.request("turn.start", {}, (message) => {
    outbound = JSON.parse(message);
  });

  assert.equal(router.route({ kind: "event", event: { type: "message.delta", text: "hi" } }), true);
  assert.equal(router.route("{"), false);
  router.route({
    kind: "response",
    id: outbound.id,
    ok: false,
    error: { name: "BusyError", message: "already running", code: "BUSY" },
  });

  assert.deepEqual(events, [{ type: "message.delta", text: "hi" }]);
  assert.equal(invalid.length, 1);
  await assert.rejects(request, (error) => error.name === "BusyError" && error.code === "BUSY");
});

test("renderer router disposal rejects pending requests", async () => {
  const router = createRendererMessageRouter({ timeoutMs: 0 });
  const request = router.request("runtime.snapshot", {}, () => {});
  router.dispose("test teardown");
  await assert.rejects(request, /test teardown/);
  assert.equal(router.pendingCount, 0);
});

test("native source switch uses WorkBuddy segmented controls and remembers both exact routes", async () => {
  const fixture = createNativeRendererFixture({
    existingExternalThread: true,
    initialPath: "/conversation/native-1",
    withTopbar: true,
  });
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding",
    globalName: "__testGlobal",
    conversationPrefix: "wbhost:",
    contractTimeoutMs: 25,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  await new Promise((resolve) => setImmediate(resolve));

  const segmented = fixture.dom.topbarActions.children.find((node) => (
    node.classList.contains("wb-segmented")
  ));
  assert.ok(segmented);
  assert.equal(segmented.getAttribute("role"), "radiogroup");
  const buttons = segmented.children.filter((node) => node.dataset.sourceMode);
  assert.deepEqual(buttons.map((button) => button.children[0].textContent), ["原生", "Pi 外部"]);
  assert.equal(buttons[0].getAttribute("role"), "radio");
  assert.equal(buttons[0].getAttribute("aria-checked"), "true");
  assert.equal(buttons[1].getAttribute("aria-checked"), "false");
  assert.equal(api.sourceMode, "native");

  await api.switchSource("external");
  assert.equal(api.sourceMode, "external");
  assert.equal(fixture.context.location.pathname, "/conversation/wbhost%3Afake%3Afake-thread-existing");
  assert.equal(buttons[1].getAttribute("aria-checked"), "true");

  await api.switchSource("native");
  assert.equal(api.sourceMode, "native");
  assert.equal(fixture.context.location.pathname, "/conversation/native-1");
  const nativeUpdate = fixture.calls.filter((call) => call.method === "ui.update").at(-1);
  assert.deepEqual(nativeUpdate.params, { active: false });

  await api.switchSource("external");
  assert.equal(api.sourceMode, "external");
  assert.equal(fixture.context.location.pathname, "/conversation/wbhost%3Afake%3Afake-thread-existing");
  assert.equal(fixture.calls.filter((call) => call.method === "thread.create").length, 0);
  assert.equal(fixture.calls.some((call) => call.method === "turn.cancel"), false);
  api.dispose();
});

test("source switch restores the exact persisted external owner after a native reload", async () => {
  const fixture = createNativeRendererFixture({
    duplicateHarnessThreads: true,
    initialPath: "/conversation/native-1",
    uiState: {
      active: false,
      activeThreadId: "shared-thread",
      selectedHarnessId: "beta",
    },
  });
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding",
    globalName: "__testGlobal",
    conversationPrefix: "wbhost:",
    contractTimeoutMs: 25,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  assert.equal(api.sourceMode, "native");

  assert.equal(await api.switchSource("external"), true);
  assert.equal(
    fixture.context.location.pathname,
    "/conversation/wbhost%3Abeta%3Ashared-thread",
  );
  const activeUpdate = fixture.calls.filter((call) => call.method === "ui.update").at(-1);
  assert.deepEqual(activeUpdate.params, {
    active: true,
    activeThreadId: "shared-thread",
    selectedHarnessId: "beta",
  });
  await api.dispose();
});

test("source switch rolls navigation back when host ui persistence fails", async () => {
  const fixture = createNativeRendererFixture({
    existingExternalThread: true,
    initialPath: "/conversation/native-1",
    withTopbar: true,
    failUiUpdate: true,
  });
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding",
    globalName: "__testGlobal",
    conversationPrefix: "wbhost:",
    contractTimeoutMs: 25,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);

  await assert.rejects(api.switchSource("external"), /synthetic ui update failure/);
  assert.equal(api.sourceMode, "native");
  assert.equal(fixture.context.location.pathname, "/conversation/native-1");
  const segmented = fixture.dom.topbarActions.children.find((node) => (
    node.classList.contains("wb-segmented")
  ));
  const buttons = segmented.children.filter((node) => node.dataset.sourceMode);
  assert.equal(buttons[0].getAttribute("aria-checked"), "true");
  assert.equal(buttons[1].getAttribute("aria-checked"), "false");
  api.dispose();
});

function createFixtureDocument({ withTopbar = false, nativeAdapter } = {}) {
  let conversationShellAvailable = true;
  const observers = [];
  const documentListeners = new Map();
  const notifyMutation = () => {
    for (const observer of observers) {
      if (observer.connected) queueMicrotask(() => observer.callback([], observer));
    }
  };
  const createElement = (tagName) => {
    const node = {
      tagName: String(tagName).toUpperCase(),
      className: "",
      dataset: {},
      attributes: new Map(),
      style: {
        values: new Map(),
        setProperty(name, value) { this.values.set(name, String(value)); },
        getPropertyValue(name) { return this.values.get(name) ?? ""; },
      },
      children: [],
      parentNode: null,
      textContent: "",
      disabled: false,
      tabIndex: 0,
      listeners: new Map(),
      classList: {
        add(...names) {
          const values = new Set(node.className.split(/\s+/).filter(Boolean));
          for (const name of names) values.add(name);
          node.className = [...values].join(" ");
        },
        remove(...names) {
          const values = new Set(node.className.split(/\s+/).filter(Boolean));
          for (const name of names) values.delete(name);
          node.className = [...values].join(" ");
        },
        contains(name) { return node.className.split(/\s+/).includes(name); },
        toggle(name, force) {
          const active = force ?? !this.contains(name);
          if (active) this.add(name);
          else this.remove(name);
          return active;
        },
      },
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      append(...values) {
        for (const value of values) {
          value.remove?.();
          value.parentNode = this;
          this.children.push(value);
        }
        notifyMutation();
      },
      after(...values) {
        if (!this.parentNode) return;
        const index = this.parentNode.children.indexOf(this);
        for (const value of values.toReversed()) {
          value.remove?.();
          value.parentNode = this.parentNode;
          this.parentNode.children.splice(index + 1, 0, value);
        }
        notifyMutation();
      },
      prepend(...values) {
        for (const value of values.toReversed()) {
          value.remove?.();
          value.parentNode = this;
          this.children.unshift(value);
        }
        notifyMutation();
      },
      remove() {
        if (!this.parentNode) return;
        const index = this.parentNode.children.indexOf(this);
        if (index >= 0) this.parentNode.children.splice(index, 1);
        this.parentNode = null;
        notifyMutation();
      },
      addEventListener(type, listener) {
        const values = this.listeners.get(type) ?? new Set();
        values.add(listener);
        this.listeners.set(type, values);
      },
      removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); },
      contains(value) {
        if (value === this) return true;
        return this.children.some((child) => child.contains?.(value));
      },
      getBoundingClientRect() {
        return { left: 20, top: 600, right: 200, bottom: 632, width: 180, height: 32 };
      },
      closest(selector) {
        let current = this;
        while (current) {
          if (selector.startsWith(".") && current.classList?.contains?.(selector.slice(1))) {
            return current;
          }
          if (
            selector === '[data-track-id="agent_new_task_button_clicked"]'
            && current.dataset?.trackId === "agent_new_task_button_clicked"
          ) return current;
          current = current.parentNode;
        }
        return null;
      },
      click() {
        if (this.disabled) return;
        for (const listener of this.listeners.get("click") ?? []) {
          listener({ currentTarget: this, preventDefault() {} });
        }
      },
      listenerCount(type) { return this.listeners.get(type)?.size ?? 0; },
    };
    return node;
  };
  const body = createElement("body");
  body.dataset = { applicationName: "workbuddy", electronDesktop: "true" };
  const documentElement = createElement("html");
  documentElement.dataset = {};
  const head = createElement("head");
  const root = createElement("div");
  root.id = "root";
  root.__reactContainer$fixture = {
    memoizedProps: { adapter: nativeAdapter },
    child: null,
    sibling: null,
  };
  const modelHost = createElement("div");
  const nativeModelRoot = createElement("span");
  nativeModelRoot.className = "cr-model-selector";
  const nativeModelTrigger = createElement("button");
  nativeModelTrigger.className = "cr-model-selector__trigger";
  nativeModelRoot.append(nativeModelTrigger);
  modelHost.append(nativeModelRoot);
  body.append(modelHost);
  const topbarActions = withTopbar ? createElement("div") : undefined;
  if (topbarActions) topbarActions.className = "workbuddy-topbar-actions";
  const newTaskButton = createElement("button");
  newTaskButton.dataset.trackId = "agent_new_task_button_clicked";
  const document = {
    body,
    head,
    documentElement,
    createElement,
    querySelectorAll(selector) {
      if (selector !== ".cr-context-usage-requesting-tip__text") return [];
      const nodes = [];
      const walk = node => { if (node.className?.split(/\s+/).includes("cr-context-usage-requesting-tip__text")) nodes.push(node); for (const child of node.children ?? []) walk(child); };
      walk(body); return nodes;
    },
    querySelector(selector) {
      if (selector === "#root") return root;
      if (selector === ".teams-container") return conversationShellAvailable ? {} : null;
      if (selector.includes("cr-model-selector__trigger")) return nativeModelTrigger;
      if (selector.includes("topbar") && selector.includes("actions")) return topbarActions ?? null;
      return null;
    },
    getElementById: () => null,
    addEventListener(type, listener) {
      const values = documentListeners.get(type) ?? new Set();
      values.add(listener);
      documentListeners.set(type, values);
    },
    removeEventListener(type, listener) { documentListeners.get(type)?.delete(listener); },
  };
  class FixtureMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
      this.disconnectCalls = 0;
      observers.push(this);
    }
    observe() { this.connected = true; }
    disconnect() {
      this.connected = false;
      this.disconnectCalls += 1;
    }
  }
  return {
    document,
    root,
    modelHost,
    nativeModelRoot,
    nativeModelTrigger,
    topbarActions,
    newTaskButton,
    clickNewTask() {
      const event = { target: newTaskButton, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; } };
      for (const listener of documentListeners.get("click") ?? []) {
        listener(event);
        if (event.stopped) break;
      }
      if (!event.stopped) newTaskButton.click();
      return event;
    },
    documentListenerCount(type) { return documentListeners.get(type)?.size ?? 0; },
    observers,
    notifyMutation,
    setConversationShellAvailable(value) { conversationShellAvailable = value; },
    MutationObserver: FixtureMutationObserver,
  };
}

function createNativeRendererFixture({
  appVersion = "5.9.2",
  failConversationNavigation = false,
  duplicateHarnessThreads = false,
  failFirstTurnStart = false,
  existingExternalThread = false,
  initialPath = "/",
  withTopbar = false,
  failUiUpdate = false,
  deferInitialThreadCreate = false,
  connectorStates = {},
  connectorConfigs = [],
  customMcpServers = [],
  connectorCallResult,
  connectorCallAvailable = true,
  runtimeSnapshot,
  uiState,
  accountStatus = "authenticated",
  failFirstSnapshot = false,
  contextSummary = { source: "pi-context-estimate", status: "unknown", tokens: null, contextWindow: null, breakdown: null },
  defaultApprovalMode = "manual",
  contextModels,
  executionSettings,
  rpcHandlers = {},
} = {}) {
  const calls = [];
  const connectorCalls = [];
  const busEvents = [];
  const routes = [];
  let snapshotAttempts = 0;
  const nativeConversation = { info: { id: "native-1", title: "Native", transport: "local" } };
  const original = {
    async get(id) {
      calls.push({ method: "native.get", id });
      return id === "native-1" ? nativeConversation : undefined;
    },
    async list() {
      calls.push({ method: "native.list" });
      return { items: [nativeConversation.info], total: 1, independentTotal: 1, page: 1 };
    },
    async listScope() {
      calls.push({ method: "native.listScope" });
      return { items: [nativeConversation.info], total: 1, independentTotal: 1, page: 1 };
    },
    async listByIds(ids) {
      calls.push({ method: "native.listByIds", ids });
      return ids.includes("native-1") ? [nativeConversation.info] : [];
    },
    async ensureList() { calls.push({ method: "native.ensureList" }); },
    on() { return () => {}; },
    onConversationChanged() { return () => {}; },
    setCurrentConversation(id) { calls.push({ method: "native.current", id }); },
    async create(params) { calls.push({ method: "native.create", params }); },
    async fork(id) { calls.push({ method: "native.fork", id }); },
    async delete(id) { calls.push({ method: "native.delete", id }); },
    async rename(id, title) { calls.push({ method: "native.rename", id, title }); },
    async archive(id) { calls.push({ method: "native.archive", id }); },
    async unarchive(id) { calls.push({ method: "native.unarchive", id }); },
    async move(id) { calls.push({ method: "native.move", id }); },
    async pin(id) { calls.push({ method: "native.pin", id }); },
    async unpin(id) { calls.push({ method: "native.unpin", id }); },
    async listPinned() { return []; },
    async reorderPinned(ids) { calls.push({ method: "native.reorderPinned", ids }); },
  };

  const nativeModelCalls = [];
  const nativeAdapter = {
    environmentType: "local",
    async getModels(cwd) {
      nativeModelCalls.push(cwd);
      return [{ id: "native-model", name: "Native Model" }];
    },
  };
  const dom = createFixtureDocument({ withTopbar, nativeAdapter });
  dom.document.body.dataset.appVersion = appVersion;
  const context = {
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextEncoder,
    URL,
    Date,
    Promise,
    Map,
    Set,
    Proxy,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    TypeError,
    JSON,
    RegExp,
    Math,
    encodeURIComponent,
    decodeURIComponent,
    location: { pathname: initialPath },
    navigator: { userAgent: `WorkBuddy/${appVersion}` },
    document: dom.document,
    MutationObserver: dom.MutationObserver,
  };
  context.globalThis = context;
  context.top = context;
  context.self = context;
  const connectorManager = {
    async getStates() { return connectorStates; },
    async getConfigs() { return connectorConfigs; },
  };
  if (connectorCallAvailable) {
    connectorManager.callTool = async (name, arguments_) => {
      connectorCalls.push({ name, arguments_ });
      return connectorCallResult ?? {
        success: true,
        result: { content: [{ type: "text", text: `called ${name}` }] },
      };
    };
  }
  context.__GENIE_DEFAULT_APP_PROVIDERS__ = { connectorManager };
  let nextConversationNavigationGate;
  const deferNextConversationNavigation = () => {
    let release;
    let markEntered;
    const pending = new Promise((resolve) => { release = resolve; });
    const entered = new Promise((resolve) => { markEntered = resolve; });
    nextConversationNavigationGate = { pending, markEntered };
    return { entered, release };
  };
  context.wb = {
    conversations: original,
    account: { async status() { return accountStatus; } },
    $provide(name, implementation) { this[name] = implementation; },
    $bus: { emit(name, payload) { busEvents.push({ name, payload }); } },
    navigation: {
      get route() { return context.location.pathname; },
      async goto(target) {
        if (failConversationNavigation && target?.tab === "conversation") {
          throw new Error("native navigation failed");
        }
        if (target?.tab === "conversation" && nextConversationNavigationGate) {
          const gate = nextConversationNavigationGate;
          nextConversationNavigationGate = undefined;
          gate.markEntered();
          await gate.pending;
        }
        routes.push(target);
        context.location.pathname = typeof target === "string"
          ? target
          : `/${[target.tab, target.path].filter(Boolean).join("/")}`;
      },
    },
    connectors: {
      async states() { return connectorStates; },
      async listCustomMcpServers() { return customMcpServers; },
    },
  };

  let thread = existingExternalThread ? {
    id: "fake-thread-existing",
    harnessId: "fake",
    title: "Existing external thread",
    approvalMode: defaultApprovalMode,
    status: "idle",
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    models: {
      availableModels: [
        { id: "claude-sonnet", name: "Claude Sonnet" },
        { id: "claude-opus", name: "Claude Opus" },
      ],
      currentModelId: "claude-sonnet",
    },
    turns: [],
  } : undefined;
  if (thread && contextModels) {
    thread.models.availableModels = thread.models.availableModels.map(model => ({ ...model, ...contextModels[model.id] }));
    thread.contextWindow = contextModels[thread.models.currentModelId]?.contextWindow;
  }
  if (thread && executionSettings) thread.executionSettings = structuredClone(executionSettings);
  let nextThread = thread ? 1 : 0;
  let nextTurn = 0;
  let turnStartAttempts = 0;
  let releaseInitialThreadCreate = () => {};
  let markInitialThreadCreateEntered = () => {};
  const initialThreadCreatePending = deferInitialThreadCreate
    ? new Promise((resolve) => { releaseInitialThreadCreate = resolve; })
    : Promise.resolve();
  const initialThreadCreateEntered = deferInitialThreadCreate
    ? new Promise((resolve) => { markInitialThreadCreateEntered = resolve; })
    : Promise.resolve();
  const sharedThread = (harnessId) => ({
    id: "shared-thread",
    harnessId,
    title: `${harnessId} shared thread`,
    status: "idle",
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    models: {
      availableModels: [
        { id: `${harnessId}-fast`, name: `${harnessId} Fast` },
        { id: `${harnessId}-deep`, name: `${harnessId} Deep` },
      ],
      currentModelId: `${harnessId}-fast`,
    },
    turns: [],
  });
  function resultFor(message) {
    if (Object.hasOwn(rpcHandlers, message.method)) {
      return rpcHandlers[message.method](message.params, { thread, replaceThread(value) { thread = value; } });
    }
    switch (message.method) {
      case "runtime.snapshot":
        if (failFirstSnapshot && snapshotAttempts++ === 0) {
          throw Object.assign(new Error("Daemon model service is starting"), { code: "OFFICIAL_BRIDGE_UNAVAILABLE" });
        }
        if (runtimeSnapshot) return runtimeSnapshot;
        if (duplicateHarnessThreads) {
          return {
            defaultHarnessId: "alpha",
            harnesses: [
              { id: "alpha", label: "Alpha", threads: [sharedThread("alpha")] },
              { id: "beta", label: "Beta", threads: [sharedThread("beta")] },
            ],
            recentEvents: [],
          };
        }
        return {
          defaultHarnessId: "fake",
          harnesses: [{ id: "fake", label: "Fake", approvalMode: defaultApprovalMode, threads: thread ? [thread] : [] }],
          recentEvents: [],
        };
      case "ui.snapshot":
        return {
          uiState: uiState ?? {
            active: false,
            activeThreadId: null,
            selectedHarnessId: duplicateHarnessThreads ? "alpha" : "fake",
          },
        };
      case "thread.create":
        markInitialThreadCreateEntered();
        thread = {
          id: `fake-thread-${++nextThread}`,
          harnessId: message.params.harnessId ?? "fake",
          title: message.params.title,
          approvalMode: message.params.approvalMode ?? defaultApprovalMode,
          cwd: message.params.cwd ?? null,
          ...(message.params.workspaceAutoGenerated === undefined ? {} : { workspaceAutoGenerated: message.params.workspaceAutoGenerated }),
          status: "idle",
          createdAt: "2026-09-16T00:00:00.000Z",
          updatedAt: "2026-09-16T00:00:00.000Z",
          models: {
            availableModels: [
              { id: "claude-sonnet", name: "Claude Sonnet" },
              { id: "claude-opus", name: "Claude Opus" },
            ],
            currentModelId: "claude-sonnet",
          },
          turns: [],
          ...(executionSettings ? { executionSettings: structuredClone(executionSettings) } : {}),
        };
        if (contextModels) {
          thread.models.availableModels = thread.models.availableModels.map(model => ({ ...model, ...contextModels[model.id] }));
          thread.contextWindow = contextModels[thread.models.currentModelId]?.contextWindow;
        }
        return initialThreadCreatePending.then(() => ({ thread }));
      case "thread.model.set":
        if (!thread || thread.id !== message.params.threadId) {
          throw new Error("synthetic model thread missing");
        }
        if (!thread.models.availableModels.some((model) => model.id === message.params.model)) {
          throw new Error("synthetic model unavailable");
        }
        thread = {
          ...thread,
          models: { ...thread.models, currentModelId: message.params.model },
          contextWindow: thread.contextWindows?.[message.params.model] ?? contextModels?.[message.params.model]?.contextWindow,
        };
        return { thread };
      case "thread.context.window.set": {
        const id = thread.models.currentModelId, value = message.params.contextWindow;
        if (contextModels && value !== null && !contextModels[id].supportedContextWindows.includes(value)) throw new Error("unsupported context window");
        const choices = { ...thread.contextWindows };
        if (value === null) delete choices[id]; else choices[id] = value;
        thread = { ...thread, contextWindows: choices, contextWindow: choices[id] ?? contextModels?.[id]?.contextWindow };
        return { thread };
      }
      case "thread.execution.settings.set": {
        const settings = { status: 'available', thinkingLevel: 'off', preMessageCompactPct: null, ...thread.executionSettings };
        if (Object.hasOwn(message.params, 'thoughtLevel')) settings.thinkingLevel = message.params.thoughtLevel;
        if (Object.hasOwn(message.params, 'preMessageCompactPct')) settings.preMessageCompactPct = message.params.preMessageCompactPct;
        thread = { ...thread, executionSettings: settings }; return { thread };
      }
      case "runtime.preview.note": return { noted: true };
      case "expert.resolve": return { expert: null };
      case "thread.rename":
        if (!thread || thread.id !== message.params.threadId) throw new Error("synthetic rename thread missing");
        thread = { ...thread, title: message.params.title, userDefinedTitle: true };
        return { thread };
      case "thread.context.set":
        if (!thread || thread.id !== message.params.threadId) throw new Error("synthetic context thread missing");
        thread = { ...thread, nativeContext: { ...(thread.nativeContext ?? { expert: null, connectors: [] }),
          ...(message.params.expert === undefined ? {} : { expert: message.params.expert }),
          ...(message.params.connectors === undefined ? {} : { connectors: message.params.connectors.map(item => item.name), connectorSelections: message.params.connectors }) } };
        return { thread };
      case "thread.context.usage": return { summary: contextSummary };
      case "thread.approval.set":
        if (!thread || thread.id !== message.params.threadId) throw new Error("synthetic approval thread missing");
        thread = { ...thread, approvalMode: message.params.approvalMode }; return { thread };
      case "turn.start":
        turnStartAttempts += 1;
        if (failFirstTurnStart && turnStartAttempts === 1) {
          throw new Error("synthetic turn start failure");
        }
        return { turn: { id: `turn-${++nextTurn}`, threadId: message.params.threadId } };
      case "interaction.respond":
        return { interaction: { id: message.params.interactionId, status: "approved" } };
      case "thread.delete":
        return { deleted: true, threadId: message.params.threadId };
      case "ui.update":
        if (failUiUpdate) throw new Error("synthetic ui update failure");
        return {};
      case "turn.cancel":
        return {};
      default:
        throw new Error(`Unexpected RPC: ${message.method}`);
    }
  }
  context.__testBinding = (payload) => {
    const message = JSON.parse(payload);
    calls.push({ method: message.method, params: message.params });
    let result;
    try {
      result = resultFor(message);
    } catch (error) {
      queueMicrotask(() => context.__testGlobal?.receive({
        kind: "response",
        id: message.id,
        ok: false,
        error: { message: error.message, code: error.code },
      }));
      return;
    }
    Promise.resolve(result).then(
      (resolved) => queueMicrotask(() => context.__testGlobal?.receive({
        kind: "response",
        id: message.id,
        ok: true,
        result: resolved,
      })),
      (error) => queueMicrotask(() => context.__testGlobal?.receive({
        kind: "response",
        id: message.id,
        ok: false,
        error: { message: error.message, code: error.code },
      })),
    );
  };
  return {
    context,
    original,
    nativeConversation,
    calls,
    busEvents,
    routes,
    connectorCalls,
    nativeAdapter,
    nativeModelCalls,
    dom,
    deferNextConversationNavigation,
    initialThreadCreate: {
      entered: initialThreadCreateEntered,
      release: releaseInitialThreadCreate,
    },
  };
}

test("native mux owns only wbhost conversations and bridges prompt, stream, approval and cleanup", async () => {
  const fixture = createNativeRendererFixture();
  const source = buildRendererSource({
    bindingName: "__testBinding",
    globalName: "__testGlobal",
    conversationPrefix: "wbhost:",
    contractTimeoutMs: 25,
  });
  vm.runInNewContext(source, fixture.context);

  assert.equal(await fixture.context.__testGlobal.ready, true);
  assert.notEqual(fixture.context.wb.conversations, fixture.original);
  assert.deepEqual([...fixture.context.__testGlobal.conversationIds], ["wbhost:fake:fake-thread-1"]);
  assert.equal(fixture.routes.at(-1).tab, "conversation");
  assert.equal(fixture.routes.at(-1).path, "wbhost%3Afake%3Afake-thread-1");

  const listed = await fixture.context.wb.conversations.listScope("local", { page: 1 });
  assert.deepEqual([...listed.items.map((item) => item.id)], ["native-1", "wbhost:fake:fake-thread-1"]);
  assert.equal(listed.total, 2);
  const archived = await fixture.context.wb.conversations.list({ view: "archived" });
  assert.deepEqual([...archived.items.map((item) => item.id)], ["native-1"]);
  assert.equal(await fixture.context.wb.conversations.get("native-1"), fixture.nativeConversation);
  assert.ok(fixture.calls.some((call) => call.method === "native.get" && call.id === "native-1"));

  const conversation = await fixture.context.wb.conversations.get("wbhost:fake:fake-thread-1");
  assert.equal(conversation.info.origin, "desktop");
  assert.equal(conversation.info.conversationOrigin, "local");
  assert.equal(conversation.info.lifecycle, "completed");
  assert.equal(typeof conversation.ui.input.getDraftBlocks, "function");
  assert.equal(typeof conversation.ui.view.detail.registerBeforeTargetChange, "function");
  const requestUpdates = [];
  const states = [];
  let historyLoadedCount = 0;
  conversation.on("requestUpdate", (...args) => requestUpdates.push(args));
  conversation.on("stateChange", (...args) => states.push(args));
  conversation.on("historyLoaded", () => { historyLoadedCount += 1; });
  const startsBeforeInvalidPrompt = fixture.calls.filter((call) => call.method === "turn.start").length;
  await assert.rejects(
    conversation.sendPrompt([{ type: "resource_link", uri: "file:///not-forwarded" }]),
    /纯文本输入/,
  );
  assert.equal(
    fixture.calls.filter((call) => call.method === "turn.start").length,
    startsBeforeInvalidPrompt,
  );
  await conversation.sendPrompt([{ type: "text", text: "native demo" }], {
    clientRequestId: "req-1234567890123000",
  });
  assert.ok(fixture.calls.some((call) => call.method === "turn.start" && call.params.prompt === "native demo"));
  await fixture.context.__testGlobal.refresh();
  const historyLoadedBeforeCompletion = historyLoadedCount;
  const requestBeforeCompletion = (await conversation.requestEntries()).requests[0];

  const receiveEvent = (event) => fixture.context.__testGlobal.receive({ kind: "event", event });
  const requestsBeforeUnknownEvent = (await conversation.requestEntries()).requests.length;
  receiveEvent({
    type: "thread.telemetry",
    harnessId: "fake",
    threadId: "fake-thread-1",
    payload: { metric: "ignored" },
  });
  assert.equal(
    (await conversation.requestEntries()).requests.length,
    requestsBeforeUnknownEvent,
  );
  receiveEvent({
    seq: 1,
    type: "turn.started",
    harnessId: "fake",
    threadId: "fake-thread-1",
    turnId: "turn-1",
    payload: { turn: { id: "turn-1", status: "running" } },
  });
  receiveEvent({
    seq: 2,
    type: "message.delta",
    harnessId: "fake",
    threadId: "fake-thread-1",
    turnId: "turn-1",
    payload: { messageId: "assistant-1", delta: "hello from fake" },
  });
  receiveEvent({
    seq: 3,
    type: "tool.created",
    harnessId: "fake",
    threadId: "fake-thread-1",
    turnId: "turn-1",
    payload: { id: "tool-1", type: "tool", name: "apply_patch", status: "awaiting_approval" },
  });
  receiveEvent({
    seq: 4,
    type: "interaction.requested",
    harnessId: "fake",
    threadId: "fake-thread-1",
    turnId: "turn-1",
    interactionId: "approval-1",
    payload: {
      id: "approval-1",
      status: "pending",
      title: "Allow patch?",
      toolItemId: "tool-1",
      toolCall: { name: "write", input: { path: "fixture.txt", content: "review-before-allow" } },
      options: [{ id: "allow-once", kind: "allow_once", label: "Allow once" }],
    },
  });
  assert.equal(conversation.getPendingInfo().id, "approval-1");
  assert.equal(conversation.getPendingInfo().options[0].optionId, "allow-once");
  const runtimePolicy = conversation.getPendingInfo().metadata.runtimeSecurity;
  assert.equal(runtimePolicy.action, "requireApproval");
  assert.equal(runtimePolicy.defaultDecision, "deny");
  assert.equal(runtimePolicy.ruleName, "Pi write");
  assert.deepEqual(JSON.parse(runtimePolicy.hitContent), {
    path: "fixture.txt", content: "review-before-allow",
  });
  receiveEvent({
    seq: 5,
    type: "interaction.requested",
    harnessId: "fake",
    threadId: "fake-thread-1",
    turnId: "turn-1",
    interactionId: "approval-2",
    payload: {
      id: "approval-2",
      status: "pending",
      title: "Allow second action?",
      toolItemId: "tool-2",
      options: [{ id: "reject", kind: "reject_once", label: "Reject" }],
    },
  });
  assert.equal(conversation.getPendingInfo().id, "approval-1");
  await conversation.resolvePending("approval-1", { optionId: "allow-once" });
  assert.ok(fixture.calls.some((call) => (
    call.method === "interaction.respond" && call.params.interactionId === "approval-1"
  )));
  receiveEvent({
    seq: 6,
    type: "interaction.resolved",
    harnessId: "fake",
    threadId: "fake-thread-1",
    turnId: "turn-1",
    interactionId: "approval-1",
    payload: { status: "approved" },
  });
  assert.equal(conversation.getPendingInfo().id, "approval-2");
  await conversation.rejectPending("approval-2");
  assert.ok(fixture.calls.some((call) => (
    call.method === "interaction.respond"
      && call.params.interactionId === "approval-2"
      && call.params.harnessId === "fake"
  )));
  receiveEvent({
    seq: 7,
    type: "interaction.resolved",
    harnessId: "fake",
    threadId: "fake-thread-1",
    turnId: "turn-1",
    interactionId: "approval-2",
    payload: { status: "rejected" },
  });
  receiveEvent({
    seq: 8,
    type: "turn.completed",
    harnessId: "fake",
    threadId: "fake-thread-1",
    turnId: "turn-1",
    payload: {
      turn: {
        id: "turn-1",
        status: "completed",
        stopReason: "end_turn",
        completedAt: "2026-09-16T00:00:01.000Z",
        items: [{ id: "assistant-1", type: "text", text: "hello from fake" }],
      },
    },
  });

  assert.equal(conversation.getPendingInfo(), undefined);
  assert.ok(requestUpdates.some(([, , chunk]) => chunk.update.sessionUpdate === "agent_message_chunk"));
  assert.ok(requestUpdates.some(([, , chunk]) => chunk.update.sessionUpdate === "tool_call"));
  assert.deepEqual([...states.at(-1).slice(0, 3)], ["working", "idle", "completed"]);
  const page = await conversation.requestEntries();
  assert.equal(page.requests.length, 1);
  assert.equal(historyLoadedCount, historyLoadedBeforeCompletion + 1);
  assert.notEqual(page.requests[0], requestBeforeCompletion);
  assert.equal(page.requests[0].state, "completed");
  assert.equal(page.requests[0].identity.requestId, page.requests[0].id);
  assert.equal(page.requests[0].identity.forkMessageId, page.requests[0].id);
  assert.equal(page.requests[0].identity.forkRequestId, page.requests[0].id);
  assert.equal(page.requests[0].requestSeq, 0);
  assert.equal(page.requests[0].finishTimestamp, page.requests[0].completedAt);
  assert.equal(page.requests[0].responseModel.id, "claude-sonnet");
  assert.equal(page.requests[0].assistantMessage.contentIdentity, "message");
  assert.match(
    page.requests[0].assistantMessage.content[0].messageId,
    /^[0-9a-f]{32}$/,
  );
  assert.equal(page.entries.length, 2);
  const firstAssistantMessageId = page.requests[0].assistantMessage.content[0].messageId;

  await conversation.sendPrompt([{ type: "text", text: "second turn" }], {
    clientRequestId: "req-2234567890123000",
  });
  receiveEvent({
    seq: 9,
    type: "turn.started",
    harnessId: "fake",
    threadId: "fake-thread-1",
    turnId: "turn-2",
    payload: { turn: { id: "turn-2", status: "running" } },
  });
  receiveEvent({
    seq: 10,
    type: "message.delta",
    harnessId: "fake",
    threadId: "fake-thread-1",
    turnId: "turn-2",
    payload: { messageId: "assistant-1", delta: "second response" },
  });
  receiveEvent({
    seq: 11,
    type: "turn.completed",
    harnessId: "fake",
    threadId: "fake-thread-1",
    turnId: "turn-2",
    payload: {
      turn: {
        id: "turn-2",
        status: "completed",
        completedAt: "2026-09-16T00:00:02.000Z",
        items: [{ id: "assistant-1", type: "text", text: "second response" }],
      },
    },
  });
  const secondPage = await conversation.requestEntries();
  assert.equal(secondPage.requests.length, 2);
  assert.notEqual(
    secondPage.requests[1].assistantMessage.content[0].messageId,
    firstAssistantMessageId,
  );

  fixture.context.__testGlobal.dispose();
  assert.equal(fixture.context.wb.conversations, fixture.original);
  assert.equal(fixture.routes.at(-1).tab, "home");
  assert.ok(fixture.busEvents.some((event) => (
    event.name === "wb:conversations:listChanged"
      && event.payload.deleted.includes("wbhost:fake:fake-thread-1")
  )));
});

test("native mux fails closed on version mismatch and does not overwrite a later owner", async () => {
  const mismatch = createNativeRendererFixture({ appVersion: "5.6.1" });
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding",
    globalName: "__testGlobal",
    conversationPrefix: "wbhost:",
    contractTimeoutMs: 1,
  }), mismatch.context);
  assert.equal(await mismatch.context.__testGlobal.ready, false);
  assert.equal(mismatch.context.__testGlobal.status, "failed");
  assert.match(mismatch.context.__testGlobal.error, /expected 5\.9\.2/);
  assert.equal(mismatch.context.wb.conversations, mismatch.original);

  const owned = createNativeRendererFixture();
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding",
    globalName: "__testGlobal",
    conversationPrefix: "wbhost:",
    contractTimeoutMs: 25,
  }), owned.context);
  assert.equal(await owned.context.__testGlobal.ready, true);
  const laterOwner = { name: "later-owner" };
  owned.context.wb.$provide("conversations", laterOwner);
  owned.context.__testGlobal.dispose();
  assert.equal(owned.context.wb.conversations, laterOwner);
  assert.ok(owned.busEvents.some((event) => (
    event.name === "wb:conversations:listChanged"
      && event.payload.deleted.includes("wbhost:fake:fake-thread-1")
  )));
});

test("5.11.1 recognizes the packaged preload identity and preserves the exact-version pin", async () => {
  const fixture = createNativeRendererFixture({ appVersion: "5.11.1" });
  delete fixture.dom.document.body.dataset.appVersion;
  fixture.context.navigator.userAgent = "Mozilla/5.0 Chrome/136.0.0.0 Electron/36.0.0";
  fixture.context.workbuddyDesktop = { appVersion: "5.11.1" };
  const options = { bindingName: "__testBinding", globalName: "__testGlobal", contractTimeoutMs: 25,
    exclusive: true, nativeUi: true };
  vm.runInNewContext(buildRendererSource(options), fixture.context);
  assert.equal(await fixture.context.__testGlobal.ready, true);
  await fixture.context.__testGlobal.dispose();

  for (const version of ["5.11.1-rc.1", "5.11.2", "5.9.2"]) {
    fixture.context.workbuddyDesktop.appVersion = version;
    vm.runInNewContext(buildRendererSource({ ...options, requiredAppVersion: "5.11.1" }), fixture.context);
    assert.equal(await fixture.context.__testGlobal.ready, false);
    assert.match(fixture.context.__testGlobal.error, /expected 5\.11\.1$/);
    assert.equal(fixture.context.wb.conversations, fixture.original);
    await fixture.context.__testGlobal.dispose();
  }
});

test("native mux fully rolls back when navigation fails after registration", async () => {
  const fixture = createNativeRendererFixture({
    failConversationNavigation: true,
    existingExternalThread: true,
    uiState: {
      active: true,
      activeThreadId: "fake-thread-existing",
      selectedHarnessId: "fake",
    },
  });
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding",
    globalName: "__testGlobal",
    conversationPrefix: "wbhost:",
    contractTimeoutMs: 25,
  }), fixture.context);

  assert.equal(await fixture.context.__testGlobal.ready, false);
  assert.equal(fixture.context.__testGlobal.status, "failed");
  assert.match(fixture.context.__testGlobal.error, /native navigation failed/);
  assert.equal(fixture.context.wb.conversations, fixture.original);
  assert.deepEqual([...fixture.context.__testGlobal.conversationIds], []);
  assert.ok(fixture.busEvents.some((event) => (
    event.name === "wb:conversations:listChanged"
      && event.payload.deleted.includes("wbhost:fake:fake-thread-existing")
  )));

  const addedBeforeWait = fixture.busEvents.filter((event) => event.payload?.added?.length).length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const addedAfterWait = fixture.busEvents.filter((event) => event.payload?.added?.length).length;
  assert.equal(addedAfterWait, addedBeforeWait);
});

test("external conversation can retry after a turn start failure", async () => {
  const fixture = createNativeRendererFixture({ failFirstTurnStart: true });
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding",
    globalName: "__testGlobal",
    conversationPrefix: "wbhost:",
    contractTimeoutMs: 25,
  }), fixture.context);
  assert.equal(await fixture.context.__testGlobal.ready, true);
  const conversation = await fixture.context.wb.conversations.get("wbhost:fake:fake-thread-1");

  await assert.rejects(
    conversation.sendPrompt([{ type: "text", text: "first fails" }]),
    /synthetic turn start failure/,
  );
  assert.equal(conversation.info.state, "error");
  const states = [];
  conversation.on("stateChange", (...args) => states.push(args));
  await conversation.sendPrompt([{ type: "text", text: "retry works" }]);
  assert.equal(
    fixture.calls.filter((call) => call.method === "turn.start").length,
    2,
  );
  fixture.context.__testGlobal.receive({
    kind: "event",
    event: {
      seq: 1,
      type: "turn.failed",
      harnessId: "fake",
      threadId: "fake-thread-1",
      turnId: "turn-1",
      payload: {
        turn: { id: "turn-1", status: "failed", items: [] },
        error: { code: "ACP_BROKEN", message: "agent failed visibly" },
      },
    },
  });
  assert.equal(states.at(-1)[3].code, "ACP_BROKEN");
  assert.equal(states.at(-1)[3].message, "agent failed visibly");
  fixture.context.__testGlobal.dispose();
});


test("5.9.1 streaming uses full typed patches before completion and stable block indexes", async () => {
  const fixture = createNativeRendererFixture();
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  const conversation = await fixture.context.wb.conversations.get("wbhost:fake:fake-thread-1");
  const updates = [];
  conversation.on("requestUpdate", (requestId, messageId, chunk, patches) => {
    // 5.9.1's native requestUpdate consumer immediately calls patches.some().
    assert.ok(Array.isArray(patches), "typed patches are required by the native view");
    patches.some((patch) => patch.kind === "assistant-block-upserted");
    updates.push({ requestId, messageId, chunk, patches });
  });
  await conversation.sendPrompt([{ type: "text", text: "你好" }], { clientRequestId: "req-591" });
  assert.equal(updates[0].patches[0].kind, "user-content-replaced");
  assert.equal(updates[0].patches[0].content[0].text, "你好");
  const event = (type, payload) => api.receive({ kind: "event", event: {
    type, harnessId: "fake", threadId: "fake-thread-1", turnId: "turn-1", payload,
  }});
  event("message.delta", { messageId: "a1", delta: "你" });
  const firstPatch = updates.at(-1).patches[0];
  assert.equal(firstPatch.index, 0);
  assert.equal(firstPatch.block.text, "你");
  event("message.delta", { messageId: "a1", delta: "好" });
  assert.equal(updates.at(-1).patches[0].block.text, "你好");
  assert.equal(firstPatch.block.text, "你", "previous update must remain a snapshot");
  event("tool.created", { id: "read1", name: "read", type: "tool", input: { path: "a.txt" }, status: "running" });
  assert.deepEqual([...updates.at(-1).patches.map((patch) => patch.index)], [0, 1]);
  assert.equal(updates.at(-1).patches[1].block.toolCallId, "read1");
  event("tool.updated", { id: "read1", name: "read", type: "tool", output: "contents", status: "completed" });
  assert.equal(updates.at(-1).patches[1].block.rawOutput, "contents");
  assert.equal(updates.at(-1).patches[1].context.conversationRequestId, "req-591");
  assert.equal(conversation.info.state, "working", "patches are visible while the turn is still running");
  assert.equal(conversation.ui.input.wouldQueue(), false);
  assert.equal(typeof conversation.ui.input.checkpointRead, "function");
  assert.equal(typeof conversation.ui.lifecycle.listInputHistory, "function");
  assert.equal((await conversation.requestEntries({ resultScope: "all-loaded" })).requests.length, 1);
  await api.dispose();
});


test("sidebar return from native knowledge view persists Pi route once and restores it after restart", async () => {
  const fixture = createNativeRendererFixture({
    existingExternalThread: true, initialPath: "/conversation/native-1", withTopbar: true,
  });
  const source = buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25,
  });
  vm.runInNewContext(source, fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  await api.switchSource("external");
  await api.switchSource("native");
  assert.equal(fixture.calls.filter((call) => call.method === "ui.update").at(-1).params.active, false);
  const writesBeforeSidebar = fixture.calls.filter((call) => call.method === "ui.update").length;
  fixture.context.location.pathname = "/lexiang";
  for (const observer of fixture.dom.observers) observer.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.filter((call) => call.method === "ui.update").length, writesBeforeSidebar,
    "native More/knowledge routes must retain their existing persistence semantics");

  // Native sidebar routing calls get(), bypassing the mux's current reporter.
  const externalId = "wbhost:fake:fake-thread-existing";
  fixture.context.location.pathname = `/conversation/${encodeURIComponent(externalId)}`;
  await fixture.context.wb.conversations.get(externalId);
  for (let index = 0; index < 20; index += 1) {
    for (const observer of fixture.dom.observers) observer.callback();
  }
  await api.switchSource("external"); // Same rendered source must still wait for persistence.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.sourceMode, "external");
  const writes = fixture.calls.filter((call) => call.method === "ui.update");
  assert.equal(writes.length, writesBeforeSidebar + 1, "same route writes are coalesced across getter, observer and source switch");
  const persisted = writes.at(-1).params;
  assert.deepEqual(persisted, {
    active: true, activeThreadId: "fake-thread-existing", selectedHarnessId: "fake",
  });
  assert.equal(fixture.calls.some((call) => call.method === "turn.start"), false);

  const restored = createNativeRendererFixture({
    existingExternalThread: true, initialPath: "/lexiang", uiState: persisted,
  });
  vm.runInNewContext(source, restored.context);
  assert.equal(await restored.context.__testGlobal.ready, true);
  assert.equal(restored.context.__testGlobal.sourceMode, "external");
  assert.equal(restored.context.location.pathname, `/conversation/${encodeURIComponent(externalId)}`);
  assert.equal(restored.calls.some((call) => call.method === "turn.start"), false);
  await restored.context.__testGlobal.dispose();
  await api.dispose();
});


test("normal quit can preserve Pi selection while default disposal still notifies native fallback", async () => {
  const source = buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25,
  });
  for (const preserveUiState of [true, false]) {
    const fixture = createNativeRendererFixture({ withTopbar: true });
    vm.runInNewContext(source, fixture.context);
    const api = fixture.context.__testGlobal;
    assert.equal(await api.ready, true);
    assert.equal(api.sourceMode, "external");
    const writesBefore = fixture.calls.filter((call) => call.method === "ui.update");
    assert.equal(writesBefore.at(-1).params.active, true);
    await api.dispose(preserveUiState ? { preserveUiState: true } : undefined);
    const writesAfter = fixture.calls.filter((call) => call.method === "ui.update");
    assert.equal(writesAfter.length, writesBefore.length + (preserveUiState ? 0 : 1));
    assert.equal(writesAfter.at(-1).params.active, preserveUiState);
    assert.equal(fixture.context.wb.conversations, fixture.original);
    assert.equal(fixture.context.location.pathname, "/home");
    assert.equal(fixture.context.__testGlobal, undefined);
    assert.ok(fixture.dom.observers.every((observer) => !observer.connected));
    assert.equal(fixture.calls.some((call) => call.method === "turn.start"), false);
  }
});

test("exclusive renderer exposes only the Pi engine and excludes native controllers and task lists", async () => {
  const fixture = createNativeRendererFixture({
    existingExternalThread: true, initialPath: "/conversation/native-1", withTopbar: true,
  });
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25, exclusive: true,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.exclusive, true);
  assert.equal(api.sourceMode, "external");
  const badge = fixture.dom.topbarActions.children.find((node) => node.dataset.workbuddyHostEngine === "pi");
  assert.equal(badge.textContent, "Pi 引擎");
  assert.equal(badge.getAttribute("role"), "status");
  assert.equal(fixture.dom.topbarActions.children.some((node) => node.classList.contains("wb-segmented")), false);
  await assert.rejects(api.switchSource("native"), /仅使用 Pi/);

  const mux = fixture.context.wb.conversations;
  assert.equal(await mux.get("native-1"), undefined);
  assert.deepEqual([...(await mux.list()).items.map((item) => item.id)], ["wbhost:fake:fake-thread-existing"]);
  assert.deepEqual([...(await mux.listScope("local", {})).items.map((item) => item.id)], ["wbhost:fake:fake-thread-existing"]);
  assert.deepEqual([...(await mux.local.list()).items.map((item) => item.id)], ["wbhost:fake:fake-thread-existing"]);
  assert.deepEqual([...(await mux.listByIds(["native-1", "wbhost:fake:fake-thread-existing"])).map((item) => item.id)], ["wbhost:fake:fake-thread-existing"]);
  await mux.ensureList("local");
  assert.equal(fixture.calls.some((call) => [
    "native.get", "native.list", "native.listScope", "native.listByIds", "native.ensureList",
  ].includes(call.method)), false);
  await api.dispose({ preserveUiState: true });
});

test("exclusive home opens a Pi controller before editing and new-task bypasses native model loading", async () => {
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: "/home" });
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25, exclusive: true,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  assert.equal(fixture.context.location.pathname, "/conversation/wbhost%3Afake%3Afake-thread-existing");
  assert.equal(fixture.dom.document.body.classList.contains("workbuddy-host-external-default"), true);
  const mux = fixture.context.wb.conversations;
  const homeConversation = await mux.create({ title: "Home task", cwd: "/tmp/pi-workspace", transport: "local" });
  await homeConversation.sendPrompt([{ type: "text", text: "from home" }]);
  assert.deepEqual(fixture.calls.find((call) => call.method === "thread.create").params, {
    harnessId: "fake", title: "Home task", cwd: "/tmp/pi-workspace",
  });
  assert.equal(fixture.calls.find((call) => call.method === "turn.start").params.prompt, "from home");

  const newTaskEvent = fixture.dom.clickNewTask();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(newTaskEvent.prevented, true);
  assert.equal(newTaskEvent.stopped, true);
  const nextConversation = await mux.get(decodeURIComponent(fixture.context.location.pathname.split("/").at(-1)));
  assert.notEqual(nextConversation.info.id, homeConversation.info.id);
  await assert.rejects(mux.create({ transport: "cloud" }), /仅支持本地任务/);
  assert.equal(fixture.calls.filter((call) => call.method === "thread.create").length, 1, "reuse the existing empty Pi composer");
  assert.equal(fixture.calls.some((call) => call.method === "native.create"), false);
  await api.dispose({ preserveUiState: true });
});

test("exclusive renderer waits for actual official authentication even when the shell exists behind login", async () => {
  const fixture = createNativeRendererFixture({ initialPath: "/home", withTopbar: true, accountStatus: "unauthenticated" });
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 1, exclusive: true,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(api.status, "booting");
  assert.equal(fixture.context.wb.conversations, fixture.original);
  assert.equal(fixture.calls.length, 0);
  fixture.context.wb.account.status = async () => "authenticated";
  assert.equal(await api.ready, true);
  assert.match(fixture.context.location.pathname, /^\/conversation\/wbhost/);
  await api.dispose({ preserveUiState: true });
});

const homeRouteSource = process.env.WORKBUDDY_TEST_SOURCE_ASAR
  ?? fileURLToPath(new URL('../../evidence/pi-latest-20261104/source/WorkBuddy.app/Contents/Resources/app.asar', import.meta.url));

test('5.11.1 home skips early prewarm and routes the first pure-text send to Pi after login', {
  skip: !fs.existsSync(homeRouteSource),
}, async () => {
  const { bytes } = applyNativeHomeRoutePatch(inspectAsar(homeRouteSource));
  const source = bytes.toString('utf8');
  const between = (first, last) => {
    const start = source.indexOf(first), end = source.indexOf(last, start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
  };
  const fixture = createNativeRendererFixture({ appVersion: '5.11.1', initialPath: '/home', accountStatus: 'unauthenticated' });
  vm.createContext(fixture.context);
  const home = vm.runInContext(`
    ${between('function getPiHomeConversations(', 'function useCreateHomeTask(')}
    ({
      prewarm(n, isHomeTaskPrewarmEnabled, claimHomeTaskPrewarm) {
        let s = {};
        ${between('if(!getPiHomeConversations(n.wb)', 'let t=b({...e,blocks:[]}')}
        return true;
      },
      async create(n, R, B) {
        await waitForPiHomeConversations(n.wb);
        ${between('const wbPiConversations=requirePiHomeConversations(n.wb)', 'if(ensureCurrentAccount(),isApiError(V))')}
        return V;
      }
    })
  `, fixture.context);
  let claims = 0;
  const owner = { wb: fixture.context.wb };
  assert.equal(home.prewarm(owner, () => true, () => ++claims > 0), false);
  assert.equal(claims, 0);
  const send = home.create(owner, { cwd: '', model: 'claude-opus' }, {
    reuse: { conversationId: 'native-1', created: { info: { id: 'native-1' } } },
  });
  vm.runInContext(buildRendererSource({ bindingName: '__testBinding', globalName: '__workbuddyPi',
    exclusive: true, nativeUi: true }), fixture.context);
  const api = fixture.context.__workbuddyPi;
  fixture.context.__testGlobal = api;
  try {
    assert.equal(api.homeConversations(owner.wb), undefined);
    assert.equal(fixture.calls.some(call => call.method === 'native.create' || call.method === 'thread.create'), false);
    fixture.context.wb.account.status = async () => 'authenticated';
    const conv = await send;
    assert.equal(api.status, 'ready');
    assert.notEqual(conv.info.id, 'native-1');
    await conv.start();
    await conv.ui.input.sendPrompt({ blocks: [{ type: 'text', text: 'first launch' }] }, { modelId: 'claude-opus' });
    assert.equal(fixture.calls.filter(call => call.method === 'thread.create').length, 1);
    assert.equal(fixture.calls.filter(call => call.method === 'turn.start').length, 1);
    assert.equal(fixture.calls.some(call => call.method === 'native.create'), false);
    assert.equal(api.homeConversations({ conversations: fixture.original }), undefined);
  } finally {
    await api.dispose({ preserveUiState: true });
  }
});

test("exclusive new task does not reuse a formerly empty thread after its first prompt", async () => {
  const fixture = createNativeRendererFixture({ initialPath: "/home" });
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25, exclusive: true,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  const first = fixture.context.location.pathname;
  const controller = await fixture.context.wb.conversations.get(decodeURIComponent(first.split("/").at(-1)));
  await controller.sendPrompt([{ type: "text", text: "one real request" }]);
  fixture.dom.clickNewTask();
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(fixture.context.location.pathname, first);
  assert.equal(fixture.calls.filter((call) => call.method === "thread.create").length, 2);
  await api.dispose({ preserveUiState: true });
});

test("exclusive renderer waits for the original logged-in shell contract without initiating Pi or navigating", async () => {
  const fixture = createNativeRendererFixture({ initialPath: "/login", withTopbar: true });
  fixture.dom.setConversationShellAvailable(false);
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 1, exclusive: true,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(api.status, "booting");
  assert.equal(fixture.context.wb.conversations, fixture.original);
  assert.equal(fixture.context.location.pathname, "/login");
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.dom.topbarActions.children.length, 0);

  fixture.context.location.pathname = "/home";
  fixture.dom.setConversationShellAvailable(true);
  assert.equal(await api.ready, true);
  assert.equal(fixture.calls.filter((call) => call.method === "thread.create").length, 1);
  await api.dispose({ preserveUiState: true });
});

test("exclusive boot failure leaves a failed Pi create gate instead of restoring native execution", async () => {
  const fixture = createNativeRendererFixture({ failConversationNavigation: true });
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25, exclusive: true,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, false);
  assert.equal(api.status, "failed");
  assert.notEqual(fixture.context.wb.conversations, fixture.original);
  await assert.rejects(fixture.context.wb.conversations.create({ title: "No fallback" }), /尚未就绪/);
  assert.equal(fixture.calls.some((call) => call.method === "native.create"), false);
  await api.dispose({ preserveUiState: true });
});

test("exclusive mode preserves knowledge routes and restores the persisted Pi owner after reload", async () => {
  const fixture = createNativeRendererFixture({
    existingExternalThread: true, initialPath: "/lexiang", withTopbar: true,
  });
  const source = buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25, exclusive: true,
  });
  vm.runInNewContext(source, fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  assert.equal(fixture.context.location.pathname, "/lexiang");
  assert.equal(fixture.dom.document.body.classList.contains("workbuddy-host-external-default"), false);
  assert.equal(await api.switchSource("external"), true);
  const persisted = fixture.calls.filter((call) => call.method === "ui.update").at(-1).params;
  assert.equal(persisted.activeThreadId, "fake-thread-existing");
  await api.dispose({ preserveUiState: true });

  const restored = createNativeRendererFixture({
    existingExternalThread: true, initialPath: "/home", uiState: { ...persisted, active: false },
  });
  vm.runInNewContext(source, restored.context);
  assert.equal(await restored.context.__testGlobal.ready, true);
  assert.equal(restored.context.location.pathname, "/conversation/wbhost%3Afake%3Afake-thread-existing");
  assert.equal(restored.calls.some((call) => call.method === "thread.create"), false);
  assert.equal(restored.calls.some((call) => call.method === "turn.start"), false);
  await restored.context.__testGlobal.dispose({ preserveUiState: true });
});

test("native UI keeps home, native DOM and sidebar actions unchanged across repeated injection", async () => {
  const source = buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25, exclusive: true, nativeUi: true,
  });
  for (const existingExternalThread of [false, true]) {
    const fixture = createNativeRendererFixture({
      initialPath: "/home", withTopbar: true, existingExternalThread,
      uiState: { active: true, activeThreadId: "fake-thread-existing", selectedHarnessId: "fake" },
    });
    const { document, topbarActions, modelHost, nativeModelTrigger } = fixture.dom;
    document.body.className = "native-home";
    const originalStyle = document.createElement("style");
    originalStyle.textContent = ".native-home { color: inherit; }";
    document.head.append(originalStyle);
    const nativeAction = document.createElement("button");
    nativeAction.textContent = "原生操作";
    topbarActions.append(nativeAction);
    let nativeModelClicks = 0;
    let nativeNewTaskClicks = 0;
    nativeModelTrigger.addEventListener("click", () => { nativeModelClicks += 1; });
    fixture.dom.newTaskButton.addEventListener("click", () => { nativeNewTaskClicks += 1; });
    const bodyChildren = [...document.body.children];
    const modelChildren = [...modelHost.children];

    vm.runInNewContext(source, fixture.context);
    const api = fixture.context.__testGlobal;
    assert.equal(await api.ready, true);
    assert.equal(api.nativeUi, true);
    vm.runInNewContext(source, fixture.context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.context.__testGlobal, api);
    assert.equal(fixture.context.location.pathname, "/home");
    assert.deepEqual(fixture.routes, []);
    assert.equal(fixture.calls.some((call) => call.method === "thread.create"), false);
    assert.deepEqual(document.head.children, [originalStyle]);
    assert.equal(originalStyle.textContent, ".native-home { color: inherit; }");
    assert.equal(document.body.className, "native-home");
    assert.deepEqual(document.body.children, bodyChildren);
    assert.deepEqual(topbarActions.children, [nativeAction]);
    assert.deepEqual(modelHost.children, modelChildren);
    assert.equal(fixture.dom.observers.length, 1);
    assert.equal(fixture.dom.documentListenerCount("click"), 0);
    const click = fixture.dom.clickNewTask();
    nativeModelTrigger.click();
    assert.equal(click.prevented, false);
    assert.equal(click.stopped, false);
    assert.equal(nativeNewTaskClicks, 1);
    assert.equal(nativeModelClicks, 1);
    assert.equal(nativeModelTrigger.listenerCount("click"), 1);
    assert.equal(fixture.calls.some((call) => call.method === "thread.create"), false);
    await api.dispose({ preserveUiState: true });
    assert.equal(document.body.className, "native-home");
    assert.deepEqual(document.head.children, [originalStyle]);
  }
});

test("native UI preserves knowledge routes and hydrates an existing Pi route without navigation", async () => {
  for (const initialPath of ["/lexiang", "/conversation/wbhost%3Afake%3Afake-thread-existing"]) {
    const fixture = createNativeRendererFixture({
      existingExternalThread: true, initialPath, withTopbar: true,
      uiState: { active: true, activeThreadId: "fake-thread-existing", selectedHarnessId: "fake" },
    });
    const source = buildRendererSource({
      bindingName: "__testBinding", globalName: "__testGlobal",
      conversationPrefix: "wbhost:", contractTimeoutMs: 25, exclusive: true, nativeUi: true,
    });
    vm.runInNewContext(source, fixture.context);
    const api = fixture.context.__testGlobal;
    assert.equal(await api.ready, true);
    vm.runInNewContext(source, fixture.context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.context.location.pathname, initialPath);
    assert.deepEqual(fixture.routes, []);
    assert.equal(fixture.calls.some((call) => call.method === "thread.create"), false);
    const controller = await fixture.context.wb.conversations.get("wbhost:fake:fake-thread-existing");
    assert.equal(controller.info.title, "Existing external thread");
    assert.equal(controller.configManager.model, "claude-sonnet");
    assert.equal(fixture.dom.topbarActions.children.length, 0);
    assert.equal(fixture.dom.observers.length, 1);
    await api.dispose({ preserveUiState: true });
  }
});

test("native UI merges Pi conversations while preserving native list, local, pinned and ensureList queries", async () => {
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: "/home" });
  const filter = { page: 1, keyword: "", view: "active" };
  const observed = [];
  const nativeInfo = fixture.nativeConversation.info;
  fixture.original.list = async (value) => { observed.push(["list", value]); return { items: [nativeInfo], total: 1 }; };
  fixture.original.listScope = async (space, value) => { observed.push(["listScope", space, value]); return { items: [nativeInfo], total: 1 }; };
  fixture.original.local = { async list(value) { observed.push(["local.list", value]); return { items: [nativeInfo], total: 1 }; } };
  fixture.original.ensureList = async (space, value) => { observed.push(["ensureList", space, value]); return "native-ready"; };
  fixture.original.listPinned = async () => { observed.push(["listPinned"]); return [nativeInfo]; };
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25, exclusive: true, nativeUi: true,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  const mux = fixture.context.wb.conversations;
  const expected = ["native-1", "wbhost:fake:fake-thread-existing"];
  assert.deepEqual([...(await mux.list(filter)).items.map((item) => item.id)], [...expected].reverse());
  assert.deepEqual([...(await mux.listScope("local", filter)).items.map((item) => item.id)], [...expected].reverse());
  assert.deepEqual([...(await mux.local.list(filter)).items.map((item) => item.id)], [...expected].reverse());
  assert.deepEqual([...(await mux.listByIds(expected)).map((item) => item.id)], expected);
  assert.equal(await mux.ensureList("local", filter), "native-ready");
  await mux.pin(expected[1]);
  assert.deepEqual([...(await mux.listPinned()).map((item) => item.id)], expected);
  await mux.reorderPinned(expected);
  assert.deepEqual(JSON.parse(JSON.stringify(observed)), [
    ["list", { ...filter, size: 50 }], ["listScope", "local", { ...filter, size: 50 }], ["local.list", { ...filter, size: 50 }],
    ["ensureList", "local", { ...filter, size: 50 }], ["listPinned"],
  ]);
  assert.equal(fixture.calls.some((call) => call.method === "native.listByIds"), true);
  assert.deepEqual(fixture.calls.find((call) => call.method === "native.reorderPinned").ids, ["native-1"]);
  await api.dispose({ preserveUiState: true });
});

test("native UI creates only Pi tasks with native titles, empty workspace and initial model, and can stop", async () => {
  const fixture = createNativeRendererFixture({ initialPath: "/home" });
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25, exclusive: true, nativeUi: true,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  const mux = fixture.context.wb.conversations;
  const controller = await mux.create({ cwd: "", model: "claude-opus", transport: "local" });
  assert.equal(controller.info.title, "新对话");
  assert.deepEqual(fixture.calls.find((call) => call.method === "thread.create").params, {
    harnessId: "fake", title: "新对话", workspaceAutoGenerated: true, model: "claude-opus", approvalMode: "manual",
  });
  await controller.start();
  assert.equal(fixture.calls.some((call) => call.method === "turn.start"), false);
  for (const modelId of ["", " ", 1, null, "bad\u0000model"]) {
    await assert.rejects(controller.ui.input.sendPrompt({ blocks: [{ type: "text", text: "invalid model" }] }, { modelId }), /non-empty string/);
  }
  assert.equal((await controller.requestEntries()).requests.length, 0);
  await controller.ui.input.sendPrompt({ blocks: [{ type: "text", text: "native composer prompt" }] }, {
    _startIntent: true, modelId: "claude-opus", clientRequestId: "native-ui-first-prompt",
  });
  await controller.cancel();
  assert.equal(fixture.calls.find((call) => call.method === "turn.start").params.prompt, "native composer prompt");
  assert.equal(fixture.calls.find((call) => call.method === "turn.start").params.model, "claude-opus");
  assert.deepEqual(fixture.calls.find((call) => call.method === "turn.cancel").params, {
    harnessId: "fake", threadId: "fake-thread-1", turnId: "turn-1",
  });
  const titled = await mux.create({ title: " 用户标题 ", cwd: "/tmp/project", transport: "local" });
  assert.equal(titled.info.title, "用户标题");
  assert.deepEqual(fixture.calls.filter((call) => call.method === "thread.create").at(-1).params, {
    harnessId: "fake", title: "用户标题", cwd: "/tmp/project", workspaceAutoGenerated: false, approvalMode: "manual",
  });
  assert.equal((await mux.fork("native-1")).errorCode, "NOT_SUPPORTED");
  await assert.rejects(mux.create({ transport: "cloud" }), /仅支持本地任务/);
  assert.equal(fixture.calls.some((call) => ["native.create", "native.fork"].includes(call.method)), false);
  assert.equal(fixture.dom.modelHost.children.length, 1);
  assert.equal(fixture.dom.nativeModelTrigger.listenerCount("click"), 0);
  assert.equal(fixture.dom.documentListenerCount("click"), 0);
  await api.dispose({ preserveUiState: true });
});

test("native UI leaves a failed Pi create gate when the Host cannot initialize", async () => {
  const fixture = createNativeRendererFixture({ initialPath: "/home", failFirstSnapshot: true });
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25, exclusive: true, nativeUi: true,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, false);
  assert.equal(api.status, "failed");
  assert.notEqual(fixture.context.wb.conversations, fixture.original);
  assert.equal(fixture.context.location.pathname, "/home");
  await assert.rejects(fixture.context.wb.conversations.create({ title: "No fallback" }), /尚未就绪/);
  assert.equal(fixture.calls.some((call) => call.method === "native.create"), false);
  await api.dispose({ preserveUiState: true });
});

test("native UI reads cached local history through a facade that cannot start native execution", async () => {
  const fixture = createNativeRendererFixture({ initialPath: "/home" });
  const invoked = [];
  const native = fixture.nativeConversation;
  native.info.tags = ["native-history"];
  const history = { requests: [{ id: "native-request-1" }], hasOlder: false };
  native.requestEntries = async () => { invoked.push("requestEntries"); return history; };
  native.requests = async () => history.requests;
  native.getRequest = (id) => history.requests.find((request) => request.id === id);
  native.getRequestByClientRequestId = native.getRequest;
  native.userPrompts = async () => ["old prompt"];
  native.inputHistory = async () => ["old input"];
  native.on = (event, listener) => {
    invoked.push(["on", event]); listener({ oldHistory: true });
    return () => invoked.push("unsubscribe");
  };
  native.onChildAgentEvent = () => () => invoked.push("child-unsubscribe");
  const noops = ["start", "preload", "ensureRuntime", "releaseRuntimeHold", "refreshContextUsage", "updateEstimatedCost", "dispose"];
  const blocked = ["sendPrompt", "runPrompt", "resend", "compact", "rewind", "checkpointRead", "registerClientTools", "clear", "cancel", "unknownExecution"];
  for (const name of [...noops, ...blocked]) native[name] = () => invoked.push(name);
  native.configManager = { model: "native-history-model", setModel() { invoked.push("native.setModel"); }, setPermissionMode() { invoked.push("native.setPermissionMode"); } };
  native.runtime = { launch() { invoked.push("native.runtime.launch"); } };
  native.ui = {
    input: {
      canSubmit: () => true, canRegenerate: () => true, wouldQueue: () => true, focus: () => true,
      getDraftBlocks: () => ["native draft"],
      sendPrompt() { invoked.push("native.ui.sendPrompt"); },
      cancel() { invoked.push("native.ui.cancel"); },
    },
    config: { setModel() { invoked.push("native.ui.setModel"); } },
  };
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25, exclusive: true, nativeUi: true,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  const mux = fixture.context.wb.conversations;
  const [first, second] = await Promise.all([mux.get("native-1"), mux.get("native-1")]);
  assert.equal(first, second);
  assert.equal(await mux.get("native-1"), first);
  assert.notEqual(first, native);
  assert.equal(first.info.title, "Native");
  assert.deepEqual([...first.info.tags.map((tag) => tag)], ["native-history"]);
  assert.equal(first.configManager.model, "native-history-model");
  await first.configManager.setPermissionMode("fullAccess");
  assert.equal(await first.requestEntries(), history);
  assert.equal(first.getRequest("native-request-1"), history.requests[0]);
  assert.equal(await first.requests(), history.requests);
  assert.deepEqual(await first.userPrompts(), ["old prompt"]);
  assert.deepEqual(await first.inputHistory(), ["old input"]);
  const events = [];
  first.on("historyLoaded", (event) => events.push(event))();
  first.onChildAgentEvent(() => {})();
  assert.deepEqual(events, [{ oldHistory: true }]);
  for (const name of noops) await first[name]();
  for (const name of blocked) assert.throws(() => first[name](), /历史会话只读/);
  assert.throws(() => first.configManager.setModel("other"), /历史会话只读/);
  assert.throws(() => { first.configManager.model = "other"; }, /历史会话只读/);
  assert.throws(() => first.ui.input.sendPrompt({ blocks: [] }), /历史会话只读/);
  assert.throws(() => first.ui.input.cancel(), /历史会话只读/);
  assert.throws(() => first.ui.config.setModel("other"), /历史会话只读/);
  assert.throws(() => first.runtime.launch(), /历史会话只读/);
  assert.equal(first.ui.input.canSubmit(), false);
  assert.equal(first.ui.input.canRegenerate(), false);
  assert.equal(first.ui.input.wouldQueue(), false);
  assert.equal(first.ui.input.focus(), false);
  assert.deepEqual([...first.ui.input.getDraftBlocks()], []);
  mux.setCurrentConversation("native-1");
  assert.equal(fixture.calls.some((call) => call.method === "native.current" && call.id === "native-1"), true);
  assert.equal(fixture.calls.filter((call) => call.method === "native.get").length, 1);
  assert.equal(fixture.calls.filter((call) => call.method === "native.listByIds").length, 1);
  assert.deepEqual(invoked, ["requestEntries", ["on", "historyLoaded"], "unsubscribe", "child-unsubscribe"]);
  assert.equal(fixture.calls.some((call) => call.method === "turn.start"), false);
  await api.dispose({ preserveUiState: true });
});

test("native UI rejects cloud or unknown history before native get or selection can connect", async () => {
  const fixture = createNativeRendererFixture({ initialPath: "/home" });
  fixture.original.listByIds = async (ids) => [{ id: ids[0], transport: ids[0] === "cloud-1" ? "cloud" : undefined }];
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25, exclusive: true, nativeUi: true,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  const mux = fixture.context.wb.conversations;
  for (const id of ["cloud-1", "unknown-1"]) {
    await assert.rejects(mux.get(id), /尚未接入 Pi/);
    assert.throws(() => mux.setCurrentConversation(id), /已确认的本地历史/);
  }
  assert.equal(fixture.calls.some((call) => ["native.get", "native.current"].includes(call.method)), false);
  await api.dispose({ preserveUiState: true });
});

test("native UI persists explicit connector selections and keeps unmapped permissions rejected", async () => {
  const fixture = createNativeRendererFixture({ initialPath: "/home" });
  const toasts = [];
  fixture.context.wb.ui = { toast(value) { toasts.push(value); } };
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25, exclusive: true, nativeUi: true,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd: "" });
  const manager = controller.configManager;
  await manager.setConnectors(["native-mcp"]);
  assert.deepEqual([...manager.connectors].map(item => item.name), ["native-mcp"]);
  await assert.rejects(manager.setExpert({ id: "native-expert" }), /未提供可用指令/);
  await assert.rejects(manager.setExpertId("native-expert"), /未提供可用指令/);
  const permission = manager.permissionMode;
  assert.equal(permission, "default");
  assert.equal(manager.useSandboxCLI, false);
  await manager.setPermissionMode("bypassPermissions");
  await manager.setPermissionMode("default-sandbox");
  assert.equal(manager.permissionMode, "default");
  await manager.setSandboxMode(false);
  assert.equal(await manager.setSandboxMode(true), false);
  assert.equal(manager.useSandboxCLI, false);
  await assert.rejects(manager.setPermissionMode("unmapped-permission"), /尚未映射/);
  assert.equal(manager.permissionMode, permission);
  await manager.setPermissionMode(permission);
  await manager.setConnectors([]);
  await manager.setConnectors(undefined);
  await manager.setConnectors(null);
  await manager.setExpert(undefined);
  await manager.setExpertId("");
  assert.deepEqual([...manager.connectors], []);
  assert.equal(manager.expert, undefined);
  await manager.setThoughtLevel("high");
  await manager.setContextWindow(32000);
  assert.equal(manager.thoughtLevel, "high");
  assert.equal(manager.contextWindow, '32000');
  await assert.rejects(controller.sendPrompt([{ type: "image", source: "image.png" }]), /本地文件路径/);
  assert.equal(fixture.calls.some((call) => call.method === "turn.start"), false);
  assert.equal(toasts.length, 1);
  assert.equal(toasts.every((toast) => toast.type === "error" && toast.message.includes("尚未映射")), true);
  await api.dispose({ preserveUiState: true });
});

test("5.11.1 preserves initial Home and embedded connector IDs before the first Pi prompt", async () => {
  const fixture = createNativeRendererFixture({ appVersion: "5.11.1", initialPath: "/home" });
  vm.runInNewContext(buildRendererSource({ bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25, exclusive: true, nativeUi: true }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  const mux = fixture.context.wb.conversations;
  for (const addonSelection of [{ version: 2, connectorIds: ["managed"] },
    { version: 1, connectorIds: ["managed", "managed"] }, { version: 1, connectorIds: ["bad\u0000id"] },
    { version: 1, connectorIds: "managed" }]) {
    await assert.rejects(mux.create({ addonSelection }), /连接器选择无效/);
  }
  assert.equal(fixture.calls.some(call => call.method === "thread.create"), false);

  // Shipped 5.11.1 Home and embedded composers submit versioned add-on IDs.
  const connectorIds = ["connector:managed", "custom-mcp:synthetic"];
  const controller = await mux.create({ cwd: "", transport: "local", addonSelection: { version: 1, connectorIds },
    expert: { id: "expert-synthetic", prompt: "SELECTED_EXPERT" } });
  assert.deepEqual([...controller.configManager.connectors].map(item => item.name), connectorIds);
  const bound = fixture.calls.find(call => call.method === "thread.context.set");
  assert.equal(bound.params.expert.prompt, "SELECTED_EXPERT");
  assert.deepEqual(bound.params.connectors.map(item => item.name), connectorIds);
  await controller.sendPrompt([{ type: "text", text: "first prompt" }]);
  assert.ok(fixture.calls.indexOf(bound) < fixture.calls.findIndex(call => call.method === "turn.start"));
  await api.dispose();
});

test("native selections resolve actual Expert instructions, installed skills and attachment metadata without inline bytes", async () => {
  const fixture = createNativeRendererFixture({ initialPath: "/home" });
  fixture.context.wb.experts = { async get() { throw Error("offline directory"); }, custom: { async get() { return { id: "expert-local", displayName: { zh: "本地专家" }, prompt: { zh: "EXPERT-INSTRUCTIONS" } }; } } };
  fixture.context.__GENIE_DEFAULT_APP_PROVIDERS__.facades = { personalSkills: { async list() { return { results: [{ skillId: "opaque-skill", name: "fixture-skill", filePath: "/fixture/skills/a/SKILL.md", userInvocable: true }] }; } } };
  vm.runInNewContext(buildRendererSource({ bindingName: "__testBinding", globalName: "__testGlobal", conversationPrefix: "wbhost:", contractTimeoutMs: 25, exclusive: true, nativeUi: true }), fixture.context);
  const api = fixture.context.__testGlobal; assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd: "", expertId: "expert-local" });
  assert.equal(controller.configManager.expert.prompt, "EXPERT-INSTRUCTIONS");
  await controller.ui.input.setExpertSelection({ id: "full-expert", name: "Full", prompt: "NEW-INSTRUCTIONS" });
  assert.equal(controller.configManager.expertId, "full-expert");
  await controller.sendPrompt([{ type: "text", text: "look at selected data" },
    { type: "resource_link", uri: "skill://opaque-skill", name: "fixture-skill", _meta: { type: "skill", skillId: "opaque-skill" } },
    { type: "image", uri: "file:///fixture/image.png", data: "DO-NOT-FORWARD-BASE64", mimeType: "image/png", _meta: { filePath: "/fixture/image.png", blockStatus: "completed" } },
  ]);
  const sent = fixture.calls.find(call => call.method === "turn.start").params;
  assert.equal(sent.skills[0].filePath, "/fixture/skills/a/SKILL.md");
  assert.equal(sent.skills[0].userInvocable, true);
  assert.equal(sent.promptContentBlocks.length, 2);
  assert.equal(JSON.stringify(sent).includes("DO-NOT-FORWARD-BASE64"), false);
  await api.dispose({ preserveUiState: true });
});

test("auto policy seeds the native full-access preference once and respects a saved manual choice", async () => {
  const fixture = createNativeRendererFixture({ initialPath: '/home', defaultApprovalMode: 'auto' });
  const prefs = new Map([['localTaskPermissionMode', 'default-sandbox']]); const writes = [];
  fixture.context.wb.config = { async preference(key) { return prefs.get(key); }, async setPreference(key, value) { writes.push([key, value]); prefs.set(key, value); } };
  vm.runInNewContext(buildRendererSource({ bindingName: '__testBinding', globalName: '__testGlobal', conversationPrefix: 'wbhost:', exclusive: true, nativeUi: true, contractTimeoutMs: 25 }), fixture.context);
  const api = fixture.context.__testGlobal; assert.equal(await api.ready, true);
  assert.deepEqual(writes, [['localTaskPermissionMode', 'full-access']]);
  assert.ok(fixture.calls.some(call => call.method === 'ui.update' && call.params.approvalPreferenceSeed === 'pi-040-auto'));
  const controller = await fixture.context.wb.conversations.create({ cwd: '' });
  assert.equal(controller.configManager.permissionMode, 'fullAccess');
  assert.equal(fixture.calls.find(call => call.method === 'thread.create').params.approvalMode, 'auto');
  await controller.configManager.setPermissionMode('bypassPermissions');
  assert.equal(controller.configManager.permissionMode, 'fullAccess', 'Core normalization must not restore command prompts');
  prefs.set('localTaskPermissionMode', 'default-sandbox');
  await controller.ui.config.setPermissionMode('bypassPermissions');
  assert.equal(controller.configManager.permissionMode, 'default');
  assert.equal(fixture.calls.filter(call => call.method === 'thread.approval.set').at(-1).params.approvalMode, 'manual');
  prefs.set('localTaskPermissionMode', 'full-access'); await controller.ui.config.setPermissionMode('fullAccess');
  assert.equal(controller.configManager.permissionMode, 'fullAccess');
  await api.dispose({ preserveUiState: true });

  const restored = createNativeRendererFixture({ initialPath: '/home', defaultApprovalMode: 'auto', uiState: { active: false, activeThreadId: null, selectedHarnessId: 'fake', approvalPreferenceSeed: 'pi-040-auto' } });
  const retained = new Map([['localTaskPermissionMode', 'default-sandbox']]); const changed = [];
  restored.context.wb.config = { async preference(key) { return retained.get(key); }, async setPreference(key, value) { changed.push([key, value]); retained.set(key, value); } };
  vm.runInNewContext(buildRendererSource({ bindingName: '__testBinding', globalName: '__testGlobal', conversationPrefix: 'wbhost:', exclusive: true, nativeUi: true, contractTimeoutMs: 25 }), restored.context);
  assert.equal(await restored.context.__testGlobal.ready, true); assert.equal(changed.length, 0);
  await restored.context.wb.conversations.create({ cwd: '' });
  assert.equal(restored.calls.find(call => call.method === 'thread.create').params.approvalMode, 'manual');
  await restored.context.__testGlobal.dispose({ preserveUiState: true });
});

test("native UI publishes the native model event for catalog changes and an empty selection", async () => {
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: "/home" });
  vm.runInNewContext(buildRendererSource({
    bindingName: "__testBinding", globalName: "__testGlobal",
    conversationPrefix: "wbhost:", contractTimeoutMs: 25, exclusive: true, nativeUi: true,
  }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get("wbhost:fake:fake-thread-existing");
  const modelChanges = [];
  controller.on("modelChange", (event) => modelChanges.push(event));
  const updated = (seq, models) => api.receive({ kind: "event", event: {
    seq, type: "thread.updated", harnessId: "fake", threadId: "fake-thread-existing",
    payload: { thread: { id: "fake-thread-existing", harnessId: "fake", models } },
  } });
  updated(1, { currentModelId: "claude-sonnet", availableModels: [{ id: "claude-sonnet", name: "Updated Sonnet" }] });
  assert.equal(modelChanges.length, 1);
  assert.equal(modelChanges[0].conversationId, controller.info.id);
  assert.equal(modelChanges[0].currentModel, "claude-sonnet");
  assert.equal(modelChanges[0].models[0].name, "Updated Sonnet");
  updated(2, { currentModelId: null, availableModels: [{ id: "claude-opus", name: "Claude Opus" }] });
  assert.equal(modelChanges.length, 2);
  assert.equal(modelChanges[1].currentModel, "");
  assert.equal(controller.configManager.model, "");
  await controller.configManager.setModel("claude-opus");
  assert.equal(controller.configManager.model, "claude-opus");
  assert.equal(modelChanges.at(-1).currentModel, "claude-opus");
  assert.equal(fixture.nativeModelCalls.length, 0);
  assert.deepEqual(fixture.dom.modelHost.children, [fixture.dom.nativeModelRoot]);
  await api.dispose({ preserveUiState: true });
});

test('official model startup recovers from a late daemon without native fallback or manual reload', async () => {
  const fixture = createNativeRendererFixture({ initialPath: '/home', withTopbar: true, failFirstSnapshot: true });
  vm.runInNewContext(buildRendererSource({ bindingName: '__testBinding', globalName: '__testGlobal',
    conversationPrefix: 'wbhost:', contractTimeoutMs: 25, exclusive: true, officialModels: true }), fixture.context);
  const api = fixture.context.__testGlobal;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(api.status, 'booting');
  assert.equal(api.waitReason, 'official-models');
  assert.ok(fixture.dom.topbarActions.children.some(node => node.textContent.includes('正在连接官方模型')));
  assert.equal(await api.ready, true);
  assert.equal(api.waitReason, undefined);
  assert.equal(api.status, 'ready');
  assert.equal(fixture.calls.filter(call => call.method === 'runtime.snapshot').length, 2);
  assert.equal(fixture.calls.some(call => call.method === 'native.create'), false);
  await api.dispose({ preserveUiState: true });
});

test('native context display uses current Pi context events and preserves billing separately without invented categories', async () => {
  const summary = { source: 'pi-context-estimate', status: 'available', tokens: 321, contextWindow: 10000, percent: 3.21, breakdown: null };
  const thread = { id: 'fake-thread-existing', harnessId: 'fake', title: 'Usage fixture', cwd: '/fixture', status: 'idle',
    models: { currentModelId: 'claude-sonnet', availableModels: [{ id: 'claude-sonnet', name: 'Fixture' }] }, piContextUsage: summary,
    turns: [{ id: 'turn-history', status: 'completed', prompt: 'fixture', createdAt: '2026-10-25T00:00:00Z',
      usage: { input: 9000, output: 1000, totalTokens: 10000, costKnown: false }, items: [{ id: 'answer', type: 'text', text: 'fixture answer' }] }] };
  const fixture = createNativeRendererFixture({ initialPath: '/conversation/wbhost%3Afake%3Afake-thread-existing', existingExternalThread: true,
    contextSummary: summary, runtimeSnapshot: { defaultHarnessId: 'fake', harnesses: [{ id: 'fake', label: 'Fake', threads: [thread] }], recentEvents: [] } });
  vm.runInNewContext(buildRendererSource({ bindingName: '__testBinding', globalName: '__testGlobal', conversationPrefix: 'wbhost:', exclusive: true, nativeUi: true, contractTimeoutMs: 25 }), fixture.context);
  const api = fixture.context.__testGlobal; assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get('wbhost:fake:fake-thread-existing');
  const events = []; controller.on('contextUsageChanged', value => events.push(value)); await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.length); assert.ok(events.every(value => value.totalTokens === 321 && value.contextWindow === 10000 && !Object.hasOwn(value, 'byCategory')));
  const request = (await controller.requestEntries()).requests[0];
  assert.equal(request.usage, undefined); assert.equal(request.assistantMessage.usage, undefined);
  assert.equal(request.piTokenUsage.totalTokens, 10000); assert.equal(request.assistantMessage.piTokenUsage.input, 9000);
  const result = await controller.refreshContextUsage(); assert.equal(result.errorCode, 'NOT_SUPPORTED');
  const tip = fixture.dom.document.createElement('div'); tip.className = 'cr-context-usage-requesting-tip'; tip.setAttribute('role', 'tooltip');
  const text = fixture.dom.document.createElement('span'); text.className = 'cr-context-usage-requesting-tip__text'; text.textContent = '暂时无法获取用量明细，请稍后重试'; text.style.setProperty('white-space', 'nowrap');
  text.closest = selector => selector === '.cr-context-usage-requesting-tip[role="tooltip"]' ? tip : null;
  tip.append(text); fixture.dom.document.body.append(tip); await new Promise(resolve => setImmediate(resolve));
  assert.match(text.textContent, /Pi 当前上下文估算：约 321/); assert.match(text.textContent, /配置窗口 10,000/); assert.match(text.textContent, /分类明细暂不支持/);
  assert.equal(text.textContent.includes('9,000'), false);
  assert.equal(text.style.getPropertyValue('white-space'), 'normal');
  await fixture.context.wb.navigation.goto({ tab: 'home' }); fixture.dom.notifyMutation(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(text.textContent, '暂时无法获取用量明细，请稍后重试');
  assert.equal(text.style.getPropertyValue('white-space'), 'nowrap');
  assert.equal(text.style.getPropertyValue('overflow-wrap'), '');
  await api.dispose({ preserveUiState: true }); assert.equal(fixture.dom.observers.filter(observer => observer.connected).length, 0);
});

test('context tooltip also refreshes after a new Pi task completes before its next persisted snapshot', async () => {
  const summary = { source: 'pi-context-estimate', status: 'available', tokens: 500, contextWindow: 10000, percent: 5, breakdown: null };
  const fixture = createNativeRendererFixture({ initialPath: '/home', contextSummary: summary });
  vm.runInNewContext(buildRendererSource({ bindingName: '__testBinding', globalName: '__testGlobal', conversationPrefix: 'wbhost:', exclusive: true, nativeUi: true, contractTimeoutMs: 25 }), fixture.context);
  const api = fixture.context.__testGlobal; assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd: '' });
  await fixture.context.wb.navigation.goto({ tab: 'conversation', path: encodeURIComponent(controller.info.id) });
  controller.on('contextUsageChanged', () => {});
  await controller.sendPrompt([{ type: 'text', text: 'new usage fixture' }]);
  api.receive({ kind: 'event', event: { seq: 1, type: 'turn.completed', harnessId: 'fake', threadId: 'fake-thread-1', turnId: 'turn-1', payload: { turn: {
    id: 'turn-1', status: 'completed', items: [{ id: 'answer', type: 'text', text: 'fixture' }], completedAt: new Date().toISOString(), usage: { input: 10000, totalTokens: 10000 },
  } } } });
  await new Promise(resolve => setImmediate(resolve));
  const text = fixture.dom.document.createElement('span'); text.className = 'cr-context-usage-requesting-tip__text'; text.textContent = 'original'; text.closest = () => ({});
  fixture.dom.document.body.append(text); await new Promise(resolve => setImmediate(resolve));
  assert.match(text.textContent, /Pi 当前上下文估算：约 500/);
  assert.ok(fixture.calls.some(call => call.method === 'thread.context.usage'));
  assert.equal((await controller.requestEntries()).requests[0].usage, undefined);
  await api.dispose({ preserveUiState: true });
});

test('official reasoning, real token usage and selected model survive native history hydration', async () => {
  const fixture = createNativeRendererFixture({ initialPath: '/home' });
  vm.runInNewContext(buildRendererSource({ bindingName: '__testBinding', globalName: '__testGlobal',
    conversationPrefix: 'wbhost:', contractTimeoutMs: 25, exclusive: true, officialModels: true }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  const conversation = await fixture.context.wb.conversations.get(api.conversationIds[0]);
  const updates = [];
  conversation.on('requestUpdate', (...args) => updates.push(args));
  await conversation.sendPrompt([{ type: 'text', text: 'reasoning fixture' }]);
  const emit = (seq, type, payload) => api.receive({ kind: 'event', event: {
    seq, type, harnessId: 'fake', threadId: 'fake-thread-1', turnId: 'turn-1', payload,
  } });
  emit(1, 'thinking.delta', { id: 'reasoning-1', delta: '分析' });
  emit(2, 'thinking.updated', { id: 'reasoning-1', thinking: '分析完成' });
  emit(3, 'turn.usage', { usage: { input: 10, output: 2, cacheRead: 4, cacheWrite: 1, totalTokens: 17, costKnown: false } });
  const usagePatch = updates.flatMap(args => args[3] ?? []).find(patch => patch.kind === 'assistant-usage-updated');
  assert.deepEqual({ ...usagePatch.usage }, { inputTokens: 15, outputTokens: 2, lastTokens: 17 });
  emit(4, 'turn.completed', { turn: { id: 'turn-1', model: 'hy4', status: 'completed',
    completedAt: new Date().toISOString(), usage: { input: 10, output: 2, cacheRead: 4, cacheWrite: 1, totalTokens: 17 },
    items: [{ id: 'reasoning-1', type: 'thinking', thinking: '分析完成' }, { id: 'answer-1', type: 'text', text: '完成' }] } });
  const request = (await conversation.requestEntries()).requests[0];
  assert.equal(request.responseModel.id, 'hy4');
  assert.deepEqual(request.assistantMessage.content.map(block => block.type), ['reasoning', 'text']);
  assert.equal(request.assistantMessage.content[0].text, '分析完成');
  assert.equal(request.usage.inputTokens, 15);
  assert.equal(request.usage.credit, undefined);
  assert.equal(request.usage.cost, undefined);
  await api.dispose({ preserveUiState: true });
});

test('official model chooser keeps missing selection explicit and the catalog within the viewport', async () => {
  const fixture = createNativeRendererFixture({ initialPath: '/home' });
  fixture.context.innerWidth = 300;
  vm.runInNewContext(buildRendererSource({ bindingName: '__testBinding', globalName: '__testGlobal',
    conversationPrefix: 'wbhost:', contractTimeoutMs: 25, exclusive: true, officialModels: true }), fixture.context);
  const api = fixture.context.__testGlobal;
  assert.equal(await api.ready, true);
  api.receive({ kind: 'event', event: { seq: 1, type: 'thread.updated', harnessId: 'fake',
    threadId: 'fake-thread-1', payload: { thread: { id: 'fake-thread-1', harnessId: 'fake',
      models: { currentModelId: null, selectionRequired: true,
        availableModels: [{ id: 'hy4-preview-ioa', name: 'Hy4 preview', description: 'hy4-preview-ioa' }] } } } } });
  await new Promise(resolve => setImmediate(resolve));
  const selector = fixture.dom.modelHost.children.find(node => node.dataset.workbuddyHostModelSelector);
  assert.ok(selector);
  assert.equal(selector.__workbuddyHostLabel.textContent, '选择官方模型');
  selector.__workbuddyHostButton.click();
  const popover = fixture.dom.document.body.children.find(node => node.dataset.workbuddyHostModelPopover);
  assert.equal(popover.style.width, '284px');
  assert.equal(popover.style.left, '8px');
  assert.equal(popover.style.overflowY, 'auto');
  const option = popover.children[0].children[0];
  assert.equal(option.getAttribute('aria-selected'), 'false');
  assert.equal(option.children[0].children[0].children[1].textContent, 'hy4-preview-ioa');
  await api.dispose({ preserveUiState: true });
});

test('native UI local pages use native workspace filters, independent counts and one merged pagination', async () => {
  const f=createNativeRendererFixture({existingExternalThread:true,initialPath:'/home'}), calls=[];
  const root={id:'native-root',title:'native root',transport:'local',kind:'task',createdAt:1,lastActivityAt:1,space:{type:'local',cwd:'/native/default',autoGenerated:true}};
  const project={id:'native-project',title:'native project',transport:'local',kind:'task',createdAt:2,lastActivityAt:2,space:{type:'local',cwd:'/tmp/project',autoGenerated:false}};
  f.original.listScope=async(space,filter)=>{calls.push({space,filter});const all=[project,root].filter(i=>filter.excludeWorkspace?i.space.autoGenerated:filter.workspacePath?i.space.cwd===filter.workspacePath.replace(/\/+$/,''):true);return{items:all.slice((filter.page-1)*filter.size,filter.page*filter.size),total:all.length,independentTotal:all.filter(i=>i.space.autoGenerated).length,page:{current:filter.page,size:filter.size}};};
  vm.runInNewContext(buildRendererSource({bindingName:'__testBinding',globalName:'__testGlobal',conversationPrefix:'wbhost:',contractTimeoutMs:25,exclusive:true,nativeUi:true}),f.context);
  const api=f.context.__testGlobal;assert.equal(await api.ready,true);const mux=f.context.wb.conversations;
  const workspace=await mux.create({title:'workspace task',cwd:'/tmp/project'});
  assert.equal(workspace.info.space.autoGenerated,false);
  const first=await mux.listScope('local',{page:1,size:1,excludeWorkspace:true});
  assert.equal(first.total,2);assert.equal(first.independentTotal,2);assert.equal(first.items[0].id,'wbhost:fake:fake-thread-existing');
  const second=await mux.listScope('local',{page:2,size:1,excludeWorkspace:true});
  assert.equal(second.total,2);assert.equal(second.items[0].id,'native-root');assert.equal(second.page.current,2);assert.equal(calls.at(-1).filter.page,1);assert.equal(calls.at(-1).filter.size,2);
  const selected=await mux.listScope('local',{page:1,size:50,workspacePath:'/tmp/project/'});
  assert.equal(selected.total,2);assert.equal(selected.independentTotal,0);assert.equal(selected.items[0].id,workspace.info.id);
  await assert.rejects(mux.listScope('local',{workspacePath:'/tmp/project',excludeWorkspace:true}));
  await api.dispose({preserveUiState:true});
});

test('native UI enhances authoritative local ListChange snapshots using trace-specific filters', async () => {
  const f=createNativeRendererFixture({existingExternalThread:true,initialPath:'/home'}),handlers=new Map(),updates=[];
  f.original.on=(event,listener)=>{handlers.set(event,listener);return()=>handlers.delete(event);};
  f.original.ensureList=async()=>undefined;
  vm.runInNewContext(buildRendererSource({bindingName:'__testBinding',globalName:'__testGlobal',conversationPrefix:'wbhost:',contractTimeoutMs:25,exclusive:true,nativeUi:true}),f.context);
  const api=f.context.__testGlobal;assert.equal(await api.ready,true);const mux=f.context.wb.conversations;
  const workspace=await mux.create({title:'workspace',cwd:'/tmp/project'});
  const release=mux.on('listChange',(...args)=>updates.push(args));
  await mux.ensureList('local',{traceId:'root',excludeWorkspace:true,size:100000});
  await mux.ensureList('local',{traceId:'workspace',workspacePath:'/tmp/project',size:100000});
  const empty={items:[],total:0,independentTotal:0,page:{current:1,size:100000},partial:true};
  handlers.get('listChange')('local',empty,'root');
  assert.equal(updates[0][0],'local');assert.equal(updates[0][1].items[0].id,'wbhost:fake:fake-thread-existing');assert.equal(updates[0][1].total,1);assert.equal(updates[0][1].independentTotal,1);assert.equal(updates[0][1].partial,true);assert.equal(updates[0][2],'root');
  handlers.get('listChange')('local',empty,'workspace');
  assert.equal(updates[1][1].items[0].id,workspace.info.id);assert.equal(updates[1][1].independentTotal,0);
  const cloud={items:[],total:10};handlers.get('listChange')('cloud',cloud,'cloud');assert.equal(updates[2][1],cloud);
  release();assert.equal(handlers.has('listChange'),false);
  await api.dispose({preserveUiState:true});
});

test('the shipped 5.9.1 lifecycle can sync default sandbox preference before a Pi prompt', async () => {
  const raw=fs.readFileSync(new URL('./fixtures/native-sandbox-sync-591.txt',import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'),'545c1fcab20cdc90cf1d2315396a435292dd1f0d4bc69b93fe195a001f551a26');
  const consumer=vm.runInNewContext('({'+raw.toString('utf8')+'})');
  const f=createNativeRendererFixture({initialPath:'/home'});
  vm.runInNewContext(buildRendererSource({bindingName:'__testBinding',globalName:'__testGlobal',conversationPrefix:'wbhost:',contractTimeoutMs:25,exclusive:true,nativeUi:true}),f.context);
  const api=f.context.__testGlobal;assert.equal(await api.ready,true);
  const conv=await f.context.wb.conversations.create({cwd:'',model:'claude-opus'});
  assert.equal(conv.configManager.useSandboxCLI,false);
  await consumer.syncSandboxModeBeforeStart.call({resolveSandboxMode:()=>true},conv);
  assert.equal(conv.configManager.useSandboxCLI,false);
  assert.equal(conv.configManager.permissionMode,'default');
  await conv.start();await conv.ui.input.sendPrompt({blocks:[{type:'text',text:'original native startup contract'}]},{_startIntent:true,modelId:'claude-opus'});
  assert.equal(f.calls.filter(c=>c.method==='turn.start').length,1);
  assert.equal(f.calls.find(c=>c.method==='turn.start').params.model,'claude-opus');
  assert.equal(f.calls.some(c=>c.method==='native.create'),false);
  await api.dispose({preserveUiState:true});
});

test('native context configuration serializes model-menu races, emits real ConfigUpdate and gates the first prompt', async () => {
  const contextModels = {
    'claude-sonnet': { contextWindow: 300000, supportedContextWindows: [300000, 600000, 960000] },
    'claude-opus': { contextWindow: 64000, supportedContextWindows: [64000, 128000] },
  };
  const fixture = createNativeRendererFixture({ initialPath: '/home', contextModels });
  vm.runInNewContext(buildRendererSource({ bindingName: '__testBinding', globalName: '__testGlobal', conversationPrefix: 'wbhost:', exclusive: true, nativeUi: true, contractTimeoutMs: 2000 }), fixture.context);
  const api = fixture.context.__testGlobal; assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd: '' }); const updates = [];
  controller.on('configUpdate', event => updates.push(JSON.parse(JSON.stringify(event))));
  await controller.configManager.setContextWindow('960000');
  assert.equal(controller.configManager.contextWindow, '960000');
  assert.deepEqual(updates.at(-1), { conversationId: controller.info.id, options: [{ key: 'context_window', value: '960000' }] });
  for (const bad of ['NaN', '0', '-1', '1.5', {}, true]) await assert.rejects(controller.configManager.setContextWindow(bad));
  await assert.rejects(controller.configManager.setContextWindow('123456'), /unsupported/);
  assert.equal(controller.configManager.contextWindow, '960000');
  const binding = fixture.context.__testBinding; let releaseModel; let modelEntered;
  const entered = new Promise(resolve => { modelEntered = resolve; });
  fixture.context.__testBinding = payload => {
    const message = JSON.parse(payload);
    if (message.method === 'thread.model.set') { releaseModel = () => binding(payload); modelEntered(); }
    else binding(payload);
  };
  const before = fixture.calls.length;
  const model = controller.configManager.setModel('claude-opus');
  const window = controller.ui.config.setContextWindow('128000');
  const prompt = controller.ui.input.sendPrompt({ blocks: [{ type: 'text', text: 'synthetic first prompt' }] }, { modelId: 'claude-opus' });
  await entered; await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.slice(before).some(call => ['thread.context.window.set', 'turn.start'].includes(call.method)), false);
  releaseModel(); await Promise.all([model, window, prompt]);
  assert.equal(controller.configManager.contextWindow, '128000');
  const methods = fixture.calls.slice(before).map(call => call.method);
  assert.ok(methods.indexOf('thread.model.set') < methods.indexOf('thread.context.window.set'));
  assert.ok(methods.indexOf('thread.context.window.set') < methods.indexOf('turn.start'));
  assert.equal(updates.at(-1).options[0].value, '128000');
  fixture.context.__testBinding = binding;
  await controller.configManager.setModel('claude-sonnet');
  assert.equal(controller.configManager.contextWindow, '960000');
  await controller.configManager.setContextWindow('');
  assert.equal(controller.configManager.contextWindow, '300000');
  assert.equal(updates.at(-1).options[0].value, '300000');
  await api.dispose({ preserveUiState: true });
});

const plainP0 = value => JSON.parse(JSON.stringify(value));
function installP0Renderer(fixture, timeout = 2000) {
  vm.runInNewContext(buildRendererSource({ bindingName: '__testBinding', globalName: '__testGlobal', conversationPrefix: 'wbhost:',
    exclusive: true, nativeUi: true, contractTimeoutMs: timeout }), fixture.context);
  return fixture.context.__testGlobal;
}
function p0Thread(turns = []) {
  return { id: 'fake-thread-existing', harnessId: 'fake', title: 'Synthetic P0 fixture', cwd: '/synthetic/workspace',
    approvalMode: 'manual', status: 'idle', createdAt: '2026-10-27T01:00:00.000Z', updatedAt: '2026-10-27T01:10:00.000Z',
    models: { currentModelId: 'claude-sonnet', availableModels: [{ id: 'claude-sonnet', name: 'Claude Sonnet' }] },
    executionSettings: { status: 'available', thinkingLevel: 'high', preMessageCompactPct: 72.5 }, turns };
}
function p0Turns() {
  return ['alpha', 'beta', 'gamma'].map((value, index) => ({ id: 'host-turn-' + value, threadId: 'fake-thread-existing',
    prompt: value + ' synthetic prompt', status: 'completed', model: 'claude-sonnet',
    createdAt: `2026-10-27T01:0${index}:00.000Z`, completedAt: `2026-10-27T01:0${index}:02.000Z`,
    items: [{ id: 'answer-' + value, type: 'text', text: value + ' synthetic answer' }] }));
}
function p0Snapshot(thread) {
  return { defaultHarnessId: 'fake', harnesses: [{ id: 'fake', label: 'Fake', threads: [thread] }], recentEvents: [] };
}
function originalRewindConsumer(controller, toasts = []) {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/p0-native-592.source.json', import.meta.url)));
  const source = fixture.slices.find(slice => slice.name === 'useConversationRewind').source;
  const context = vm.createContext({
    console, Date, Promise,
    I$: { useMemo: work => work(), useState: value => [value, () => {}], useRef: value => ({ current: value }), useCallback: callback => callback },
    Zin: { jsx: () => ({}) }, RewindConfirmDialog: 'fixture-dialog', uue: () => false,
    useConversationApi: () => ({ input: controller.ui.input }), useConversationRuntimeWb: () => ({ ui: { toast: message => toasts.push(message) } }),
    useConversationI18n: () => key => key, useConversationSessionSelector: selector => selector({ transport: 'local' }),
    useConversationResources: () => ({ artifacts: [], loaded: true, removeArtifacts: () => {} }),
    useConversationMessagesSelector: selector => selector({ messages: [] }),
  });
  vm.runInContext(source, context);
  return context.useConversationRewind();
}

test('P0 execution settings restore from Host state and emit native option updates without overwriting persisted defaults', async () => {
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home',
    executionSettings: { status: 'available', thinkingLevel: 'high', preMessageCompactPct: 72.5 } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]), updates = [];
  assert.equal(controller.configManager.thoughtLevel, 'high'); assert.equal(controller.configManager.preMessageCompactPct, 72.5);
  assert.equal(fixture.calls.some(c => c.method === 'thread.execution.settings.set'), false);
  controller.on('configUpdate', update => updates.push(plainP0(update)));
  api.receive({ kind: 'event', event: { seq: 1, type: 'thread.updated', harnessId: 'fake', threadId: 'fake-thread-existing', payload: { thread: {
    id: 'fake-thread-existing', executionSettings: { status: 'available', thinkingLevel: 'off', preMessageCompactPct: 0 },
  } } } });
  assert.equal(controller.configManager.thoughtLevel, 'off'); assert.equal(controller.configManager.preMessageCompactPct, 0);
  assert.deepEqual(updates.at(-1), { conversationId: controller.info.id, options: [
    { key: 'thought_level', value: 'disabled' }, { key: 'preMessageCompactPct', value: '0' },
  ] });
  api.receive({ kind: 'event', event: { seq: 2, type: 'thread.updated', harnessId: 'fake', threadId: 'fake-thread-existing', payload: { thread: {
    id: 'fake-thread-existing', executionSettings: { status: 'available', thinkingLevel: 'medium', preMessageCompactPct: null },
  } } } });
  assert.equal(controller.configManager.preMessageCompactPct, undefined);
  assert.equal(updates.at(-1).options[1].value, '');
  await api.dispose({ preserveUiState: true });
});

test('P0 thinking and threshold setters await Host acknowledgements and serialize before a native first prompt', async () => {
  let releaseFirst, markEntered, calls = 0;
  const entered = new Promise(resolve => { markEntered = resolve; });
  const fixture = createNativeRendererFixture({ initialPath: '/home', executionSettings: { status: 'available', thinkingLevel: 'off', preMessageCompactPct: null },
    rpcHandlers: { 'thread.execution.settings.set': async (params, { thread, replaceThread }) => {
      if (++calls === 1) { markEntered(); await new Promise(resolve => { releaseFirst = resolve; }); }
      const settings = { ...thread.executionSettings,
        ...(Object.hasOwn(params, 'thoughtLevel') ? { thinkingLevel: params.thoughtLevel } : {}),
        ...(Object.hasOwn(params, 'preMessageCompactPct') ? { preMessageCompactPct: params.preMessageCompactPct } : {}) };
      const updated = { ...thread, executionSettings: settings }; replaceThread(updated); return { thread: updated };
    } } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd: '' }), updates = [];
  controller.on('configUpdate', update => updates.push(plainP0(update)));
  const offset = fixture.calls.length;
  const thought = controller.ui.config.setThoughtLevel('high');
  const threshold = controller.ui.config.setPreMessageCompactPct(75);
  const prompt = controller.ui.input.sendPrompt({ blocks: [{ type: 'text', text: 'Synthetic P0 first prompt' }] }, { clientRequestId: 'native-p0-first' });
  await entered; await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.configManager.thoughtLevel, 'off');
  assert.equal(fixture.calls.slice(offset).filter(c => c.method === 'thread.execution.settings.set').length, 1);
  assert.equal(fixture.calls.slice(offset).some(c => c.method === 'turn.start'), false);
  releaseFirst(); await Promise.all([thought, threshold, prompt]);
  assert.equal(controller.configManager.thoughtLevel, 'high'); assert.equal(controller.configManager.preMessageCompactPct, 75);
  const configuration = fixture.calls.slice(offset).filter(c => c.method === 'thread.execution.settings.set');
  assert.deepEqual(configuration.map(c => c.params), [
    { harnessId: 'fake', threadId: 'fake-thread-1', thoughtLevel: 'high' },
    { harnessId: 'fake', threadId: 'fake-thread-1', preMessageCompactPct: 75 },
  ]);
  const methods = fixture.calls.slice(offset).map(c => c.method);
  assert.ok(methods.lastIndexOf('thread.execution.settings.set') < methods.indexOf('turn.start'));
  assert.ok(updates.some(u => u.options.some(o => o.key === 'thought_level' && o.value === 'high')));
  assert.equal(updates.at(-1).options.find(o => o.key === 'preMessageCompactPct').value, '75');
  await api.dispose({ preserveUiState: true });
});

test('P0 rejected execution settings do not change displayed state and a later valid choice can retry', async () => {
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home',
    executionSettings: { status: 'available', thinkingLevel: 'medium', preMessageCompactPct: 80 },
    rpcHandlers: { 'thread.execution.settings.set': (params, { thread, replaceThread }) => {
      if (params.thoughtLevel === 'unsupported') throw Object.assign(new Error('Synthetic unsupported thinking level'), { code: 'PI_THINKING_UNSUPPORTED' });
      const updated = { ...thread, executionSettings: { ...thread.executionSettings, thinkingLevel: params.thoughtLevel } };
      replaceThread(updated); return { thread: updated };
    } } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]);
  await assert.rejects(controller.configManager.setThoughtLevel('unsupported'), error => error.code === 'PI_THINKING_UNSUPPORTED');
  assert.equal(controller.configManager.thoughtLevel, 'medium');
  await controller.configManager.setThoughtLevel('high'); assert.equal(controller.configManager.thoughtLevel, 'high');
  await api.dispose({ preserveUiState: true });
});

test('P0 a prompt racing a rejected configuration must not execute with stale settings', async () => {
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home',
    executionSettings: { status: 'available', thinkingLevel: 'medium', preMessageCompactPct: 80 },
    rpcHandlers: { 'thread.execution.settings.set': () => { throw Object.assign(new Error('Synthetic model does not support this setting'), { code: 'PI_THINKING_UNSUPPORTED' }); } } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]);
  const setting = controller.configManager.setThoughtLevel('unsupported');
  const prompt = controller.ui.input.sendPrompt({ blocks: [{ type: 'text', text: 'Must wait for valid settings' }] });
  const results = await Promise.allSettled([setting, prompt]);
  assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'rejected');
  assert.equal(fixture.calls.some(call => call.method === 'turn.start'), false);
  assert.equal(controller.configManager.thoughtLevel, 'medium');
  await api.dispose({ preserveUiState: true });
});

test('P0 manual compact waits for pending configuration, refreshes usage and does not send a hidden chat turn', async () => {
  let release, entered; const gate = new Promise(resolve => { entered = resolve; });
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home',
    executionSettings: { status: 'available', thinkingLevel: 'high', preMessageCompactPct: 80 },
    rpcHandlers: {
      'thread.execution.settings.set': async (params, { thread, replaceThread }) => {
        entered(); await new Promise(resolve => { release = resolve; });
        const updated = { ...thread, executionSettings: { ...thread.executionSettings, preMessageCompactPct: params.preMessageCompactPct } };
        replaceThread(updated); return { thread: updated };
      },
      'thread.compact': () => ({ compacted: true, tokensBefore: 9000, estimatedTokensAfter: 900 }),
    } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]); let historyEvents = 0;
  controller.on('historyLoaded', () => historyEvents++);
  const setting = controller.configManager.setPreMessageCompactPct(65), compacting = controller.compact();
  await gate; await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.some(c => c.method === 'thread.compact'), false);
  release(); const [, result] = await Promise.all([setting, compacting]);
  assert.equal(result.compacted, true); assert.equal(result.tokensBefore, 9000); assert.equal(historyEvents, 1);
  assert.deepEqual(fixture.calls.find(c => c.method === 'thread.compact').params, { harnessId: 'fake', threadId: 'fake-thread-existing' });
  assert.ok(fixture.calls.some(c => c.method === 'thread.context.usage'));
  assert.equal(fixture.calls.some(c => c.method === 'turn.start'), false);
  assert.equal((await controller.requestEntries()).requests.length, 0);
  await api.dispose({ preserveUiState: true });
});

// These tests cover the data facade, not a replacement detail-panel implementation.
// Shipped 5.9.2 useConversationApi replaces controller.getUiApi().view with the
// native ConversationViewActions context; SidebarNext opens its own unified-tabs
// changes view. Actual tab activation and Diff rendering need separate GUI QA.
test('P0 file resources map Host turn identities while leaving detailRef and absolute paths intact', async () => {
  const thread = p0Thread(p0Turns()), snapshot = p0Snapshot(thread);
  const rawManifest = { id: 'host-turn-beta', conversationId: thread.id, requestId: 'host-turn-beta', detailRef: 'host-turn-beta', createdAt: 1,
    files: [{ filePath: '/synthetic/workspace/report.txt', action: 'modify', detailStatus: 'available', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] }] };
  const resources = { artifacts: [{ id: 'artifact-beta', conversationId: thread.id, requestId: 'host-turn-beta', type: 'file', kind: 'media',
    uri: '/synthetic/workspace/report.txt', filePath: '/synthetic/workspace/report.txt', title: 'report.txt' }],
    files: [{ path: '/synthetic/workspace/report.txt', type: 'file', name: 'report.txt' }], manifests: [rawManifest] };
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home', runtimeSnapshot: snapshot,
    rpcHandlers: { 'thread.files': params => params.detailRef ? { detail: rawManifest } : resources } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]);
  const betaId = (await controller.requestEntries()).requests.find(r => r.userMessage.content[0].text === 'beta synthetic prompt').id;
  assert.notEqual(betaId, 'host-turn-beta');
  const artifacts = await controller.artifacts(), manifests = await controller.changeManifests(), changes = await controller.changes();
  assert.equal(artifacts[0].requestId, betaId); assert.equal(artifacts[0].conversationId, controller.info.id);
  assert.equal(artifacts[0].filePath, '/synthetic/workspace/report.txt'); assert.equal(artifacts[0].uri, artifacts[0].filePath);
  assert.equal(manifests[0].requestId, betaId); assert.equal(manifests[0].conversationId, controller.info.id); assert.equal(manifests[0].detailRef, 'host-turn-beta');
  assert.equal(changes[0].requestId, betaId);
  assert.equal((await controller.files())[0].path, '/synthetic/workspace/report.txt');
  const detail = await controller.changeDetail({ requestId: betaId, detailRef: 'host-turn-beta' });
  assert.equal(detail.requestId, betaId); assert.equal(detail.detailRef, 'host-turn-beta'); assert.equal(detail.files.length, 1);
  assert.equal(detail.files[0].hunks[0].lines[1], '+new');
  const managerItems = await controller.fileManager.artifacts(); assert.equal(managerItems.total, 1); assert.equal(managerItems.items[0].requestId, betaId);
  assert.equal((await controller.fileManager.readArtifact('artifact-beta')).requestId, betaId);
  assert.equal(fixture.calls.filter(c => c.method === 'thread.files').at(-3).params.threadId, thread.id);
  assert.ok(fixture.calls.some(c => c.method === 'thread.files' && c.params.detailRef === 'host-turn-beta'));
  assert.equal((await controller.requestEntries()).requests.length, 3, 'File queries must not invent conversation turns');
  await api.dispose({ preserveUiState: true });
});

test('P0 checkpoint preview maps native request ids to Host ids and maps restored-version ids back', async () => {
  const thread = p0Thread(p0Turns()), snapshot = p0Snapshot(thread);
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home', runtimeSnapshot: snapshot,
    rpcHandlers: { 'thread.checkpoint.read': () => ({ available: true, diff: { changes: [{ path: '/synthetic/workspace/a.txt', operation: 'write' }] },
      restoreInfo: [{ path: '/synthetic/workspace/a.txt', versionRequestId: 'host-turn-alpha', restorePoint: 'exact' },
        { path: '/synthetic/workspace/new.txt', versionRequestId: null, restorePoint: 'missing' }], forkPoint: { found: true } }) } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]), entries = (await controller.requestEntries()).requests;
  const [alpha, beta] = entries.map(r => r.id);
  const preview = await controller.ui.input.checkpointRead(beta);
  assert.equal(preview.available, true); assert.equal(preview.restoreInfo[0].versionRequestId, alpha); assert.equal(preview.restoreInfo[1].versionRequestId, null);
  assert.deepEqual(fixture.calls.find(c => c.method === 'thread.checkpoint.read').params, { harnessId: 'fake', threadId: thread.id, turnId: 'host-turn-beta' });
  const count = fixture.calls.filter(c => c.method === 'thread.checkpoint.read').length;
  await assert.rejects(controller.checkpointRead('wbhost:req:another-owner:host-turn-beta'), /Pi 检查点/);
  assert.equal(fixture.calls.filter(c => c.method === 'thread.checkpoint.read').length, count);
  assert.equal((await controller.requestEntries()).requests.length, 3);
  await api.dispose({ preserveUiState: true });
});

test('P0 rewind satisfies the original native success consumer, removes stale history and survives a refresh', async () => {
  const thread = p0Thread(p0Turns()), snapshot = p0Snapshot(thread);
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home', runtimeSnapshot: snapshot,
    rpcHandlers: { 'thread.rewind': (params, { replaceThread }) => {
      assert.equal(params.turnId, 'host-turn-beta');
      const retained = { ...thread, turns: thread.turns.slice(0, 1) }; replaceThread(retained); snapshot.harnesses[0].threads = [retained];
      return { branchChanged: true, truncatedFromRequestId: 'host-turn-beta', removedRequestIds: ['host-turn-beta', 'host-turn-gamma'] };
    } } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]), entries = (await controller.requestEntries()).requests;
  const [alpha, beta, gamma] = entries.map(r => r.id); let history = 0, artifacts = 0; const requests = [], toasts = [];
  controller.on('historyLoaded', () => history++); controller.on('artifactUpdate', () => artifacts++); controller.on('requestsChanged', value => requests.push(value.map(r => r.id)));
  await new Promise(resolve => setImmediate(resolve));
  let reply;
  const rewind = controller.ui.input.rewind; controller.ui.input.rewind = async id => { reply = await rewind(id); return reply; };
  const result = await originalRewindConsumer(controller, toasts).runRewind(beta);
  assert.equal(result, true); assert.deepEqual(toasts, []); assert.equal(reply.ok, true); assert.equal(reply.branchChanged, true);
  assert.equal(reply.truncatedFromRequestId, beta); assert.deepEqual(plainP0(reply.removedRequestIds), [beta, gamma]);
  assert.equal(history, 1); assert.equal(artifacts, 1); assert.deepEqual(plainP0(requests.at(-1)), [alpha]);
  assert.equal(controller.getRequest(beta), undefined); assert.equal(controller.getRequest(gamma), undefined);
  assert.deepEqual(plainP0((await controller.requestEntries()).requests.map(r => r.id)), [alpha]);
  await api.refresh();
  assert.deepEqual(plainP0((await controller.requestEntries()).requests.map(r => r.id)), [alpha]);
  assert.equal(controller.configManager.thoughtLevel, 'high');
  await controller.ui.input.sendPrompt({ blocks: [{ type: 'text', text: 'Synthetic continuation after rewind' }] }, { clientRequestId: 'native-after-rewind' });
  assert.equal((await controller.requestEntries()).requests.at(-1).id, 'native-after-rewind');
  assert.equal(fixture.calls.filter(c => c.method === 'thread.rewind').length, 1);
  await api.dispose({ preserveUiState: true });
});

test('P0 failed rewind preserves history and does not emit a successful artifact/history refresh', async () => {
  const thread = p0Thread(p0Turns()); let deny = false;
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home', runtimeSnapshot: p0Snapshot(thread),
    rpcHandlers: { 'thread.rewind': () => {
      if (deny) throw Object.assign(new Error('Synthetic file was externally modified'), { code: 'PI_CHECKPOINT_CONFLICT' });
      return { branchChanged: false, removedRequestIds: [] };
    } } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]), before = (await controller.requestEntries()).requests.map(r => r.id);
  let history = 0, artifacts = 0; controller.on('historyLoaded', () => history++); controller.on('artifactUpdate', () => artifacts++);
  await assert.rejects(controller.rewind(before[1]), /未确认/);
  assert.deepEqual((await controller.requestEntries()).requests.map(r => r.id), before); assert.equal(history, 0); assert.equal(artifacts, 0);
  deny = true; await assert.rejects(controller.rewind(before[1]), error => error.code === 'PI_CHECKPOINT_CONFLICT');
  assert.deepEqual((await controller.requestEntries()).requests.map(r => r.id), before); assert.equal(history, 0); assert.equal(artifacts, 0);
  await api.dispose({ preserveUiState: true });
});

test('P0 files.updated refreshes artifacts exactly once without creating phantom requests or changing idle state', async () => {
  const thread = p0Thread(p0Turns()), fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home', runtimeSnapshot: p0Snapshot(thread) });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]), before = (await controller.requestEntries()).requests.map(r => r.id);
  let artifacts = 0, requestUpdates = 0; controller.on('artifactUpdate', () => artifacts++); controller.on('requestUpdate', () => requestUpdates++);
  const update = { kind: 'event', event: { seq: 1, type: 'files.updated', harnessId: 'fake', threadId: thread.id, payload: {} } };
  api.receive(update); api.receive(update);
  assert.equal(artifacts, 1); assert.equal(requestUpdates, 0); assert.equal(controller.info.state, 'idle');
  assert.deepEqual((await controller.requestEntries()).requests.map(r => r.id), before);
  await api.dispose({ preserveUiState: true });
});

test('P0 native slash and command-link compact entries use the compaction RPC without adding a prompt', async () => {
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home',
    rpcHandlers: { 'thread.compact': () => ({ compacted: true, tokensBefore: 5000, estimatedTokensAfter: 700 }) } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]);
  const inputs = [
    [{ type: 'text', text: '/compact' }], [{ type: 'text', text: '/总结' }], [{ type: 'text', text: '  /COMPACT\n' }],
    [{ type: 'resource_link', uri: 'command://compact', name: '压缩' }],
    [{ type: 'text', text: 'Native composite command block' }, { type: 'resource_link', uri: ' command://compact ' }],
  ];
  for (const blocks of inputs) assert.deepEqual(plainP0(await controller.ui.input.sendPrompt({ blocks })), { ok: true });
  assert.deepEqual(plainP0(await controller.sendPrompt([{ type: 'text', text: '/compact' }])), { ok: true });
  assert.equal((await controller.compactConversation()).compacted, true);
  assert.equal(fixture.calls.filter(c => c.method === 'thread.compact').length, 7);
  assert.equal(fixture.calls.some(c => c.method === 'turn.start'), false);
  assert.equal((await controller.requestEntries()).requests.length, 0);
  await api.dispose({ preserveUiState: true });
});

test('P0 native compact failures return the original structured failure contract and preserve history', async () => {
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home',
    rpcHandlers: { 'thread.compact': () => { throw Object.assign(new Error('Synthetic compaction is unavailable'), { code: 'PI_COMPACTION_FAILED' }); } } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]); let history = 0;
  controller.on('historyLoaded', () => history++);
  const reply = await controller.ui.input.sendPrompt({ blocks: [{ type: 'resource_link', uri: 'command://compact' }] });
  assert.deepEqual(plainP0(reply), { ok: false, error: { code: 'conversation-compact-error', message: 'Synthetic compaction is unavailable' } });
  assert.equal(history, 0); assert.equal((await controller.requestEntries()).requests.length, 0);
  assert.equal(fixture.calls.some(c => c.method === 'turn.start'), false);
  await api.dispose({ preserveUiState: true });
});

test('P0 text containing a compact prefix plus extra content remains an ordinary user prompt', async () => {
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home',
    rpcHandlers: { 'thread.compact': () => { throw new Error('Ordinary user text must not invoke compaction'); } } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]);
  const values = ['/compact extra', '/总结 extra', 'please /compact'];
  for (let i = 0; i < values.length; i++) {
    await controller.ui.input.sendPrompt({ blocks: [{ type: 'text', text: values[i] }] }, { clientRequestId: 'ordinary-' + i });
    assert.equal(fixture.calls.filter(c => c.method === 'turn.start').at(-1).params.prompt, values[i]);
    api.receive({ kind: 'event', event: { seq: i + 1, type: 'turn.completed', harnessId: 'fake', threadId: 'fake-thread-existing', turnId: 'turn-' + (i + 1),
      payload: { turn: { id: 'turn-' + (i + 1), status: 'completed', completedAt: '2026-10-27T01:20:00.000Z', items: [{ id: 'a-' + i, type: 'text', text: 'fixture complete' }] } } } });
  }
  assert.equal(fixture.calls.some(c => c.method === 'thread.compact'), false);
  assert.equal((await controller.requestEntries()).requests.length, values.length);
  await api.dispose({ preserveUiState: true });
});

test('P0 terminal turns publish idle background flags to both native info and list caches', async () => {
  for (const [type, status, finalState] of [
    ['turn.completed', 'completed', 'idle'], ['turn.failed', 'failed', 'error'], ['turn.cancelled', 'cancelled', 'idle'],
  ]) {
    const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home' });
    const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
    const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]), delivered = [];
    const emit = fixture.context.wb.$bus.emit;
    fixture.context.wb.$bus.emit = (name, payload) => { delivered.push({ name, payload: plainP0(payload) }); emit(name, payload); };
    await controller.sendPrompt([{ type: 'text', text: 'Synthetic terminal flag ' + status }], { clientRequestId: 'native-terminal-' + status });
    assert.equal(controller.info.state, 'working'); assert.equal(controller.info.hasRunningBackgroundTasks, true);
    api.receive({ kind: 'event', event: { seq: 1, type: 'turn.started', harnessId: 'fake', threadId: 'fake-thread-existing', turnId: 'turn-1',
      payload: { turn: { id: 'turn-1', status: 'running' } } } });
    delivered.length = 0;
    api.receive({ kind: 'event', event: { seq: 2, type, harnessId: 'fake', threadId: 'fake-thread-existing', turnId: 'turn-1', payload: {
      turn: { id: 'turn-1', status, completedAt: '2026-10-28T01:02:03.000Z', items: [{ id: 'synthetic-answer', type: 'text', text: status }] },
      ...(status === 'failed' ? { error: { code: 'SYNTHETIC_FAILURE', message: 'Synthetic terminal failure' } } : {}),
    } } });
    assert.equal(controller.info.state, finalState); assert.equal(controller.info.hasRunningBackgroundTasks, false);
    const info = delivered.find(e => e.name === 'wb:conversation:infoChange' && e.payload.conversationId === controller.info.id);
    const list = delivered.find(e => e.name === 'wb:conversations:listChanged' && e.payload.updated.some(i => i.id === controller.info.id));
    assert.ok(info, status + ' must notify the native info cache'); assert.ok(list, status + ' must notify the native list cache');
    assert.equal(info.payload.info.hasRunningBackgroundTasks, false); assert.equal(info.payload.info.state, finalState);
    assert.equal(list.payload.updated.find(i => i.id === controller.info.id).hasRunningBackgroundTasks, false);
    const stateIndex = delivered.findIndex(e => e.name === 'wb:conversation:stateChange');
    assert.ok(stateIndex >= 0 && stateIndex < delivered.indexOf(info), 'Timeline state must settle before publishing terminal info');
    const listed = await fixture.context.wb.conversations.listScope('local', { page: 1, size: 50 });
    assert.equal(listed.items.find(i => i.id === controller.info.id).hasRunningBackgroundTasks, false);
    await api.dispose({ preserveUiState: true });
  }
});

test('P0 a running snapshot settled by an event cannot resurrect busy state through cached lists or terminal refresh', async () => {
  const turn = { id: 'host-running-turn', prompt: 'Synthetic running snapshot', status: 'running', items: [], createdAt: '2026-10-28T01:00:00.000Z' };
  const thread = { ...p0Thread([turn]), status: 'running', activeTurnId: turn.id }, snapshot = p0Snapshot(thread);
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home', runtimeSnapshot: snapshot });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]); assert.equal(controller.info.hasRunningBackgroundTasks, true);
  const finished = { ...turn, status: 'completed', completedAt: '2026-10-28T01:00:03.000Z', items: [{ id: 'answer', type: 'text', text: 'settled' }] };
  api.receive({ kind: 'event', event: { seq: 1, type: 'turn.completed', harnessId: 'fake', threadId: thread.id, turnId: turn.id, payload: { turn: finished } } });
  assert.equal(controller.info.state, 'idle'); assert.equal(controller.info.hasRunningBackgroundTasks, false);
  const cached = await fixture.context.wb.conversations.listScope('local', { page: 1, size: 50 });
  assert.equal(cached.items.find(i => i.id === controller.info.id).hasRunningBackgroundTasks, false);
  snapshot.harnesses[0].threads = [{ ...thread, status: 'idle', activeTurnId: null, turns: [finished] }];
  await api.refresh(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.info.state, 'idle'); assert.equal(controller.info.hasRunningBackgroundTasks, false);
  const refreshed = await fixture.context.wb.conversations.listByIds([controller.info.id]);
  assert.equal(refreshed[0].hasRunningBackgroundTasks, false);
  assert.equal((await controller.requestEntries()).requests[0].state, 'completed');
  await api.dispose({ preserveUiState: true });
});

test('P0 error threads are idle for background-task indicators on hydration and later updates', async () => {
  const failed = { id: 'host-failed-turn', prompt: 'Synthetic failed task', status: 'failed', createdAt: '2026-10-28T01:00:00.000Z',
    completedAt: '2026-10-28T01:00:01.000Z', items: [{ id: 'diagnostic', type: 'text', text: 'Synthetic stopped failure' }] };
  const thread = { ...p0Thread([failed]), status: 'error', activeTurnId: null };
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home', runtimeSnapshot: p0Snapshot(thread) });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]);
  assert.equal(controller.info.state, 'error'); assert.equal(controller.info.hasRunningBackgroundTasks, false);
  await api.refresh(); assert.equal(controller.info.state, 'error'); assert.equal(controller.info.hasRunningBackgroundTasks, false);
  api.receive({ kind: 'event', event: { seq: 1, type: 'thread.updated', harnessId: 'fake', threadId: thread.id, payload: { thread: {
    id: thread.id, status: 'error', activeTurnId: null,
  } } } });
  const listed = await fixture.context.wb.conversations.listScope('local', { page: 1, size: 50 });
  assert.equal(listed.items.find(i => i.id === controller.info.id).hasRunningBackgroundTasks, false);
  assert.equal(fixture.calls.some(c => c.method === 'turn.start'), false);
  await api.dispose({ preserveUiState: true });
});

test('P0 file invalidation emits only bounded absolute paths without file bodies or phantom requests', async () => {
  const thread = p0Thread(p0Turns()), fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home', runtimeSnapshot: p0Snapshot(thread) });
  const windowEvents = [];
  fixture.context.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  fixture.context.dispatchEvent = event => { windowEvents.push({ type: event.type, detail: plainP0(event.detail) }); return true; };
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]), before = plainP0((await controller.requestEntries()).requests.map(r => r.id));
  let artifacts = 0; controller.on('artifactUpdate', () => artifacts++);
  const update = { kind: 'event', event: { seq: 1, type: 'files.updated', harnessId: 'fake', threadId: thread.id, payload: {
    paths: ['/synthetic/workspace/report.md', 'relative.md', 'file:///synthetic/file.md', 'https://invalid.example/a',
      '/synthetic/line\nbreak', '/synthetic/tab\tname', '/synthetic/nul\0name', '/synthetic/del\x7fname',
      '/' + 'x'.repeat(8192), 42, null, { path: '/must-not-be-read' }, '/synthetic/workspace/第二份.pdf'],
    content: 'DO_NOT_FORWARD_CONTENT', beforeText: 'DO_NOT_FORWARD_CONTENT', afterText: 'DO_NOT_FORWARD_CONTENT', body: 'DO_NOT_FORWARD_CONTENT',
  } } };
  api.receive(update); api.receive(update);
  assert.equal(artifacts, 1); assert.deepEqual(windowEvents, [{ type: 'workbuddy-pi:files-changed', detail: {
    paths: ['/synthetic/workspace/report.md', '/synthetic/workspace/第二份.pdf'], files: [], invalidateAll: false,
  } }]);
  assert.doesNotMatch(JSON.stringify(windowEvents), /DO_NOT_FORWARD_CONTENT|must-not-be-read/);
  assert.equal(controller.info.state, 'idle'); assert.deepEqual(plainP0((await controller.requestEntries()).requests.map(r => r.id)), before);
  assert.equal(fixture.calls.some(c => c.method === 'turn.start'), false);
  await api.dispose({ preserveUiState: true });
});

test('P0 invalidateAll is a strict metadata-only fallback and invalid paths alone never trigger preview reads', async () => {
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home' }), windowEvents = [];
  fixture.context.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  fixture.context.dispatchEvent = event => { windowEvents.push({ type: event.type, detail: plainP0(event.detail) }); return true; };
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.get(api.conversationIds[0]); let artifacts = 0;
  controller.on('artifactUpdate', () => artifacts++);
  const notify = (seq, payload) => api.receive({ kind: 'event', event: { seq, type: 'files.updated', harnessId: 'fake', threadId: 'fake-thread-existing', payload } });
  notify(1, { paths: ['relative', null, '/bad\nname'] }); assert.equal(windowEvents.length, 0);
  notify(2, { paths: { malicious: '/must-not-be-read' }, invalidateAll: 'true' }); assert.equal(windowEvents.length, 0);
  notify(3, { paths: ['relative', null], invalidateAll: true, content: 'DO_NOT_FORWARD_CONTENT', fileData: 'DO_NOT_FORWARD_CONTENT' });
  assert.deepEqual(windowEvents, [{ type: 'workbuddy-pi:files-changed', detail: { paths: [], files: [], invalidateAll: true } }]);
  assert.deepEqual(Object.keys(windowEvents[0].detail).sort(), ['files', 'invalidateAll', 'paths']); assert.equal(artifacts, 3);
  assert.equal((await controller.requestEntries()).requests.length, 0);
  assert.equal(fixture.calls.some(c => ['turn.start', 'thread.files'].includes(c.method)), false, 'The event bridge itself must not read files or start a turn');
  await api.dispose({ preserveUiState: true });
});

test('P0 file invalidation enforces 2048 paths and the 8192-character path boundary', async () => {
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home' }), events = [];
  fixture.context.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  fixture.context.dispatchEvent = event => { events.push({ type: event.type, detail: plainP0(event.detail) }); return true; };
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const paths = Array.from({ length: 2050 }, (_, i) => '/synthetic/' + i);
  api.receive({ kind: 'event', event: { seq: 1, type: 'files.updated', harnessId: 'fake', threadId: 'fake-thread-existing', payload: { paths } } });
  assert.equal(events[0].detail.paths.length, 2048); assert.equal(events[0].detail.paths[0], paths[0]); assert.equal(events[0].detail.paths.at(-1), paths[2047]);
  const boundary = '/' + 'z'.repeat(8191);
  api.receive({ kind: 'event', event: { seq: 2, type: 'files.updated', harnessId: 'fake', threadId: 'fake-thread-existing', payload: { paths: [boundary, boundary + 'z'] } } });
  assert.deepEqual(events[1].detail.paths, [boundary]); assert.equal(events[1].detail.invalidateAll, false);
  await api.dispose({ preserveUiState: true });
});

function previewEventWindow(fixture, onDispatch = () => {}) {
  const listeners = new Map(), removed = [];
  fixture.context.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  fixture.context.addEventListener = (type, listener) => { const values = listeners.get(type) ?? new Set(); values.add(listener); listeners.set(type, values); };
  fixture.context.removeEventListener = (type, listener) => { listeners.get(type)?.delete(listener); removed.push({ type, listener }); };
  fixture.context.dispatchEvent = event => { onDispatch(event); for (const listener of [...listeners.get(event.type) ?? []]) listener(event); return true; };
  return { listeners, removed, dispatch: detail => fixture.context.dispatchEvent(new fixture.context.CustomEvent('workbuddy-pi:preview-status', { detail })) };
}

test('P0 preview file sizes are metadata-only, safe integers or null, and restricted to the filtered event paths', async () => {
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home' }), events = [];
  previewEventWindow(fixture, event => { if (event.type === 'workbuddy-pi:files-changed') events.push(plainP0(event.detail)); });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const paths = ['/synthetic/text.md', '/synthetic/deleted.pdf', '/synthetic/empty.txt', '/synthetic/max.bin',
    '/synthetic/negative.txt', '/synthetic/fractional.txt', '/synthetic/unsafe-number.txt', '/synthetic/string-size.txt', '/synthetic/no-size.txt'];
  api.receive({ kind: 'event', event: { seq: 1, type: 'files.updated', harnessId: 'fake', threadId: 'fake-thread-existing', payload: {
    paths: [...paths, 'relative.txt', '/bad\nname'],
    files: [
      { path: paths[0], size: 123, text: 'DO_NOT_FORWARD_CONTENT', fileName: 'DO_NOT_FORWARD_CONTENT' },
      { path: paths[1], size: null, content: 'DO_NOT_FORWARD_CONTENT' }, { path: paths[2], size: 0 },
      { path: paths[3], size: Number.MAX_SAFE_INTEGER }, { path: paths[4], size: -1 }, { path: paths[5], size: 1.5 },
      { path: paths[6], size: Number.MAX_SAFE_INTEGER + 1 }, { path: paths[7], size: '100' }, { path: paths[8] },
      { path: '/not-in-filtered-paths', size: 1 }, { path: 'relative.txt', size: 2 }, { path: '/bad\nname', size: 3 }, null, false,
    ], body: 'DO_NOT_FORWARD_CONTENT',
  } } });
  assert.equal(events.length, 1); assert.deepEqual(events[0].paths, paths);
  assert.deepEqual(events[0].files, [
    { path: paths[0], size: 123 }, { path: paths[1], size: null }, { path: paths[2], size: 0 }, { path: paths[3], size: Number.MAX_SAFE_INTEGER },
  ]);
  assert.ok(events[0].files.every(file => Object.keys(file).sort().join(',') === 'path,size'));
  assert.doesNotMatch(JSON.stringify(events), /DO_NOT_FORWARD_CONTENT|not-in-filtered-paths/);
  const notes = fixture.calls.filter(call => call.method === 'runtime.preview.note'); assert.equal(notes.length, 1); assert.deepEqual(notes[0].params, { reason: 'event-sent' });
  assert.equal((await (await fixture.context.wb.conversations.get(api.conversationIds[0])).requestEntries()).requests.length, 0);
  await api.dispose({ preserveUiState: true });
});

test('P0 preview diagnostics report only allowlisted reasons and event-sent precedes file dispatch', async () => {
  const timeline = [], fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home', rpcHandlers: {
    'runtime.preview.note': params => { timeline.push('note:' + params.reason); return { noted: true }; },
  } });
  const window = previewEventWindow(fixture, event => { if (event.type === 'workbuddy-pi:files-changed') timeline.push('dispatch:files'); });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const reasons = ['mounted', 'event', 'matched', 'dirty-skipped', 'unknown-skipped', 'stale-skipped', 'reloaded', 'read-failed', 'size-skipped',
    'nonlocal-skipped', 'extension-skipped', 'session-skipped', 'content-skipped', 'reader-skipped', 'probe-skipped', 'url-skipped', 'ref-skipped'];
  for (const reason of reasons) window.dispatch({ reason, content: 'DO_NOT_REPORT_BODY', paths: ['/DO_NOT_REPORT_PATH'], nonce: 'DO_NOT_REPORT_NONCE', secret: 'DO_NOT_REPORT_SECRET' });
  for (const reason of ['event-sent', 'unknown-reason', '', null, 1, { content: 'DO_NOT_REPORT_BODY' }]) window.dispatch({ reason, content: 'DO_NOT_REPORT_BODY', secret: 'DO_NOT_REPORT_SECRET' });
  window.dispatch(undefined); window.dispatch(null);
  const notes = fixture.calls.filter(call => call.method === 'runtime.preview.note');
  assert.deepEqual(notes.map(call => call.params), reasons.map(reason => ({ reason })));
  assert.doesNotMatch(JSON.stringify(notes), /DO_NOT_REPORT/);
  const count = notes.length;
  api.receive({ kind: 'event', event: { seq: 1, type: 'files.updated', harnessId: 'fake', threadId: 'fake-thread-existing', payload: {
    paths: ['/synthetic/event.txt'], files: [{ path: '/synthetic/event.txt', size: 5 }],
  } } });
  assert.deepEqual(timeline.slice(-2), ['note:event-sent', 'dispatch:files']);
  assert.equal(fixture.calls.filter(call => call.method === 'runtime.preview.note').length, count + 1);
  assert.equal(fixture.calls.some(call => ['turn.start', 'thread.files'].includes(call.method)), false);
  await api.dispose({ preserveUiState: true });
});

test('P0 stale renderer ownership and disposal silence preview diagnostics and remove the status listener', async () => {
  const fixture = createNativeRendererFixture({ existingExternalThread: true, initialPath: '/home' });
  const window = previewEventWindow(fixture), api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const listeners = window.listeners.get('workbuddy-pi:preview-status'); assert.equal(listeners.size, 1);
  const stale = [...listeners][0], notes = () => fixture.calls.filter(call => call.method === 'runtime.preview.note');
  window.dispatch({ reason: 'mounted' }); assert.equal(notes().length, 1);
  // Replacing the nonce-bound global owner makes the old callback inert even
  // before removal. Incoming event data is never treated as an authority token.
  Object.defineProperty(fixture.context, '__testGlobal', { configurable: true, value: { bindingName: '__differentNonceBoundOwner' } });
  window.dispatch({ reason: 'reader-skipped', content: 'DO_NOT_REPORT_BODY', secret: 'DO_NOT_REPORT_SECRET' }); stale({ detail: { reason: 'probe-skipped' } });
  assert.equal(notes().length, 1);
  Object.defineProperty(fixture.context, '__testGlobal', { configurable: true, value: api }); window.dispatch({ reason: 'event' }); assert.equal(notes().length, 2);
  await api.dispose({ preserveUiState: true });
  assert.equal(listeners.size, 0); assert.ok(window.removed.some(entry => entry.type === 'workbuddy-pi:preview-status' && entry.listener === stale));
  window.dispatch({ reason: 'mounted' }); stale({ detail: { reason: 'ref-skipped', path: '/DO_NOT_REPORT_PATH', secret: 'DO_NOT_REPORT_SECRET' } });
  assert.equal(notes().length, 2); assert.ok(notes().every(call => Object.keys(call.params).join(',') === 'reason'));
});

test('P0 actual renderer info stays local through native binding on creation, hydration, updates and terminal refresh', async t => {
  for (const restored of [false, true]) {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-renderer-native-binding-')));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const saved = { ...p0Thread(p0Turns()), title: 'Synthetic restored local task', cwd, workspaceAutoGenerated: false };
    let authoritative = restored ? saved : undefined;
    const fixture = createNativeRendererFixture({ initialPath: '/home', existingExternalThread: restored, rpcHandlers: {
      'runtime.snapshot': (_params, { thread }) => ({ defaultHarnessId: 'fake', harnesses: [{ id: 'fake', label: 'Fake',
        threads: (authoritative ?? thread) ? [authoritative ?? thread] : [] }], recentEvents: [] }),
    } });
    const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
    const controller = restored ? await fixture.context.wb.conversations.get(api.conversationIds[0])
      : await fixture.context.wb.conversations.create({ title: 'Synthetic new local task', cwd });
    const identity = controller.info.id;
    const assertLocalNativeBinding = () => {
      const info = controller.info, before = JSON.stringify(info), options = { scopeKey: info.id, input: controller.ui.input, adapterEnvironment: 'local' };
      const native = replayNativeArtifactBindingFromInfo(info, options);
      assert.equal(native.environmentType, 'local', 'Native binding must not mistake the local Pi identity for a cloud runtime');
      assert.equal(replayNativeFinalEnvironment(native), 'local');
      const sidebar = replayNativeSidebarConversation(info);
      assert.equal(sidebar.id, identity); assert.equal(sidebar.cwd, cwd); assert.equal(sidebar.runtimeId, undefined);
      const bridge = replayNativeArtifactBridge(sidebar, { adapterEnvironment: 'local', input: controller.ui.input });
      assert.equal(bridge.environmentType, 'local'); assert.equal(bridge.scopeKey, identity);
      assert.equal(bridge.workspaceCwd, cwd); assert.equal(bridge.origin.taskId, identity);
      assert.equal(native.origin.taskId, identity); assert.equal(native.origin.taskName, info.title);
      assert.equal(native.scopeKey, identity); assert.equal(native.workspaceCwd, cwd); assert.equal(native.input, controller.ui.input);
      assert.equal(info.transport, 'local'); assert.equal(info.cwd, cwd); assert.equal(info.space.cwd, cwd); assert.equal(info.space.type, 'local');
      assert.equal(Object.hasOwn(info, 'runtimeId'), false, 'A local Pi ID belongs in info.id, not a hosted-runtime field');
      assert.equal(info.id, identity); assert.equal(JSON.stringify(info), before, 'The original binding must not rewrite the supplied renderer info');
    };
    assertLocalNativeBinding();
    const rawId = restored ? saved.id : 'fake-thread-1';
    api.receive({ kind: 'event', event: { seq: 1, type: 'thread.updated', harnessId: 'fake', threadId: rawId, payload: { thread: {
      id: rawId, cwd, title: 'Synthetic updated local task', status: 'running', activeTurnId: 'host-binding-final', runtimeId: 'legacy-host-metadata',
    } } } });
    assertLocalNativeBinding();
    const terminal = { id: 'host-binding-final', threadId: rawId, prompt: 'Synthetic local lifecycle', status: 'completed',
      createdAt: '2026-10-28T01:00:00.000Z', completedAt: '2026-10-28T01:00:02.000Z', items: [{ id: 'answer', type: 'text', text: 'local lifecycle complete' }] };
    api.receive({ kind: 'event', event: { seq: 2, type: 'turn.completed', harnessId: 'fake', threadId: rawId, turnId: terminal.id, payload: { turn: terminal } } });
    assertLocalNativeBinding();
    authoritative = { ...saved, id: rawId, cwd, title: 'Synthetic refreshed local task', status: 'idle', activeTurnId: null,
      runtimeId: 'legacy-host-metadata', turns: [...(restored ? saved.turns : []), terminal] };
    await api.refresh(); assertLocalNativeBinding(); assert.equal(controller.info.state, 'idle');
    await api.dispose({ preserveUiState: true });
  }
});

test('P0 native binding still promotes legacy runtime identity, real cloud, project panels and cloud workspace paths', async t => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-renderer-native-controls-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const fixture = createNativeRendererFixture({ initialPath: '/home' }), api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ title: 'Synthetic native environment controls', cwd });
  const info = controller.info;
  const legacy = replayNativeArtifactBindingFromInfo({ ...info, runtimeId: info.id });
  assert.equal(legacy.environmentType, 'cloud', 'Negative control must reproduce the old renderer bug with the same real info');
  assert.equal(replayNativeFinalEnvironment(legacy), 'cloud');
  for (const cloudInfo of [{ ...info, transport: 'cloud' }, { ...info, space: { ...info.space, cwd: '/workspace' } },
    { ...info, space: { ...info.space, cwd: '/workspace/p0-output' } }]) {
    const native = replayNativeArtifactBindingFromInfo(cloudInfo); assert.equal(native.environmentType, 'cloud'); assert.equal(replayNativeFinalEnvironment(native), 'cloud');
  }
  assert.equal(replayNativeProjectDetailPanelOptions().forceCloudEnvironment, true, 'The original project component decides this policy');
  for (const options of [{ projectDetailPage: true }, { projectSandbox: 'synthetic-project-sandbox', routeProjectId: 'synthetic-project' }, { forceCloud: true }]) {
    const native = replayNativeArtifactBindingFromInfo(info, options);
    assert.equal(native.environmentType, 'cloud'); assert.equal(replayNativeFinalEnvironment(native, options), 'cloud');
  }
  assert.equal(replayNativeArtifactBindingFromInfo({ ...info, space: { ...info.space, cwd: '/workspace-local' } }).environmentType, 'local', 'An ordinary local directory prefix is not a hosted workspace');
  assert.equal(controller.info.id, info.id); assert.equal(controller.info.cwd, cwd); assert.equal(controller.info.transport, 'local');
  assert.equal(fixture.calls.some(call => call.method === 'turn.start'), false);
  await api.dispose({ preserveUiState: true });
});

test('native Home scene crosses the actual renderer into turn-input as context with only bounded scene metadata', async t => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-renderer-scene-'))); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const native = createNativeInputReplay(), blocks = native.homeBlocks([{ type: 'text', text: 'Synthetic scene classification only; no real business calls.' }]);
  blocks[0]._meta.rawMetadata = { content: 'DO_NOT_FORWARD_RAW_METADATA' }; blocks[0]._meta.accessToken = 'DO_NOT_FORWARD_RAW_METADATA';
  blocks[0].data = 'DO_NOT_FORWARD_INLINE_DATA';
  let prepared;
  const fixture = createNativeRendererFixture({ initialPath: '/home', rpcHandlers: { 'turn.start': async params => {
    prepared = await prepareTurnInput({ ...params, cwd }); return { turn: { id: 'scene-fixture-turn', threadId: params.threadId } };
  } } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd });
  await controller.ui.input.sendPrompt({ blocks }, { clientRequestId: 'native-scene-fixture' });
  const sent = fixture.calls.find(call => call.method === 'turn.start').params, scene = sent.promptContentBlocks[0];
  assert.equal(scene.type, 'resource_link'); assert.equal(scene.uri, 'scene://122844');
  assert.deepEqual(scene._meta, { type: 'scene', mentionType: 'scene', sceneId: '122844', displayText: '企业微信' });
  assert.deepEqual(prepared.scenes, [{ id: '122844', name: '企业微信' }]); assert.deepEqual(prepared.attachments, []); assert.deepEqual(prepared.images, []);
  assert.ok(prepared.message.includes('Synthetic scene classification only')); assert.ok(prepared.message.includes('不改变已授权工具'));
  assert.doesNotMatch(JSON.stringify(sent), /DO_NOT_FORWARD|<svg|inline-svg|aria-hidden/);
  assert.deepEqual(sent.skills, []); assert.deepEqual(fixture.connectorCalls, []);
  await api.dispose({ preserveUiState: true });
});

test('a native command-style skill still resolves its installed catalog beside a Home scene', async t => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-renderer-scene-skill-'))); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const skillDir = path.join(cwd, 'installed-skill'); fs.mkdirSync(skillDir, { mode: 0o700 }); const skillPath = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(skillPath, '# Synthetic installed skill\nSCENE_SKILL_LOCAL_ONLY\n', { mode: 0o600 });
  const native = createNativeInputReplay(), skill = native.skillInsert({ id: 'scene-skill-fixture-id', name: 'scene-skill-fixture' });
  assert.ok(skill.uri.startsWith('command://')); assert.equal(skill._meta.mentionType, 'skill');
  const blocks = native.homeBlocks([skill]);
  let prepared, context, catalogCalls = 0;
  const fixture = createNativeRendererFixture({ initialPath: '/home', rpcHandlers: { 'turn.start': async params => {
    prepared = await prepareTurnInput({ ...params, cwd }); context = await resolveNativeContext({ skills: params.skills });
    return { turn: { id: 'scene-skill-fixture-turn', threadId: params.threadId } };
  } } });
  fixture.context.__GENIE_DEFAULT_APP_PROVIDERS__.facades = { personalSkills: { async list() { catalogCalls++; return { results: [
    { skillId: 'scene-skill-fixture-id', name: 'scene-skill-fixture', filePath: skillPath, userInvocable: true },
  ] }; } } };
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd }); await controller.ui.input.sendPrompt({ blocks });
  const sent = fixture.calls.find(call => call.method === 'turn.start').params;
  assert.equal(catalogCalls, 1); assert.equal(sent.skills.length, 1); assert.equal(sent.skills[0].filePath, skillPath);
  assert.equal(sent.promptContentBlocks.length, 2); assert.ok(sent.promptContentBlocks.every(block => !String(block.uri ?? '').startsWith('command://')));
  assert.equal(sent.prompt, '请使用所选技能完成任务。'); assert.ok(prepared.message.includes('请使用所选技能完成任务。'));
  assert.deepEqual(prepared.scenes, [{ id: '122844', name: '企业微信' }]); assert.deepEqual(prepared.attachments, []);
  assert.ok(context.message.includes('SCENE_SKILL_LOCAL_ONLY')); assert.equal(context.skills[0].filePath, skillPath);
  assert.deepEqual(fixture.connectorCalls, []);
  await api.dispose({ preserveUiState: true });
});

test('native scene routing cannot convert true remote files, host paths, traversal or mixed skill claims into authorized input', async t => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-renderer-scene-reject-'))); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const native = createNativeInputReplay(); let catalogCalls = 0, prepared = 0;
  const fixture = createNativeRendererFixture({ initialPath: '/home', rpcHandlers: { 'turn.start': async params => {
    await prepareTurnInput({ ...params, cwd }); prepared++; return { turn: { id: 'must-not-start', threadId: params.threadId } };
  } } });
  fixture.context.__GENIE_DEFAULT_APP_PROVIDERS__.facades = { personalSkills: { async list() { catalogCalls++; return { results: [] }; } } };
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd });
  const forged = JSON.parse(JSON.stringify(native.homeSceneBlock())); forged.uri = 'command://forged-skill';
  forged._meta.mentionType = 'skill'; forged._meta.skillId = 'forged-skill';
  for (const [block, code] of [
    [{ type: 'resource_link', uri: 'https://example.invalid/synthetic.txt', _meta: { type: 'file', sceneId: '122844', displayText: 'DO_NOT_FORWARD_NONSCENE', icon: '<svg/>' } }, 'ATTACHMENT_REMOTE_UNSUPPORTED'],
    [{ type: 'resource_link', uri: 'file://remote-host/etc/passwd' }, 'ATTACHMENT_PATH_INVALID'],
    [{ type: 'resource_link', uri: 'file:///synthetic/../secret.txt' }, 'ATTACHMENT_PATH_INVALID'],
    [forged, 'NATIVE_SCENE_INVALID'],
  ]) {
    await assert.rejects(controller.ui.input.sendPrompt({ blocks: [block, { type: 'text', text: 'Synthetic rejection only.' }] }), error => error.code === code);
  }
  const first = fixture.calls.find(call => call.method === 'turn.start').params.promptContentBlocks[0];
  assert.equal(first._meta.sceneId, undefined); assert.equal(first._meta.displayText, undefined); assert.equal(first._meta.icon, undefined);
  assert.equal(prepared, 0); assert.equal(catalogCalls, 0, 'A block claiming scene must not be reinterpreted as an installed skill');
  assert.deepEqual(fixture.connectorCalls, []); assert.equal(fixture.calls.some(call => call.method === 'interaction.respond'), false);
  await api.dispose({ preserveUiState: true });
});

test('native connector links retain only the controlled kind and explicit selections still win over link errors', async t => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-renderer-connector-kind-'))); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const native = createNativeInputReplay(), url = 'https://example.invalid/synthetic-document', normalized = [];
  const provider = { id: 'DO_NOT_FORWARD_PROVIDER', connectorId: 'DO_NOT_FORWARD_CONNECTOR', authorization: 'required', getInitialDisplayText: () => 'Synthetic connector link',
    blockMetadata: { auth: 'DO_NOT_FORWARD_AUTH', token: 'DO_NOT_FORWARD_TOKEN', provider: 'DO_NOT_FORWARD_PROVIDER', rawValue: 'DO_NOT_FORWARD_RAW' } };
  const fixture = createNativeRendererFixture({ initialPath: '/home', rpcHandlers: { 'turn.start': async params => {
    normalized.push(await prepareTurnInput({ ...params, cwd })); return { turn: { id: 'synthetic-selected-text', threadId: params.threadId } };
  } } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd });
  for (const [authorized, kind, code] of [[false, 'connector-link-pending-auth', 'NATIVE_CONNECTOR_LINK_AUTH_REQUIRED'],
    [true, 'connector-link-resolved', 'NATIVE_CONNECTOR_LINK_UNSUPPORTED']]) {
    const block = native.connectorLink({ rawUrl: url }, provider, authorized);
    await assert.rejects(controller.ui.input.sendPrompt({ blocks: [block, { type: 'text', text: 'Synthetic typed-link rejection only.' }] }), error => error.code === code);
    const sent = fixture.calls.filter(call => call.method === 'turn.start').at(-1).params;
    assert.equal(sent.promptContentBlocks[0].uri, url, 'The public synthetic URI remains an input address, not an extra metadata value');
    assert.deepEqual(sent.promptContentBlocks[0]._meta, { kind });
    assert.doesNotMatch(JSON.stringify(sent), /DO_NOT_FORWARD|rawUrl|providerId|connectorId|linkResolveState/);
  }
  await assert.rejects(controller.ui.input.sendPrompt({ blocks: [{ type: 'resource_link', uri: url, _meta: { kind: 'unknown-kind', rawUrl: 'DO_NOT_FORWARD_RAW', auth: 'DO_NOT_FORWARD_AUTH' } },
    { type: 'text', text: 'Synthetic plain HTTPS rejection.' }] }), error => error.code === 'ATTACHMENT_REMOTE_UNSUPPORTED');
  const unknown = fixture.calls.filter(call => call.method === 'turn.start').at(-1).params;
  assert.deepEqual(unknown.promptContentBlocks[0]._meta, {}); assert.doesNotMatch(JSON.stringify(unknown), /unknown-kind|DO_NOT_FORWARD/);
  const selection = native.connectorLink({ rawUrl: url }, provider, false);
  Object.assign(selection._meta, { selectionQuote: true, selectedText: 'SYNTHETIC_EXPLICIT_LINK_SELECTION' });
  await controller.ui.input.sendPrompt({ blocks: [selection] });
  assert.equal(normalized.length, 1); assert.equal(normalized[0].attachments[0].kind, 'selection');
  assert.ok(normalized[0].message.includes('SYNTHETIC_EXPLICIT_LINK_SELECTION'));
  assert.deepEqual(fixture.connectorCalls, []); assert.equal(fixture.calls.some(call => call.method === 'interaction.respond'), false);
  await api.dispose({ preserveUiState: true });
});

test('native long paste crosses the actual renderer and Host preparer with its complete ordered Unicode body', async t => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-renderer-long-paste-'))); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const native = createNativeInputReplay(), pasted = native.paste({ text: 'LONG_PASTE_FIRST\r\n' + 'e\u0301'.repeat(3001) + '\r\nLONG_PASTE_LAST' });
  const chip = pasted.blocks[0], body = chip._meta.fullText;
  chip._meta.rawUrl = 'DO_NOT_FORWARD_RAW'; chip._meta.token = 'DO_NOT_FORWARD_TOKEN'; chip._meta.provider = 'DO_NOT_FORWARD_PROVIDER';
  chip._meta.icon = '<svg>DO_NOT_FORWARD_ICON</svg>'; chip.rawMetadata = { content: 'DO_NOT_FORWARD_RAW' };
  let prepared;
  const fixture = createNativeRendererFixture({ initialPath: '/home', rpcHandlers: { 'turn.start': async params => {
    prepared = await prepareTurnInput({ ...params, cwd }); return { turn: { id: 'long-paste-fixture', threadId: params.threadId } };
  } } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd });
  await controller.ui.input.sendPrompt({ blocks: [{ type: 'text', text: 'BEFORE|' }, ...pasted.blocks, { type: 'text', text: '|AFTER' }] });
  const sent = fixture.calls.find(call => call.method === 'turn.start').params, forwarded = sent.promptContentBlocks[1];
  assert.equal(forwarded.type, 'resource_link'); assert.equal(forwarded.uri, chip.uri);
  assert.deepEqual(forwarded._meta, { mentionType: 'long-text', fullText: body, displayText: chip._meta.displayText });
  assert.equal(prepared.message, 'BEFORE|' + body + '|AFTER'); assert.deepEqual(prepared.attachments, []); assert.deepEqual(prepared.scenes, []);
  assert.ok(prepared.message.includes('LONG_PASTE_FIRST')); assert.ok(prepared.message.includes('LONG_PASTE_LAST'));
  assert.ok(!prepared.message.includes('longtext://')); assert.doesNotMatch(JSON.stringify(sent), /DO_NOT_FORWARD|<svg/);
  assert.deepEqual(fixture.connectorCalls, []);
  await api.dispose({ preserveUiState: true });
});

test('a Home scene, long-text task and native command skill coexist without substituting the skill default prompt', async t => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-renderer-long-scene-skill-'))); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const skillDir = path.join(cwd, 'installed'); fs.mkdirSync(skillDir, { mode: 0o700 }); const skillPath = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(skillPath, '# Synthetic skill\nLONG_TEXT_SKILL_ONLY\n', { mode: 0o600 });
  const native = createNativeInputReplay(), pasted = native.paste({ text: 'COEXIST_FIRST|' + '文'.repeat(3001) + '|COEXIST_LAST' });
  const skill = native.skillInsert({ id: 'long-text-skill-id', name: 'long-text-skill' }), blocks = native.homeBlocks([...pasted.blocks, skill]);
  let prepared, context;
  const fixture = createNativeRendererFixture({ initialPath: '/home', rpcHandlers: { 'turn.start': async params => {
    prepared = await prepareTurnInput({ ...params, cwd }); context = await resolveNativeContext({ skills: params.skills });
    return { turn: { id: 'long-scene-skill', threadId: params.threadId } };
  } } });
  fixture.context.__GENIE_DEFAULT_APP_PROVIDERS__.facades = { personalSkills: { async list() { return { results: [
    { skillId: 'long-text-skill-id', name: 'long-text-skill', filePath: skillPath, userInvocable: true },
  ] }; } } };
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd }); await controller.ui.input.sendPrompt({ blocks });
  const sent = fixture.calls.find(call => call.method === 'turn.start').params;
  assert.equal(sent.skills.length, 1); assert.equal(sent.skills[0].filePath, skillPath); assert.equal(sent.promptContentBlocks.length, 2);
  assert.ok(prepared.message.startsWith(pasted.blocks[0]._meta.fullText)); assert.ok(!prepared.message.includes('请使用所选技能完成任务。'));
  assert.deepEqual(prepared.scenes, [{ id: '122844', name: '企业微信' }]); assert.deepEqual(prepared.attachments, []);
  assert.ok(context.message.includes('LONG_TEXT_SKILL_ONLY')); assert.deepEqual(fixture.connectorCalls, []);
  await api.dispose({ preserveUiState: true });
});

test('long-text routing rejects remote and mixed skill claims and never forwards non-long-text fullText metadata', async t => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-renderer-long-reject-'))); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const native = createNativeInputReplay(); let prepared = 0, catalogCalls = 0;
  const fixture = createNativeRendererFixture({ initialPath: '/home', rpcHandlers: { 'turn.start': async params => {
    await prepareTurnInput({ ...params, cwd }); prepared++; return { turn: { id: 'must-not-start', threadId: params.threadId } };
  } } });
  fixture.context.__GENIE_DEFAULT_APP_PROVIDERS__.facades = { personalSkills: { async list() { catalogCalls++; return { results: [] }; } } };
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd });
  const valid = native.paste({ text: 'LONG_FIRST|' + '文'.repeat(3001) + '|LONG_LAST' }).blocks[0];
  const remote = JSON.parse(JSON.stringify(valid)); remote.uri = 'https://example.invalid/forged-long';
  const skill = JSON.parse(JSON.stringify(valid)); skill.uri = 'command://fake-skill'; skill._meta.type = 'skill'; skill._meta.skillId = 'fake-skill';
  for (const block of [remote, skill]) await assert.rejects(controller.ui.input.sendPrompt({ blocks: [block] }), error => error.code === 'NATIVE_LONG_TEXT_INVALID');
  await assert.rejects(controller.ui.input.sendPrompt({ blocks: [{ type: 'resource_link', uri: 'https://example.invalid/not-long',
    _meta: { fullText: 'DO_NOT_FORWARD_UNSELECTED', displayText: 'DO_NOT_FORWARD_UNSELECTED' } }] }), error => error.code === 'ATTACHMENT_REMOTE_UNSUPPORTED');
  const ordinary = fixture.calls.filter(call => call.method === 'turn.start').at(-1).params;
  assert.equal(ordinary.promptContentBlocks[0]._meta.fullText, undefined); assert.equal(ordinary.promptContentBlocks[0]._meta.displayText, undefined);
  assert.equal(prepared, 0); assert.equal(catalogCalls, 0); assert.deepEqual(fixture.connectorCalls, []);
  await api.dispose({ preserveUiState: true });
});

function packagedRendererExpert(selection = {}) {
  const root = '/synthetic/installed-experts/senior-developer';
  return {
    ...selection, name: 'Synthetic package expert', prompt: 'SYNTHETIC_AGENT_PERSONA', localPath: root,
    package: { version: '1.2.3', root, manifestPath: `${root}/plugin.json`, manifestSha256: 'a'.repeat(64),
      agentPath: `${root}/agents/senior-developer.md`, agentSha256: 'b'.repeat(64),
      skills: Array.from({ length: 12 }, (_, index) => ({ id: `skill-${index}`, name: `Skill ${index}`,
        filePath: `${root}/skills/skill-${index}/SKILL.md`, sha256: 'c'.repeat(64), catalogOnly: true })) },
  };
}

test('installed experts preserve complete selected identity before thread creation without querying a cloud directory', async () => {
  const selection = { id: 'SeniorDeveloper', marketExpertId: 'ex_SYNTHETIC', source: 'builtin', enterpriseId: 'synthetic-enterprise',
    locale: 'en', runtimeIdentity: 'opaque-native-identity:DO-NOT-PARSE', marketplace: 'experts',
    pluginName: 'senior-developer', plugin: 'legacy-plugin-alias', pluginRegisteredName: 'synthetic-registered-plugin',
    agentName: 'senior-developer', localPath: '/synthetic/stale-ui-package-path', expertRootDir: '/synthetic/stale-ui-package-path', expertType: 'agent',
    name: 'Selected expert', displayName: { zh: '合成专家', en: 'Selected expert' }, version: '1.2.2', updatedAt: '2026-10-28',
    defaultInitPrompt: 'SYNTHETIC_QUICK_PROMPT' };
  let cloudQueries = 0;
  const fixture = createNativeRendererFixture({ initialPath: '/home', rpcHandlers: {
    'expert.resolve'(params) {
      assert.deepEqual(plainP0(params.expert), selection);
      return { expert: { ...packagedRendererExpert(params.expert), expertRootDir: '/synthetic/installed-experts/senior-developer', version: '1.2.3' } };
    },
  } });
  fixture.context.wb.experts = { async get() { cloudQueries++; throw new Error('must use installed package'); },
    custom: { async get() { cloudQueries++; throw new Error('must not query custom'); } } };
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd: '', expert: { ...selection,
    rawSkillBody: 'RAW_SKILL_BODY_MUST_NOT_FORWARD', script: 'SYNTHETIC_NOT_EXECUTABLE', arbitraryMetadata: { token: 'SYNTHETIC_NOT_A_TOKEN' } } });
  const methods = fixture.calls.filter(call => ['expert.resolve', 'thread.create', 'thread.context.set'].includes(call.method)).map(call => call.method);
  assert.deepEqual(methods, ['expert.resolve', 'thread.create', 'thread.context.set']);
  const bound = fixture.calls.find(call => call.method === 'thread.context.set').params.expert;
  for (const [key, value] of Object.entries(selection)) {
    if (!['name', 'displayName', 'localPath', 'expertRootDir', 'version'].includes(key)) assert.deepEqual(plainP0(bound[key]), value, key);
  }
  assert.equal(bound.localPath, '/synthetic/installed-experts/senior-developer');
  assert.equal(bound.expertRootDir, bound.localPath);
  assert.equal(bound.version, '1.2.3');
  assert.equal(bound.prompt, 'SYNTHETIC_AGENT_PERSONA');
  assert.equal(bound.package.skills.length, 12, 'associated skill catalog must not be truncated to selected-skill limits');
  assert.ok(bound.package.skills.every(skill => skill.catalogOnly && !Object.hasOwn(skill, 'content')));
  assert.equal(JSON.stringify(fixture.calls.filter(call => ['expert.resolve', 'thread.context.set'].includes(call.method))).includes('RAW_SKILL_BODY_MUST_NOT_FORWARD'), false);
  assert.equal(cloudQueries, 0);
  assert.equal(controller.configManager.expert.runtimeIdentity, selection.runtimeIdentity);
  await controller.sendPrompt([{ type: 'text', text: 'SYNTHETIC_EXPERT_TASK' }]);
  assert.equal(fixture.calls.filter(call => call.method === 'turn.start').length, 1);
  assert.deepEqual(fixture.connectorCalls, []);
  await api.dispose({ preserveUiState: true });
});

test('native create fields retain opaque identity and a bare installed alias resolves before any thread exists', async () => {
  let selected;
  const fixture = createNativeRendererFixture({ initialPath: '/home', rpcHandlers: {
    'expert.resolve'({ expert }) { selected = plainP0(expert); return { expert: packagedRendererExpert(expert) }; },
  } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const opaque = 'expert-v2:{"native":"SYNTHETIC_IDENTITY_ONLY"}';
  const controller = await fixture.context.wb.conversations.create({ cwd: '', expertId: 'SeniorDeveloper',
    expertMarketplace: 'experts', locale: 'zh', runtimeIdentity: opaque });
  assert.deepEqual(selected, { id: 'SeniorDeveloper', marketplace: 'experts', locale: 'zh', runtimeIdentity: opaque });
  assert.equal(controller.configManager.expert.runtimeIdentity, opaque);
  assert.equal(fixture.calls.filter(call => call.method === 'expert.resolve').length, 1);
  assert.ok(fixture.calls.findIndex(call => call.method === 'expert.resolve') < fixture.calls.findIndex(call => call.method === 'thread.create'));
  await api.dispose({ preserveUiState: true });
});

test('original native Home and Embed expert producers retain full identity through the actual renderer local binding pipeline', async () => {
  const native = createNativeExpertReplay();
  const dto = native.mapExpertInfo({ id: 'SeniorDeveloper', marketExpertId: 'ex_SYNTHETIC_NATIVE', source: 'builtin', locale: 'en',
    marketplace: 'experts', pluginName: 'senior-developer', pluginRegisteredName: 'senior-developer', agentName: 'senior-developer',
    name: 'Synthetic native expert', displayName: { en: 'Synthetic native expert' }, expertType: 'agent',
    localPath: '/synthetic/installed-experts/senior-developer', updatedAt: '2026-10-28' }, 'en');
  for (const producer of ['homeCreateParams', 'embedCreateParams']) {
    const params = native[producer](dto, { cwd: '/synthetic/workspace' });
    const expected = plainP0(params.expert);
    assert.equal(expected.id, dto.id); assert.equal(expected.marketExpertId, dto.marketExpertId);
    assert.equal(expected.source, 'builtin'); assert.equal(expected.locale, 'en');
    assert.equal(expected.marketplace, 'experts'); assert.equal(typeof expected.runtimeIdentity, 'string');
    let cloudQueries = 0;
    const fixture = createNativeRendererFixture({ initialPath: '/home', rpcHandlers: { 'expert.resolve'({ expert }) {
      assert.deepEqual(plainP0(expert), expected, producer);
      return { expert: packagedRendererExpert(expert) };
    } } });
    fixture.context.wb.experts = { async get() { cloudQueries++; throw new Error('installed native selection must stay local'); },
      custom: { async get() { cloudQueries++; throw new Error('market identity must not query custom'); } } };
    const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
    const controller = await fixture.context.wb.conversations.create(params);
    const bound = fixture.calls.find(call => call.method === 'thread.context.set').params.expert;
    for (const [key, value] of Object.entries(expected)) assert.equal(bound[key], value, `${producer}:${key}`);
    assert.equal(controller.configManager.expert.prompt, 'SYNTHETIC_AGENT_PERSONA');
    assert.deepEqual(fixture.calls.filter(call => ['expert.resolve', 'thread.create', 'thread.context.set'].includes(call.method)).map(call => call.method),
      ['expert.resolve', 'thread.create', 'thread.context.set']);
    assert.equal(cloudQueries, 0); assert.deepEqual(fixture.connectorCalls, []);
    await api.dispose({ preserveUiState: true });
  }
});

test('remote market lookup keeps native source and market identity then rechecks locally activated package metadata', async () => {
  const selection = { id: 'MarketAlias', marketExpertId: 'ex_SYNTHETIC_MARKET', source: 'builtin', enterpriseId: 'SYNTHETIC_ENTERPRISE',
    locale: 'en', runtimeIdentity: 'SYNTHETIC_OPAQUE_IDENTITY', marketplace: 'experts' };
  const lookups = []; let customLookups = 0; let resolverCalls = 0;
  const fixture = createNativeRendererFixture({ initialPath: '/home', rpcHandlers: {
    'expert.resolve'({ expert }) {
      resolverCalls++;
      if (resolverCalls === 1) return { expert: null };
      assert.equal(expert.localPath, '/synthetic/activated-package');
      for (const [key, value] of Object.entries(selection)) assert.equal(expert[key], value, key);
      return { expert: packagedRendererExpert(expert) };
    },
  } });
  fixture.context.wb.experts = { async get(query) { lookups.push(plainP0(query)); return { id: 'remote-canonical-id',
    localPath: '/synthetic/activated-package', pluginName: 'activated-plugin', expertType: 'agent', displayName: { en: 'Activated expert' } }; },
    custom: { async get() { customLookups++; return { prompt: 'UNRELATED_CUSTOM_PERSONA' }; } } };
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd: '', expert: selection });
  assert.deepEqual(lookups, [{ expertId: selection.id, locale: 'en', marketExpertId: selection.marketExpertId,
    source: 'builtin', enterpriseId: selection.enterpriseId }]);
  assert.equal(customLookups, 0); assert.equal(resolverCalls, 2);
  assert.equal(controller.configManager.expert.id, selection.id);
  assert.equal(controller.configManager.expert.prompt, 'SYNTHETIC_AGENT_PERSONA');
  assert.equal(controller.configManager.expert.source, 'builtin');
  await api.dispose({ preserveUiState: true });
});

test('official instruction experts win over same-alias custom results while custom experts retain their own identity', async () => {
  const queries = [];
  const fixture = createNativeRendererFixture({ initialPath: '/home' });
  fixture.context.wb.experts = { async get(query) { queries.push(['official', plainP0(query)]); return { id: query.expertId,
    name: 'Official instructions', prompt: { zh: 'OFFICIAL_PERSONA' }, source: 'builtin' }; },
    custom: { async get(query) { queries.push(['custom', plainP0(query)]); return { id: query.expertId,
      name: 'Local custom instructions', prompt: { zh: 'CUSTOM_PERSONA' }, source: 'custom', marketplace: 'my-experts' }; } } };
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const official = await fixture.context.wb.conversations.create({ cwd: '', expertId: 'shared-alias' });
  assert.equal(official.configManager.expert.prompt, 'OFFICIAL_PERSONA');
  assert.equal(official.configManager.expert.source, 'builtin');
  fixture.context.wb.experts.get = async () => { throw new Error('synthetic official miss'); };
  const custom = await fixture.context.wb.conversations.create({ cwd: '', expertId: 'private-alias' });
  assert.equal(custom.configManager.expert.prompt, 'CUSTOM_PERSONA');
  assert.equal(custom.configManager.expert.source, 'custom');
  assert.equal(custom.configManager.expert.marketplace, 'my-experts');
  assert.equal(custom.configManager.expert.id, 'private-alias');
  assert.deepEqual(queries[0], ['official', { expertId: 'shared-alias', locale: 'zh' }]);
  assert.deepEqual(queries[1], ['custom', { expertId: 'shared-alias' }]);
  await api.dispose({ preserveUiState: true });
});

test('explicit builtin and enterprise namespaces cannot fall back to a same-alias custom persona without a market id', async () => {
  for (const source of ['builtin', 'enterprise']) {
    let customCalls = 0; const officialQueries = [];
    const fixture = createNativeRendererFixture({ initialPath: '/home' });
    fixture.context.wb.experts = { async get(query) { officialQueries.push(plainP0(query)); throw new Error('synthetic explicit namespace miss'); },
      custom: { async get() { customCalls++; return { id: 'shared-alias', source: 'custom', prompt: 'WRONG_NAMESPACE_PERSONA' }; } } };
    const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
    await assert.rejects(fixture.context.wb.conversations.create({ cwd: '', expert: { id: 'shared-alias', source } }), /未提供可用指令/);
    assert.deepEqual(officialQueries, [{ expertId: 'shared-alias', locale: 'zh', source }]);
    assert.equal(customCalls, 0);
    assert.equal(fixture.calls.some(call => ['thread.create', 'thread.context.set', 'turn.start'].includes(call.method)), false);
    await api.dispose({ preserveUiState: true });
  }
  let customCalls = 0;
  const fixture = createNativeRendererFixture({ initialPath: '/home' });
  fixture.context.wb.experts = { async get() { throw new Error('synthetic explicit custom directory miss'); },
    custom: { async get() { customCalls++; return { id: 'private-alias', source: 'custom', prompt: 'CORRECT_CUSTOM_PERSONA' }; } } };
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd: '', expert: { id: 'private-alias', source: 'custom' } });
  assert.equal(customCalls, 1); assert.equal(controller.configManager.expert.source, 'custom');
  assert.equal(controller.configManager.expert.prompt, 'CORRECT_CUSTOM_PERSONA');
  await api.dispose({ preserveUiState: true });
});

test('saved expert package hashes survive create and explicit rebind and changed packages fail before any new thread', async () => {
  const saved = packagedRendererExpert({ id: 'saved-package-alias', source: 'builtin', marketplace: 'experts', runtimeIdentity: 'SYNTHETIC_SAVED_IDENTITY' });
  let resolutionCount = 0; let rejectChanged = false;
  const fixture = createNativeRendererFixture({ initialPath: '/home', rpcHandlers: { 'expert.resolve'({ expert }) {
    resolutionCount++;
    assert.deepEqual(plainP0(expert.package), saved.package, 'the Node reader must receive persisted expected hashes');
    if (rejectChanged) throw Object.assign(new Error('synthetic persisted package hash differs'), { code: 'PI_EXPERT_PACKAGE_CHANGED' });
    return { expert: { ...packagedRendererExpert(expert), prompt: 'NODE_REVALIDATED_PERSONA' } };
  } } });
  fixture.context.wb.experts = { async get() { throw new Error('saved package validation must not degrade to cloud'); } };
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd: '', expert: saved });
  assert.equal(controller.configManager.expert.prompt, 'NODE_REVALIDATED_PERSONA');
  assert.deepEqual(plainP0(controller.configManager.expert.package), saved.package);
  await controller.configManager.setExpert(controller.configManager.expert);
  assert.equal(resolutionCount, 2);
  const previousCreates = fixture.calls.filter(call => call.method === 'thread.create').length;
  const previousContexts = fixture.calls.filter(call => call.method === 'thread.context.set').length;
  rejectChanged = true;
  await assert.rejects(fixture.context.wb.conversations.create({ cwd: '', expert: saved }), error => error.code === 'PI_EXPERT_PACKAGE_CHANGED');
  assert.equal(resolutionCount, 3);
  assert.equal(fixture.calls.filter(call => call.method === 'thread.create').length, previousCreates);
  assert.equal(fixture.calls.filter(call => call.method === 'thread.context.set').length, previousContexts);
  assert.equal(fixture.calls.some(call => call.method === 'turn.start'), false);
  await api.dispose({ preserveUiState: true });
});

test('default initial user requests never become persona and unresolved or unsafe expert packages block creation', async () => {
  const fixture = createNativeRendererFixture({ initialPath: '/home' });
  fixture.context.wb.experts = { async get() { return { prompt: { zh: 'SYNTHETIC_DEFAULT_TASK' },
    defaultInitPrompt: { zh: 'SYNTHETIC_DEFAULT_TASK' } }; }, custom: { async get() { return undefined; } } };
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  await assert.rejects(fixture.context.wb.conversations.create({ cwd: '', expert: { id: 'placeholder-expert',
    prompt: 'SYNTHETIC_DEFAULT_TASK', defaultInitPrompt: 'SYNTHETIC_DEFAULT_TASK' } }), /未提供可用指令/);
  await assert.rejects(fixture.context.wb.conversations.create({ cwd: '', expertId: 'missing-expert' }), /未提供可用指令/);
  assert.equal(fixture.calls.some(call => ['thread.create', 'thread.context.set', 'turn.start'].includes(call.method)), false);
  await api.dispose({ preserveUiState: true });
  let queried = 0;
  const unsafe = createNativeRendererFixture({ initialPath: '/home', rpcHandlers: { 'expert.resolve'() {
    throw Object.assign(new Error('synthetic package verification failed'), { code: 'PI_EXPERT_PACKAGE_CHANGED' });
  } } });
  unsafe.context.wb.experts = { async get() { queried++; return { prompt: 'CLOUD_MUST_NOT_MASK_PACKAGE_FAILURE' }; } };
  const unsafeApi = installP0Renderer(unsafe); assert.equal(await unsafeApi.ready, true);
  await assert.rejects(unsafe.context.wb.conversations.create({ cwd: '', expertId: 'changed-package' }), error => error.code === 'PI_EXPERT_PACKAGE_CHANGED');
  assert.equal(queried, 0);
  assert.equal(unsafe.calls.some(call => ['thread.create', 'thread.context.set', 'turn.start'].includes(call.method)), false);
  await unsafeApi.dispose({ preserveUiState: true });
  for (const response of [{}, { expert: [] }]) {
    const malformed = createNativeRendererFixture({ initialPath: '/home', rpcHandlers: { 'expert.resolve'() { return response; } } });
    malformed.context.wb.experts = { async get() { throw new Error('malformed resolver must not fall through'); } };
    const malformedApi = installP0Renderer(malformed); assert.equal(await malformedApi.ready, true);
    await assert.rejects(malformed.context.wb.conversations.create({ cwd: '', expertId: 'malformed-package' }), /本地解析返回无效结果/);
    assert.equal(malformed.calls.some(call => ['thread.create', 'thread.context.set', 'turn.start'].includes(call.method)), false);
    await malformedApi.dispose({ preserveUiState: true });
  }
});

test('clearing wins over in-flight expert resolution and restart hydrates saved package metadata without directory lookups', async () => {
  let release; let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const fixture = createNativeRendererFixture({ initialPath: '/home', rpcHandlers: { 'expert.resolve'({ expert }) {
    entered(); return new Promise(resolve => { release = () => resolve({ expert: packagedRendererExpert(expert) }); });
  } } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const controller = await fixture.context.wb.conversations.create({ cwd: '' });
  const selecting = controller.configManager.setExpert({ id: 'synthetic-deferred-package', source: 'builtin' });
  await ready; await controller.configManager.setExpert(null); release(); await selecting;
  assert.equal(controller.configManager.expert, undefined);
  assert.deepEqual(fixture.calls.filter(call => call.method === 'thread.context.set').map(call => call.params.expert), [null]);
  await api.dispose({ preserveUiState: true });
  const saved = { ...p0Thread(), nativeContext: { expert: packagedRendererExpert({ id: 'synthetic-restored-package',
    source: 'builtin', runtimeIdentity: 'SAVED_OPAQUE_IDENTITY' }), connectors: [] } };
  const restarted = createNativeRendererFixture({ initialPath: `/conversation/wbhost:fake:${saved.id}`, runtimeSnapshot: p0Snapshot(saved) });
  restarted.context.wb.experts = { async get() { throw new Error('restoration must use Host snapshot'); } };
  const restartedApi = installP0Renderer(restarted); assert.equal(await restartedApi.ready, true);
  const restored = await restarted.context.wb.conversations.get(`wbhost:fake:${saved.id}`);
  assert.equal(restored.configManager.expert.runtimeIdentity, 'SAVED_OPAQUE_IDENTITY');
  assert.equal(restored.configManager.expert.package.skills.length, 12);
  assert.equal(restarted.calls.some(call => ['expert.resolve', 'thread.create', 'thread.context.set'].includes(call.method)), false);
  await restartedApi.dispose({ preserveUiState: true });
});

test('a disposed expert resolver cannot create or bind a thread after renderer ownership ends', async () => {
  let entered;
  const pending = new Promise(resolve => { entered = resolve; });
  const fixture = createNativeRendererFixture({ initialPath: '/home', rpcHandlers: { 'expert.resolve'() {
    entered(); return new Promise(() => {});
  } } });
  const api = installP0Renderer(fixture); assert.equal(await api.ready, true);
  const create = fixture.context.wb.conversations.create({ cwd: '', expertId: 'synthetic-late-package' });
  const rejected = assert.rejects(create, /renderer removed|disposed|owner|no longer|桥|关闭/i);
  await pending; await api.dispose({ preserveUiState: true }); await rejected;
  assert.equal(fixture.calls.some(call => ['thread.create', 'thread.context.set', 'turn.start'].includes(call.method)), false);
});
