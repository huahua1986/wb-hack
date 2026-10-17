import { setTimeout as delay } from 'node:timers/promises';

function applyRendererBranding({ productName, welcomeTitle }) {
  const key = '__privateWorkbuddyBranding';
  window[key]?.dispose?.();
  const selectors = [
    ['.logo-workbuddy-title', productName],
    ['header.wb-home-header h1.wb-home-header__title > span:first-child', welcomeTitle],
  ];
  const state = { sidebar: 0, welcome: 0 };
  function apply() {
    selectors.forEach(([selector, value], index) => {
      const elements = document.querySelectorAll(selector);
      state[index === 0 ? 'sidebar' : 'welcome'] = elements.length;
      for (const element of elements) {
        // Preserve React's node ownership, including any adjacent title tags.
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode(), first = true;
        while (node) {
          const text = first ? value : '';
          if (node.data !== text) node.data = text;
          first = false;
          node = walker.nextNode();
        }
      }
    });
    return { ...state };
  }
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  window[key] = { apply, dispose: () => { observer.disconnect(); delete window[key]; } };
  return apply();
}

export function coalescePrivateNotifications(contents, { intervalMs = 500, eligible = () => true } = {}) {
  if (typeof contents.send !== 'function') return { dispose() {}, snapshot: () => ({ coalesced: 0 }) };
  const original = contents.send, pending = new Map();
  const topics = new Set(['skill:versionChanged', 'skillsVersionChanged', 'plugin:changed']);
  let coalesced = 0, deliveryFailures = 0, disposed = false;
  const topicOf = (value, depth = 0) => {
    if (typeof value === 'string') return topics.has(value) ? value : undefined;
    if (!value || typeof value !== 'object' || depth > 2) return;
    for (const key of ['event', 'method', 'channel']) if (topics.has(value[key])) return value[key];
    for (const key of ['payload', 'params', 'data']) {
      const found = topicOf(value[key], depth + 1); if (found) return found;
    }
  };
  function send(channel, ...args) {
    const topic = topicOf(channel) || topicOf(args[0]);
    if (disposed || !topic || !eligible()) return original.call(contents, channel, ...args);
    const key = channel + ':' + topic, now = performance.now();
    let state = pending.get(key);
    if (!state) { state = { sentAt: -Infinity, timer: null, latest: null }; pending.set(key, state); }
    const remaining = intervalMs - (now - state.sentAt);
    if (remaining <= 0 && !state.timer) { state.sentAt = now; return original.call(contents, channel, ...args); }
    state.latest = [channel, ...args]; coalesced++;
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        if (disposed || contents.isDestroyed() || !eligible() || !state.latest) { state.latest = null; return; }
        const latest = state.latest; state.latest = null; state.sentAt = performance.now();
        try { original.call(contents, ...latest); }
        catch {
          deliveryFailures++;
          if (!contents.isDestroyed()) console.warn('[private-notifications] deferred delivery failed');
        }
      }, Math.max(1, remaining));
      state.timer.unref?.();
    }
  }
  contents.send = send;
  return {
    snapshot: () => ({ coalesced, deliveryFailures }),
    dispose() { disposed = true; for (const state of pending.values()) clearTimeout(state.timer); pending.clear(); if (contents.send === send) contents.send = original; },
  };
}

function installMainBranding({ appAsarPath, rendererScript, notificationIntervalMs }, installNotifications) {
  const require = process.getBuiltinModule('module').createRequire(`${appAsarPath}/package.json`);
  const { app, webContents } = require('electron');
  if (!app || app.getAppPath() !== appAsarPath) throw new Error('Unexpected application');
  const key = Symbol.for('private.workbuddy.branding');
  globalThis[key]?.dispose?.();
  const attached = new Map();
  const results = new Map();
  const expectedPath = `${appAsarPath}/renderer/index.html`;
  const eligible = contents => {
    try {
      const url = new URL(contents.getURL());
      return url.protocol === 'file:' && decodeURIComponent(url.pathname) === expectedPath;
    } catch { return false; }
  };
  const apply = async contents => {
    if (contents.isDestroyed() || !eligible(contents)) return;
    try {
      const result = await contents.executeJavaScript(rendererScript);
      if (!contents.isDestroyed()) results.set(contents.id, result);
    } catch { /* A navigation can destroy the old context; its load event retries. */ }
  };
  const attach = contents => {
    if (attached.has(contents.id)) return;
    const load = () => { void apply(contents); };
    const notifications = installNotifications(contents, { intervalMs: notificationIntervalMs, eligible: () => eligible(contents) });
    const destroy = () => { notifications.dispose(); attached.delete(contents.id); results.delete(contents.id); };
    contents.on('dom-ready', load);
    contents.on('did-finish-load', load);
    contents.once('destroyed', destroy);
    attached.set(contents.id, { contents, load, destroy, notifications });
    if (!contents.isLoadingMainFrame()) load();
  };
  const created = (_event, contents) => attach(contents);
  app.on('web-contents-created', created);
  webContents.getAllWebContents().forEach(attach);
  globalThis[key] = {
    snapshot: () => ({ installed: true, pages: results.size, coalescedNotifications: [...attached.values()].reduce((sum, item) => sum + item.notifications.snapshot().coalesced, 0) }),
    dispose: () => {
      app.removeListener('web-contents-created', created);
      for (const { contents, load, destroy, notifications } of attached.values()) {
        notifications.dispose();
        if (contents.isDestroyed()) continue;
        contents.removeListener('dom-ready', load);
        contents.removeListener('did-finish-load', load);
        contents.removeListener('destroyed', destroy);
      }
      attached.clear(); results.clear(); delete globalThis[key];
    },
  };
  return { installed: true };
}

