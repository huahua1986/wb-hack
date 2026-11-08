'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LIMIT = 64 * 1024;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function failure(code, status = 403, mayHaveExecuted = false) {
  return Object.assign(new Error(code), { code, status, mayHaveExecuted });
}
function text(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f]/.test(value);
}
function boundedClone(value, code) {
  let encoded;
  try { encoded = JSON.stringify(value, (key, current) => {
    if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof current) || (typeof current === 'number' && !Number.isFinite(current))) throw Error('Non-JSON value');
    return current;
  }); } catch { throw failure(code, 400); }
  if (!encoded || Buffer.byteLength(encoded) > LIMIT) throw failure(code, 400);
  return JSON.parse(encoded);
}
function connectorSelection(connectors) {
  if (!Array.isArray(connectors) || connectors.length > 100) throw failure('NATIVE_MCP_CONTEXT_INVALID', 400);
  const selected = new Set();
  for (const connector of connectors) {
    const name = typeof connector === 'string' ? connector : plain(connector) ? connector.name ?? connector.id : undefined;
    if (!text(name)) throw failure('NATIVE_MCP_CONTEXT_INVALID', 400);
    if (name.startsWith('custom-mcp:')) { selected.add(name); continue; }
    selected.add(name); selected.add(name.replace(/^connector:/, '')); selected.add('connector:' + name.replace(/^connector:/, ''));
  }
  return selected;
}
function contextFor(params) {
  if (!plain(params) || !text(params.threadId) || typeof params.cwd !== 'string' || params.cwd.length > 4096 ||
      /[\x00-\x1f]/.test(params.cwd) || (params.cwd !== '' && !params.cwd.startsWith('/'))) throw failure('NATIVE_MCP_CONTEXT_INVALID', 400);
  return { sessionId: params.threadId, cwd: params.cwd, workspace: params.cwd,
    enabledConnectors: connectorSelection(params.connectors ?? []), isBrowserEnabled: false, toolSpecs: [] };
}
function owner(auth, manager) {
  const session = auth.currentSessionSubject.getValue();
  if (!session?.account?.uid || !session.auth?.accessToken) throw failure('NATIVE_MCP_AUTH_REQUIRED', 401);
  // 5.9.1 assigns McpManager.setIdentity(authService.getAccount()?.uid || 'default').
  // A new auth session can be visible before that asynchronous manager update.
  if (!text(session.account.uid, 4096) || manager.identityKey !== session.account.uid) throw failure('NATIVE_MCP_ACCOUNT_NOT_READY', 503);
  return JSON.stringify([session.account.uid, session.account.enterpriseId || '', session.account.type || '', session.auth.domain || '', manager.identityKey]);
}
function connected(states, item) {
  const id = item.origin.connectorId;
  const state = states[id] || states[item.id] || states[id.replace(/^connector:/, '')];
  return !!state && state.bound === true && state.enabled === true && !state.connecting && !state.reason && state.connected === true;
}
function selected(context, item) {
  if (item.origin.kind === 'user') return item.id.startsWith('custom-mcp:') && text(item.configHash);
  if (item.origin.connectorId.startsWith('custom-mcp:')) return context.enabledConnectors.has(item.id);
  return context.enabledConnectors.has(item.id) || context.enabledConnectors.has(item.origin.connectorId) ||
    context.enabledConnectors.has(item.origin.connectorId.replace(/^connector:/, ''));
}
function stableStringify(value) {
  return Array.isArray(value) ? `[${value.map(stableStringify).join(',')}]` : !value || typeof value !== 'object' ? JSON.stringify(value) ?? 'null' :
    `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}
// Same inputs and algorithm as 5.9.1 computeConnectionFingerprint; never exported to Pi.
function fingerprint(item) {
  return crypto.createHash('sha256').update(stableStringify({ transport: item.transport.kind === 'stdio' ? item.transport : { kind: item.transport.kind, url: item.transport.url },
    auth: item.auth, needsInjectPOI: item.needsInjectPOI === true || undefined, injectOneIdAuth: item.injectOneIdAuth })).digest('hex').slice(0, 32);
}
function callableController(controller, manager, item) {
  if (!controller || controller.state !== 'ready' || controller.pendingOperations !== 0 || controller.disposed === true ||
      !['http', 'sse', 'stdio'].includes(controller.transport?.kind) || controller.transport.kind !== item.transport?.kind ||
      typeof controller.listTools !== 'function' || controller.connectionFingerprint !== fingerprint(item)) return false;
  if (controller.transport.kind === 'stdio') {
    // Native stdio controllers only probe; base ownsIdentity() always returns true.
    // A call gets a new owned child after UID/fence/config checks, never a reused old session.
    return !controller.transport.localRoute && typeof manager.resolveStdioRuntimeCommand === 'function' && typeof manager.resolveStdioRuntimePathEnv === 'function';
  }
  if (controller.identityKey !== manager.identityKey) return false;
  const owns = typeof controller.ownsIdentity === 'function' ? controller.ownsIdentity(manager.identityKey) : controller.identityKey === manager.identityKey;
  return owns === true && typeof controller.listTools === 'function' && typeof controller.requestContext?.run === 'function' &&
    typeof controller.session?.callTool === 'function';
}
function cancelled(signal, sent = false) { if (signal?.aborted) throw failure('NATIVE_MCP_CANCELLED', 499, sent); }
function raceCancellation(promise, signal, wasSent) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure('NATIVE_MCP_CANCELLED', 499, wasSent()));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
  });
}

/** Ready selected native connectors only. Listing never starts a transport or exports credentials. */
function createNativeMcpService({ mcpManager, connectorService, authenticationManager, stdioNodeCommand, stdioCaller } = {}) {
  function verifiedNode() {
    if (!stdioNodeCommand) return undefined;
    if (!path.isAbsolute(stdioNodeCommand) || !['node', 'node.exe'].includes(path.basename(stdioNodeCommand).toLowerCase())) throw failure('NATIVE_MCP_STDIO_NODE_UNAVAILABLE', 503);
    try { if (!fs.statSync(stdioNodeCommand).isFile()) throw Error(); fs.accessSync(stdioNodeCommand, fs.constants.X_OK); }
    catch { throw failure('NATIVE_MCP_STDIO_NODE_UNAVAILABLE', 503); }
    return stdioNodeCommand;
  }
  function stdioLaunch(controller, context) {
    const transport = controller.transport;
    if (transport.localRoute) throw failure('NATIVE_MCP_LOCAL_ROUTE_UNSUPPORTED');
    if (typeof transport.command !== 'string' || !transport.command || /[\x00-\x1f]/.test(transport.command) ||
        (transport.args !== undefined && (!Array.isArray(transport.args) || transport.args.some(arg => typeof arg !== 'string' || /[\x00-\x1f]/.test(arg)))) ||
        (transport.env !== undefined && !plain(transport.env))) throw failure('NATIVE_MCP_STDIO_CONFIG_INVALID', 400);
    const node = verifiedNode();
    const expand = value => value.replace(/\$\{(?:CLAUDE|CODEBUDDY)_PROJECT_DIR\}/g, () => context.cwd);
    const command = transport.command === 'node' && node ? node : mcpManager.resolveStdioRuntimeCommand(expand(transport.command));
    if (typeof command !== 'string' || !command || /[\x00-\x1f]/.test(command) || /^(?:electron|electron\.exe)$/i.test(path.basename(command))) throw failure('NATIVE_MCP_STDIO_NODE_UNAVAILABLE', 503);
    const pathEnv = mcpManager.resolveStdioRuntimePathEnv();
    if (!plain(pathEnv)) throw failure('NATIVE_MCP_STDIO_CONFIG_INVALID', 400);
    const configuredEnv = Object.fromEntries(Object.entries(transport.env ?? {}).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, expand(value)]));
    const env = Object.fromEntries(Object.entries({ ...process.env, ...pathEnv, ...configuredEnv, CODEBUDDY_PROJECT_DIR: context.cwd, CLAUDE_PROJECT_DIR: context.cwd, NODE_OPTIONS: '' }).filter(([, value]) => typeof value === 'string'));
    delete env.WORKBUDDY_PI_OFFICE_SECRET;
    if (node) {
      const key = Object.keys(env).find(key => key.toLowerCase() === 'path'), inherited = key ? env[key] : '';
      for (const name of Object.keys(env)) if (name.toLowerCase() === 'path') delete env[name];
      env.PATH = [path.dirname(node), inherited].filter(Boolean).join(path.delimiter);
    }
    const cwd = transport.cwd === undefined ? context.cwd : typeof transport.cwd === 'string' ? expand(transport.cwd) : undefined;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd)) throw failure('NATIVE_MCP_STDIO_CONFIG_INVALID', 400);
    return { command, args: (transport.args ?? []).map(expand), env, cwd };
  }
  function requireServices() {
    if (typeof authenticationManager?.currentSessionSubject?.getValue !== 'function' ||
        typeof authenticationManager.waitForSessionRefresh !== 'function' || typeof mcpManager?.computeContext !== 'function' ||
        typeof mcpManager.controllers?.get !== 'function' || typeof mcpManager.toRowTools !== 'function' ||
        typeof mcpManager.toolPolicy?.load !== 'function' || typeof mcpManager.whenSettled !== 'function') {
      throw failure('NATIVE_MCP_UNAVAILABLE', 503);
    }
  }
  function assertOwner(expected, sent = false) {
    let actual;
    try { actual = owner(authenticationManager, mcpManager); } catch { throw failure('NATIVE_MCP_ACCOUNT_CHANGED', 401, sent); }
    if (actual !== expected) throw failure('NATIVE_MCP_ACCOUNT_CHANGED', 401, sent);
  }
  async function snapshot(params, signal) {
    cancelled(signal); requireServices();
    await raceCancellation(Promise.resolve(authenticationManager.waitForSessionRefresh()), signal, () => false); cancelled(signal);
    const identity = owner(authenticationManager, mcpManager), context = contextFor(params);
    await raceCancellation(Promise.resolve(mcpManager.whenSettled()), signal, () => false); cancelled(signal); assertOwner(identity);
    await raceCancellation(Promise.resolve(mcpManager.toolPolicy.load()), signal, () => false); cancelled(signal);
    const items = mcpManager.computeContext(context);
    if (!Array.isArray(items)) throw failure('NATIVE_MCP_UNAVAILABLE', 503);
    let states = {};
    if (items.some(item => item?.origin?.kind === 'connector' && text(item.origin.connectorId) && item.enabled === true && item.trusted === true && selected(context, item))) {
      if (typeof connectorService?.getStates !== 'function') throw failure('NATIVE_MCP_UNAVAILABLE', 503);
      states = await raceCancellation(Promise.resolve(connectorService.getStates({ buddyAppScope: 'ignore' })), signal, () => false); cancelled(signal);
      if (!plain(states)) throw failure('NATIVE_MCP_UNAVAILABLE', 503);
    }
    assertOwner(identity);
    const records = [], ids = new Set();
    for (const item of items) {
      // 5.9.1 user MCP is globally enabled/trusted; no managed bound-state exists for it.
      // Buddy/plugin/first-party capabilities still require separately verified bindings.
      if (!item || !['connector', 'user'].includes(item.origin?.kind) || !text(item.id) ||
          (item.origin.kind === 'connector' && !text(item.origin.connectorId)) || item.enabled !== true || item.trusted !== true ||
          !selected(context, item) || (item.origin.kind === 'connector' && !connected(states, item))) continue;
      const controller = mcpManager.controllers.get(item.id);
      if (!callableController(controller, mcpManager, item)) continue;
      const rows = mcpManager.toRowTools(item, controller);
      if (!Array.isArray(rows)) continue;
      const enabled = new Set(rows.filter(tool => tool.enabled === true).map(tool => tool.name));
      const tools = controller.listTools(); if (!Array.isArray(tools)) continue;
      for (const tool of tools) {
        if (!text(tool?.name) || !enabled.has(tool.name) || !plain(tool.inputSchema) || tool.inputSchema.type !== 'object') continue;
        const id = item.id + '\0' + tool.name; if (ids.has(id)) continue;
        let inputSchema; try { inputSchema = boundedClone(tool.inputSchema, 'NATIVE_MCP_SCHEMA_INVALID'); } catch { continue; }
        ids.add(id);
        records.push({ item, controller, sourceType: item.origin.kind, configHash: item.configHash, fingerprint: fingerprint(item), public: {
          serverId: item.id, connectorId: item.origin.kind === 'user' ? item.id : item.origin.connectorId, sourceType: item.origin.kind,
          ...(item.origin.kind === 'user' ? { selectedGlobally: true } : {}), rawName: tool.name,
          description: typeof tool.description === 'string' ? tool.description.slice(0, 16384) : '', inputSchema } });
      }
    }
    assertOwner(identity); cancelled(signal);
    return { context, identity, records };
  }
  return {
    async list(params) {
      try { return (await snapshot(params, params?.signal)).records.map(record => record.public); }
      catch (error) { if (error?.code?.startsWith?.('NATIVE_MCP_')) throw error; throw failure('NATIVE_MCP_CATALOG_FAILED', 503); }
    },
    async call(params) {
      let sent = false;
      try {
        if (!plain(params) || !text(params.serverId) || !text(params.rawName) || !plain(params.arguments)) throw failure('NATIVE_MCP_ARGUMENTS_INVALID', 400);
        const args = boundedClone(params.arguments, 'NATIVE_MCP_ARGUMENTS_INVALID'), signal = params.signal;
        cancelled(signal);
        const current = await snapshot(params, signal);
        const record = current.records.find(record => record.public.serverId === params.serverId && record.public.rawName === params.rawName);
        if (!record) throw failure('NATIVE_MCP_TOOL_NOT_ALLOWED');
        const execution = Promise.resolve().then(() => {
          cancelled(signal); assertOwner(current.identity);
          // Recheck native topology and policy immediately before dispatch, without auto-activation.
          const items = mcpManager.computeContext(current.context);
          const item = items.find(item => item.id === record.item.id && item.enabled === true && item.trusted === true);
          if (!item || item.origin?.kind !== record.sourceType || !selected(current.context, item) ||
              (record.sourceType === 'user' && item.configHash !== record.configHash) ||
              (record.sourceType === 'connector' && item.origin.connectorId !== record.public.connectorId) || fingerprint(item) !== record.fingerprint ||
              mcpManager.controllers.get(record.item.id) !== record.controller || !callableController(record.controller, mcpManager, item) ||
              !mcpManager.toRowTools(item, record.controller).some(tool => tool.name === params.rawName && tool.enabled === true)) throw failure('NATIVE_MCP_TOOL_NOT_ALLOWED');
          if (record.controller.transport.kind === 'stdio') {
            const launch = stdioLaunch(record.controller, current.context);
            cancelled(signal); assertOwner(current.identity);
            sent = true;
            return (stdioCaller || require('./native-stdio.cjs').callNativeStdio)({ ...launch, toolName: params.rawName, arguments: args, signal });
          }
          sent = true;
          // This existing session method does not perform the controller's auth-refresh retry.
          // Its transport has no per-call abort contract: cancellation drops the result, not remote side effects.
          return record.controller.requestContext.run({ sessionId: current.context.sessionId }, () => record.controller.session.callTool(params.rawName, args));
        });
        const result = await raceCancellation(execution, signal, () => sent);
        cancelled(signal, sent); assertOwner(current.identity, sent);
        return result;
      } catch (error) {
        if (error?.code?.startsWith?.('NATIVE_MCP_')) throw error;
        throw failure('NATIVE_MCP_CALL_FAILED', 502, sent);
      }
    },
  };
}

module.exports = { createNativeMcpService };
