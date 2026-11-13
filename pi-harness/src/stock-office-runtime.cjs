'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Module, createRequire } = require('node:module');
const { setTimeout: delay } = require('node:timers/promises');
const { createNativeOfficeService } = require('./native-office-service.cjs');

const maxDocumentBytes = 25 * 1024 * 1024;
const readTools = ['open_file', 'office_catalog', 'office_read', 'close_file'];
const docReadTools = new Set(['doc_find', 'doc_get_outline', 'doc_resolve_document_structure', 'doc_get_text_property']);
const docEditTools = new Set(['doc_find_and_replace', 'doc_replace_text']);
let stockRuntime;

function officeError(reason, status = 503) {
  const code = 'NATIVE_OFFICE_' + reason;
  return Object.assign(new Error(code), { code, status });
}

function editorOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port
      && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

function installStockOfficeRuntime({ appAsarPath }) {
  if (require('electron').app.getAppPath() !== appAsarPath) throw officeError('UNAVAILABLE');
  if (stockRuntime?.appAsarPath === appAsarPath) return { installed: true };
  if (stockRuntime) throw officeError('UNAVAILABLE');
  const stockRequire = createRequire(path.join(appAsarPath, 'package.json'));
  const bootstrapFile = path.join(appAsarPath, 'main/main-bootstrap.js');
  const runtime = stockRuntime = { appAsarPath, connection: null, getOrigin: null };
  const originalLoad = Module._load;
  function load(request, parent) {
    if (request !== './rpc-connection.js' || parent?.filename !== bootstrapFile) {
      return Reflect.apply(originalLoad, this, arguments);
    }
    // The stock exports use non-configurable getters. Shadow only the bootstrap
    // consumer's entry, leaving the shared exports and all other callers intact.
    if (Module._load === load) Module._load = originalLoad;
    const exports = Reflect.apply(originalLoad, this, arguments);
    if (typeof exports.l !== 'function') return exports;
    return Object.create(exports, { l: { value: function wireOfficeRuntime(options) {
      const result = Reflect.apply(exports.l, exports, arguments);
      if (typeof options?.daemonConnection?.invoke === 'function') {
        try {
          const selection = stockRequire('./main/tencent-docs-prompt-selection.js');
          if (typeof selection.x === 'function') {
            runtime.connection = options.daemonConnection;
            runtime.getOrigin = selection.x;
          }
        } catch { /* An unavailable Office adapter cannot break stock startup. */ }
      }
      return result;
    } } });
  }
  Module._load = load;
  setTimeout(() => {
    if (Module._load === load) Module._load = originalLoad;
  }, 30_000).unref();
  return { installed: true };
}

async function bounded(operation, signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

function createStockOfficeService({ appAsarPath, stagingRoot, workspaceRoot, documents, mode,
  runtime = stockRuntime, fetchImpl = globalThis.fetch } = {}) {
  if (!runtime || runtime.appAsarPath !== appAsarPath || typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)
    || typeof stagingRoot !== 'string' || !path.isAbsolute(stagingRoot)
    || !['read', 'edit'].includes(mode) || !Array.isArray(documents) || !documents.length
    || documents.some(name => typeof name !== 'string' || !/^[^./\\\x00-\x1f\x7f][^/\\\x00-\x1f\x7f]{0,246}\.docx$/i.test(name))) {
    throw officeError('UNAVAILABLE');
  }
  const allowed = new Set(documents);
  const names = new Set([...readTools, ...(mode === 'edit' ? ['office_edit', 'save_file'] : [])]);
  const currentOrigin = () => editorOrigin(runtime.getOrigin?.());
  let accountKey;
  let starting;
  function approvedFile(cwd, name) {
    if (cwd !== workspaceRoot || !allowed.has(name)) throw officeError('FILE_NOT_ALLOWED', 403);
    const filename = path.join(workspaceRoot, name);
    try {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxDocumentBytes
        || fs.realpathSync(filename) !== filename) throw Error();
      return filename;
    } catch { throw officeError('FILE_NOT_ALLOWED', 403); }
  }
  async function checkAccount(signal) {
    if (!runtime.connection || !runtime.getOrigin) throw officeError('UNAVAILABLE');
    const deadline = AbortSignal.timeout(8000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const account = await bounded(() => runtime.connection.invoke('auth:getAccount'), requestSignal);
    const uid = account?.uid;
    if (typeof uid !== 'string' || !uid.trim()) {
      office.revoke();
      throw officeError('AUTH_REQUIRED', 401);
    }
    const key = JSON.stringify([uid, account.enterpriseId ?? null, account.type ?? null, account.domain ?? null]);
    if (accountKey !== undefined && accountKey !== key) {
      office.revoke();
      accountKey = key;
      throw officeError('AUTH_REQUIRED', 401);
    }
    accountKey = key;
  }
  async function startEngine() {
    if (!runtime.connection || !runtime.getOrigin) throw officeError('UNAVAILABLE');
    const file = approvedFile(workspaceRoot, documents[0]);
    const signal = AbortSignal.timeout(55_000);
    // This native preview RPC starts the SDK and builds a read-only URL.
    // Loading the preview page is unnecessary and would open another editor.
    const result = await bounded(() => runtime.connection.invoke('docs:getPreviewUrl', file, { mode: 'readonly' }), signal);
    const expected = result?.success ? editorOrigin(result.url) : null;
    if (!expected) throw officeError('UNAVAILABLE');
    while (!currentOrigin()) await delay(25, undefined, { signal });
    if (currentOrigin() !== expected) throw officeError('UNAVAILABLE');
  }
  async function ensureEngineStarted() {
    if (currentOrigin()) return;
    starting ??= startEngine().finally(() => { starting = undefined; });
    await starting;
  }
  const office = createNativeOfficeService({
    stagingRoot, fetchImpl,
    documentService: {
      canEnsureEngineStart: () => Boolean(runtime.connection && runtime.getOrigin),
      ensureEngineStarted,
      isEngineStarted: () => Boolean(currentOrigin()),
      getEnginePort() {
        const origin = currentOrigin();
        return origin ? Number(new URL(origin).port) : null;
      },
    },
  });
  return {
    async list(params = {}) {
      return (await office.list(params)).filter(tool => names.has(tool.rawName));
    },
    async call(params = {}) {
      if (!names.has(params.rawName) || params.cwd !== workspaceRoot) throw officeError('TOOL_NOT_ALLOWED', 403);
      if (params.rawName === 'open_file' || params.rawName === 'save_file') {
        approvedFile(params.cwd, params.arguments?.file_path);
      }
      if (params.rawName === 'office_catalog') {
        const { family, name } = params.arguments ?? {};
        if (name ? !docReadTools.has(name) && !(mode === 'edit' && docEditTools.has(name)) : family !== 'doc') {
          throw officeError('TOOL_NOT_ALLOWED', 403);
        }
      }
      if ((params.rawName === 'office_read' && !docReadTools.has(params.arguments?.name))
        || (params.rawName === 'office_edit' && !docEditTools.has(params.arguments?.name))) throw officeError('TOOL_NOT_ALLOWED', 403);
      await checkAccount(params.signal);
      const result = await office.call(params);
      try { await checkAccount(params.signal); }
      catch (error) {
        if (params.rawName === 'save_file') error.mayHaveExecuted = true;
        throw error;
      }
      return result;
    },
    release: params => office.release(params),
    revoke: () => office.revoke(),
  };
}

module.exports = { createStockOfficeService, installStockOfficeRuntime };