export function brandingScripts({ appAsarPath, productName, welcomeTitle = `${productName}，我帮你`, notificationIntervalMs = 500 }) {
  if (!Number.isInteger(notificationIntervalMs) || notificationIntervalMs < 25 || notificationIntervalMs > 5000) throw new Error('通知合并间隔无效。');
  const rendererScript = `(${applyRendererBranding.toString()})(${JSON.stringify({ productName, welcomeTitle })})`;
  return {
    rendererScript,
    mainScript: `(${installMainBranding.toString()})(${JSON.stringify({ appAsarPath, rendererScript, notificationIntervalMs })}, ${coalescePrivateNotifications.toString()})`,
  };
}

export function parseInspectorEndpoint(text) {
  const match = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9-]+)(?:\s|$)/.exec(text);
  if (!match) return;
  const url = new URL(match[1]);
  if (url.username || url.password || url.search || url.hash || Number(url.port) > 65535) throw new Error('Invalid local inspector endpoint');
  return url.href;
}

class InspectorConnection {
  constructor(endpoint, timeoutMs) {
    this.socket = new WebSocket(endpoint);
    this.pending = new Map(); this.events = new Map(); this.waiters = new Map(); this.id = 0; this.timeoutMs = timeoutMs;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('名称启动钩子连接超时。')), timeoutMs);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('名称启动钩子连接失败。')); }, { once: true });
    });
    this.socket.addEventListener('message', event => {
      let packet; try { packet = JSON.parse(event.data); } catch { return; }
      if (packet.method === 'Debugger.paused') {
        const waiter = this.waiters.get(packet.method);
        if (waiter) { this.waiters.delete(packet.method); clearTimeout(waiter.timer); waiter.resolve(packet.params); }
        else this.events.set(packet.method, packet.params);
        return;
      }
      const pending = this.pending.get(packet.id); if (!pending) return;
      this.pending.delete(packet.id); clearTimeout(pending.timer);
      if (packet.error) pending.reject(new Error('原版进程不支持名称启动钩子。'));
      else pending.resolve(packet.result);
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('名称启动连接提前关闭。')); }
      this.pending.clear();
      for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('名称启动连接提前关闭。')); }
      this.waiters.clear();
    });
  }
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`名称启动钩子执行超时（${method}）。`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: false, returnByValue: true });
    if (result.exceptionDetails) throw new Error('名称启动钩子在原版进程中执行失败。', { cause: result.exceptionDetails.exception?.description || result.exceptionDetails.text });
    return result.result?.value;
  }
  waitForEvent(method) {
    if (this.events.has(method)) { const event = this.events.get(method); this.events.delete(method); return Promise.resolve(event); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(method); reject(new Error('名称启动钩子等待原版入口超时。')); }, this.timeoutMs);
      this.waiters.set(method, { resolve, reject, timer });
    });
  }
  close() { this.socket.close(); }
}

export async function installRuntimeBranding(endpoint, options, { timeoutMs = 10000, beforeResume } = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash) throw new Error('名称启动钩子只能连接本次启动的本机调试入口。');
  const connection = new InspectorConnection(endpoint, timeoutMs);
  let installed = false;
  try {
    await connection.call('Runtime.enable');
    await connection.call('Debugger.enable');
    await connection.call('Runtime.runIfWaitingForDebugger');
    await connection.waitForEvent('Debugger.paused');
    const scripts = brandingScripts(options);
    const result = await connection.evaluate(scripts.mainScript);
    if (result?.installed !== true) throw new Error('名称启动钩子未完成安装。');
    if (beforeResume) await beforeResume(expression => connection.evaluate(expression));
    installed = true;
    await connection.call('Debugger.resume');
    await connection.evaluate("setTimeout(() => process.getBuiltinModule('inspector').close(), 50).unref(); true");
  } finally {
    // A failed bootstrap must not leave the original process paused.
    if (!installed) {
      try { await connection.call('Runtime.runIfWaitingForDebugger'); } catch {}
      try { await connection.call('Debugger.resume'); } catch {}
    }
    connection.close();
  }
  const origin = `http://127.0.0.1:${url.port}`;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(300) }); }
    catch (error) { if (error.cause?.code === 'ECONNREFUSED') return { installed: true, inspectorClosed: true, inspectorPort: Number(url.port) }; }
    await delay(50);
  }
  throw new Error('名称已应用，但临时调试入口未关闭；启动器拒绝报告完成。');
}
