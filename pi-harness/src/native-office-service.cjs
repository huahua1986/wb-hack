'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { listFamily, describeTool, prepareTool } = require('./office-tool-catalog.cjs');

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_RPC_BYTES = 256 * 1024;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_TURNS = 128;
const MAX_EDITORS = 8;
const START_TIMEOUT = 65_000;
const CALL_TIMEOUT = 90_000;
const CLOSE_TIMEOUT = 5_000;
const FILE_ID = { type: 'string', minLength: 1, maxLength: 64, description: '本轮打开文档时返回的 file_id。' };
const FILE_PATH = { type: 'string', minLength: 1, maxLength: 4096, description: '当前工作目录内的 PPTX、DOCX、XLSX 或 XMind 文件路径。' };
const FORMATS = new Map([['.pptx', 'slide'], ['.docx', 'doc'], ['.xlsx', 'sheet'], ['.xmind', 'mind']]);
const EDITOR_TYPES = { slide: 'slide', doc: 'doc', sheet: 'sheet', mind: 'xmind' };
const ASSET_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff']);
const INDEX = { type: 'integer', minimum: 0, maximum: 10000 };
const SHORT_TEXT = { type: 'string', minLength: 1, maxLength: 8192 };
const TOOLS = [
  tool('open_file', '打开 Office 文件', '打开任务目录内的 PPTX、DOCX、XLSX 或 XMind，并返回本轮专用的 file_id。', { file_path: FILE_PATH }),
  tool('slide_get_info', '读取演示文稿信息', '读取幻灯片数量、尺寸与文档状态。', { file_id: FILE_ID }),
  tool('slide_get_page_info', '读取幻灯片', '读取指定幻灯片上的形状与文本摘要。页码从 0 开始。', { file_id: FILE_ID, page_index: INDEX }),
  tool('slide_get_text', '读取幻灯片文字', '从指定形状或表格读取文字。表格行列号可同时省略。', {
    file_id: FILE_ID, page_index: INDEX, shape_id: { ...SHORT_TEXT, maxLength: 256 }, row: INDEX, col: INDEX,
  }, ['file_id', 'page_index', 'shape_id']),
  tool('slide_find_replace_text', '替换幻灯片文字', '在指定幻灯片内替换文字。操作修改内存中的文档，随后用 save_file 保存。', {
    file_id: FILE_ID, page_index: INDEX, search: SHORT_TEXT, replace: { ...SHORT_TEXT, minLength: 0 },
  }),
  tool('save_file', '保存 Office 文件', '保存回打开路径，或另存到本任务内同格式的新路径。不能覆盖其他文件。', {
    file_id: FILE_ID, file_path: FILE_PATH,
  }),
  ...[...FORMATS].map(([extension, family]) => tool('create_' + family, '新建 ' + extension.slice(1).toUpperCase(),
    '在编辑器中创建空白文件。file_path 为任务目录内尚不存在的目标路径，编辑后调用 save_file 写入。', { file_path: FILE_PATH })),
  tool('get_pool_status', '查看本轮文档', '列出本轮打开的文档和文件句柄。', {}),
  tool('close_file', '关闭本轮文档', '关闭本轮已经保存或未修改的文档。', { file_id: FILE_ID }),
  tool('shutdown', '关闭 Office 编辑服务', '逐次确认后关闭空闲的本机 Office 编辑服务。打开的编辑器会阻止关闭，下次使用时会重新启动。', {}),
  tool('office_catalog', '查询 Office 能力', '按文档类型列出编辑能力，或按原始工具名查看完整输入 schema。', {
    family: { type: 'string', enum: ['slide', 'doc', 'sheet', 'mind'] }, name: { ...SHORT_TEXT, maxLength: 100 },
  }, []),
  ...['read', 'edit'].map(effect => tool('office_' + effect, effect === 'read' ? '读取 Office 文档' : '编辑 Office 文档',
    '使用 office_catalog 查询操作的输入 schema，再传原始工具名和参数。参数必须包含本轮文档 file_id。', {
      name: { ...SHORT_TEXT, maxLength: 100 }, arguments: { type: 'object', additionalProperties: true },
    })),
];
const BY_NAME = new Map(TOOLS.map(entry => [entry.rawName, entry]));
const ID = /^pi-(?:thread|turn)-[a-f0-9-]{36}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function tool(rawName, label, description, properties, required = Object.keys(properties)) {
  return { rawName, label, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}
function failure(reason, status, mayHaveExecuted = false) {
  const code = `NATIVE_OFFICE_${reason}`;
  return Object.assign(new Error(code), { code, status, mayHaveExecuted });
}
function checkActive(signal, sent = false) {
  if (signal?.aborted) throw failure('CANCELLED', 499, sent);
}
function turnKey(threadId, turnId) {
  if (typeof threadId !== 'string' || typeof turnId !== 'string' || !ID.test(threadId) || !ID.test(turnId) ||
      !threadId.startsWith('pi-thread-') || !turnId.startsWith('pi-turn-')) {
    throw failure('INVALID_CONTEXT', 400);
  }
  return threadId + '\0' + turnId;
}
function checkedArguments(rawName, args) {
  const schema = BY_NAME.get(rawName)?.inputSchema;
  if (!schema) throw failure('TOOL_NOT_ALLOWED', 403);
  if (!plain(args) || schema.required.some(key => !Object.hasOwn(args, key))) throw failure('INVALID_ARGUMENTS', 400);
  for (const [key, value] of Object.entries(args)) {
    const rule = Object.hasOwn(schema.properties, key) ? schema.properties[key] : null;
    const valid = rule?.type === 'string' ? typeof value === 'string' && value.length >= (rule.minLength ?? 0) && value.length <= (rule.maxLength ?? 4096) :
      rule?.type === 'integer' ? Number.isSafeInteger(value) && value >= rule.minimum && value <= rule.maximum :
      rule?.type === 'object' && plain(value);
    if (!valid || (rule.enum && !rule.enum.includes(value))) throw failure('INVALID_ARGUMENTS', 400);
  }
  if (rawName === 'slide_get_text' && ((args.row === undefined) !== (args.col === undefined))) throw failure('INVALID_ARGUMENTS', 400);
  if (Buffer.byteLength(JSON.stringify(args)) > 64 * 1024) throw failure('INVALID_ARGUMENTS', 400);
  return { ...args };
}
function fileSnapshot(cwd, filePath, { allowMissing = false, assets = false, attachment = false } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || path.resolve(cwd) !== cwd ||
      typeof filePath !== 'string' || /[\x00-\x1f\x7f\\]/.test(cwd + filePath) ||
      filePath.split('/').includes('..')) throw failure('FILE_NOT_ALLOWED', 403);
  const filename = path.resolve(cwd, filePath);
  const relative = path.relative(cwd, filename);
  const extension = path.extname(filename).toLowerCase();
  const family = FORMATS.get(extension);
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) ||
      !(attachment || (assets ? ASSET_TYPES.has(extension) : family))) throw failure('FILE_NOT_ALLOWED', 403);
  try {
    if (fs.realpathSync(path.dirname(filename)) !== path.dirname(filename) || fs.realpathSync(cwd) !== cwd) throw Error();
    const stat = fs.lstatSync(filename, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size === 0n || stat.size > MAX_FILE_BYTES ||
        fs.realpathSync(filename) !== filename) throw Error();
    return { filename, stat, extension, family };
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT' && fs.existsSync(path.dirname(filename))) return { filename, stat: null, extension, family };
    throw failure('FILE_NOT_ALLOWED', 403);
  }
}
function sameFile(previous, current) {
  return previous.filename === current.filename && (previous.stat && current.stat
    ? sameStat(previous.stat, current.stat) : previous.stat === current.stat);
}
const sameStat = (previous, current) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => previous[key] === current[key]);
function fileKey(filename) {
  return process.platform === 'darwin' ? filename.normalize('NFD').toLowerCase() : filename;
}
function readStable({ filename, stat }) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!sameStat(stat, fs.fstatSync(fd, { bigint: true }))) throw failure('FILE_CHANGED', 409);
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset);
      if (read === 0) throw failure('FILE_CHANGED', 409);
      offset += read;
    }
    if (!sameStat(stat, fs.fstatSync(fd, { bigint: true }))) throw failure('FILE_CHANGED', 409);
    return bytes;
  } finally { fs.closeSync(fd); }
}
function isRaster(bytes, extension) {
  const header = bytes.subarray(0, 12);
  if (extension === '.png') return header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (extension === '.jpg' || extension === '.jpeg') return header.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  if (extension === '.gif') return ['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString('ascii'));
  if (extension === '.bmp') return header.subarray(0, 2).toString('ascii') === 'BM';
  if (extension === '.webp') return header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP';
  return ['49492a00', '4d4d002a'].includes(header.subarray(0, 4).toString('hex'));
}
function privateStage(stagingRoot) {
  try {
    fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(stagingRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022)) throw Error();
    return fs.mkdtempSync(path.join(fs.realpathSync(stagingRoot), 'pi-office-'));
  } catch { throw failure('STAGING_UNAVAILABLE', 503); }
}
function removeStage(directory) { fs.rmSync(directory, { recursive: true, force: true }); }
function commitSave(target, bytes, cwd) {
  const { filename, stat } = target;
  const temporary = path.join(path.dirname(filename), `.pi-office-save-${randomUUID()}.tmp`);
  let created = false, committed = false;
  try {
    if (!sameFile(target, fileSnapshot(cwd, filename, { allowMissing: true }))) throw failure('FILE_CHANGED', 409);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    let replacement;
    try {
      fs.writeFileSync(fd, bytes);
      if (stat) fs.fchmodSync(fd, Number(stat.mode & 0o777n));
      fs.fsyncSync(fd);
      replacement = fs.fstatSync(fd, { bigint: true });
    } finally { fs.closeSync(fd); }
    if (!sameFile(target, fileSnapshot(cwd, filename, { allowMissing: true }))) throw failure('FILE_CHANGED', 409);
    if (stat) fs.renameSync(temporary, filename);
    else fs.linkSync(temporary, filename);
    committed = true;
    if (!stat) fs.unlinkSync(temporary);
    const current = fileSnapshot(cwd, filename);
    if (replacement.dev !== current.stat.dev || replacement.ino !== current.stat.ino || replacement.mtimeNs !== current.stat.mtimeNs) {
      throw failure('FILE_CHANGED', 409, true);
    }
    return current;
  } catch (error) {
    if (error?.code?.startsWith?.('NATIVE_OFFICE_') && !committed) throw error;
    throw failure('SAVE_FAILED', 502, committed);
  } finally { if (created) fs.rmSync(temporary, { force: true }); }
}
function bounded(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
  });
}
async function readResponse(response, limit) {
  if (!response.body) throw Error('Empty SDK response');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error('SDK response exceeds limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
function confirms(result, expected) {
  return Array.isArray(result.content) && result.content.some(entry => entry?.type === 'text' && entry.text === expected);
}
function documentInfo(result, file) {
  let info;
  try { info = result.structuredContent ?? JSON.parse(result.content?.[0]?.text); }
  catch { throw failure('SDK_BAD_RESPONSE', 502); }
  if (!plain(info) || info.file_id !== file.id) throw failure('SDK_BAD_RESPONSE', 502);
  const content = { ...info, file_path: file.snapshot.filename };
  return { content: [{ type: 'text', text: JSON.stringify(content) }], structuredContent: content };
}
function hideStage(value, file) {
  if (typeof value === 'string') return value.replaceAll(file.stage, '<SDK 暂存>');
  if (Array.isArray(value)) return value.map(item => hideStage(item, file));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hideStage(item, file)]));
  return value;
}

/** The native host owns SDK startup and ports. Pi only sees these selected tools and per-turn editor IDs. */
function createNativeOfficeService({ documentService, stagingRoot, fetchImpl = globalThis.fetch } = {}) {
  const turns = new Map(), filesByPath = new Map(), released = new Set();
  let catalog, rpcId = 0, activeOperations = 0, shuttingDown = false;
  const available = typeof documentService?.canEnsureEngineStart === 'function' &&
    typeof documentService.ensureEngineStarted === 'function' && typeof documentService.getEnginePort === 'function' &&
    typeof documentService.isEngineStarted === 'function' && typeof stagingRoot === 'string' && path.isAbsolute(stagingRoot);
  const currentPort = () => {
    if (!available || !documentService.isEngineStarted() || documentService.isSdkAlive?.() === false) return null;
    const value = documentService.getEnginePort();
    const port = typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : value;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  };
  async function rpc(port, method, params, signal, mayMutate = false) {
    checkActive(signal);
    if (currentPort() !== port) throw failure('UNAVAILABLE', 503);
    const id = ++rpcId;
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), redirect: 'error', signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw failure(response.status === 401 ? 'AUTH_REQUIRED' : 'SDK_HTTP_ERROR', 502, mayMutate);
      }
      const data = await readResponse(response, method === 'tools/list' ? MAX_CATALOG_BYTES : MAX_RPC_BYTES);
      if (currentPort() !== port || !plain(data) || data.id !== id || data.jsonrpc !== '2.0') {
        throw failure('SDK_BAD_RESPONSE', 502, mayMutate);
      }
      if (data.error || data.result?.isError === true) throw failure('SDK_TOOL_ERROR', 502, mayMutate);
      if (!plain(data.result)) throw failure('SDK_BAD_RESPONSE', 502, mayMutate);
      return data.result;
    } catch (error) {
      if (error?.code?.startsWith?.('NATIVE_OFFICE_')) throw error;
      if (signal.aborted) throw failure('CANCELLED', 499, mayMutate);
      throw failure('SDK_TRANSPORT', 502, mayMutate);
    }
  }
  async function ready(signal) {
    if (!available) throw failure('UNAVAILABLE', 503);
    const deadline = AbortSignal.timeout(START_TIMEOUT);
    const startSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      checkActive(startSignal);
      if (!await bounded(documentService.canEnsureEngineStart(), startSignal)) throw failure('UNAVAILABLE', 503);
      checkActive(startSignal);
      await bounded(documentService.ensureEngineStarted('pi-office'), startSignal);
      const port = currentPort();
      if (!port) throw failure('UNAVAILABLE', 503);
      if (catalog?.port !== port) {
        const health = await fetchImpl(`http://127.0.0.1:${port}/health`, { redirect: 'error', signal: startSignal });
        await health.body?.cancel();
        if (!health.ok) throw failure('UNAVAILABLE', 503);
        const { tools } = await rpc(port, 'tools/list', {}, startSignal);
        if (!Array.isArray(tools)) throw failure('SDK_BAD_RESPONSE', 502);
        const entries = tools.filter(entry => typeof entry?.name === 'string').map(entry => [entry.name, entry]);
        catalog = { port, names: new Set(entries.map(([name]) => name)), tools: new Map(entries) };
      }
      checkActive(startSignal);
      return catalog;
    } catch (error) {
      if (signal?.aborted) throw failure('CANCELLED', 499);
      if (deadline.aborted) throw failure('START_TIMEOUT', 504);
      if (error?.code?.startsWith?.('NATIVE_OFFICE_')) throw error;
      throw failure('UNAVAILABLE', 503);
    }
  }
  async function closeEditor(port, id) {
    // A stale port must never receive a close. IDs are generated exclusively for this adapter.
    try {
      if (currentPort() !== port) return true;
      const result = await rpc(port, 'tools/call', { name: 'close_file', arguments: { file_id: id, force: true } },
        AbortSignal.timeout(CLOSE_TIMEOUT));
      return confirms(result, `Editor closed for file_id=${id}`);
    } catch { return false; }
  }
  async function shutdown(signal) {
    checkActive(signal);
    if (shuttingDown || activeOperations || filesByPath.size) throw failure('SHUTDOWN_BUSY', 409);
    if (!available) throw failure('UNAVAILABLE', 503);
    const port = currentPort();
    const { engineSession, contextManager, pendingEmbeddedPreviewOpens, documentLeaseRegistry } = documentService;
    if (!port) {
      if (engineSession?.engineStartInflight) throw failure('SHUTDOWN_BUSY', 409);
      return { content: [{ type: 'text', text: 'Office 编辑服务已停止。' }] };
    }
    if (typeof engineSession?.dispose !== 'function' || typeof engineSession.resetOnUnexpectedExit !== 'function' ||
        typeof contextManager?.getFilePreviewContexts !== 'function' || !(pendingEmbeddedPreviewOpens instanceof Map) ||
        typeof documentLeaseRegistry?.getOpenLeasePhaseCounts !== 'function') {
      throw failure('UNAVAILABLE', 503);
    }
    shuttingDown = true;
    try {
      const deadline = AbortSignal.timeout(CLOSE_TIMEOUT);
      const status = await rpc(port, 'tools/call', { name: 'get_pool_status', arguments: {} },
        signal ? AbortSignal.any([signal, deadline]) : deadline);
      if (!Array.isArray(status.open_editors) || status.pool_size !== status.open_editors.length) throw failure('SDK_BAD_RESPONSE', 502);
      const previews = contextManager.getFilePreviewContexts();
      const leases = documentLeaseRegistry.getOpenLeasePhaseCounts();
      const counts = ['opening', 'open', 'releasing', 'closing'].map(phase => leases?.[phase]);
      if (!Array.isArray(previews) || counts.some(count => !Number.isSafeInteger(count) || count < 0)) throw failure('SDK_BAD_RESPONSE', 502);
      if (status.pool_size || pendingEmbeddedPreviewOpens.size || documentService.pendingAgentEditorOpenSettlements?.size ||
          previews.length || counts.some(Boolean)) {
        throw failure('SHUTDOWN_BUSY', 409);
      }
      checkActive(signal);
      // The native SDK shutdown RPC can crash while closing its HTTP connection.
      // Use the desktop engine's normal process shutdown after confirming its pool is empty.
      try { await engineSession.dispose(); }
      catch { throw failure('SHUTDOWN_UNCONFIRMED', 502, true); }
      engineSession.resetOnUnexpectedExit();
      catalog = null;
      const stoppedBy = Date.now() + CLOSE_TIMEOUT;
      for (;;) {
        try {
          const health = await fetchImpl(`http://127.0.0.1:${port}/health`, { redirect: 'error', signal: AbortSignal.timeout(500) });
          await health.body?.cancel();
        } catch (error) {
          if (error.cause?.code === 'ECONNREFUSED') break;
        }
        if (Date.now() >= stoppedBy) throw failure('SHUTDOWN_UNCONFIRMED', 504, true);
        await delay(100);
      }
      return { content: [{ type: 'text', text: 'Office 编辑服务已停止。' }] };
    } finally { shuttingDown = false; }
  }
  function forget(turn, file) {
    turn.files.delete(file.id);
    const key = fileKey(file.snapshot.filename);
    if (filesByPath.get(key) === file) filesByPath.delete(key);
    removeStage(file.stage);
  }
  async function closeTurn(turn) {
    const files = [...turn.files.values()];
    const closed = await Promise.all(files.map(file => closeEditor(file.port, file.id)));
    for (const [index, file] of files.entries()) if (closed[index]) forget(turn, file);
    return closed.every(Boolean);
  }
  function retire(key, turn) {
    released.add(key);
    if (released.size > 2048) released.delete(released.values().next().value);
    if (!turn) return Promise.resolve(true);
    turn.released = true;
    if (!turn.closing) {
      turn.closing = turn.tail.then(() => closeTurn(turn)).finally(() => {
        if (turn.files.size === 0) turns.delete(key);
        turn.closing = null;
      });
    }
    return turn.closing;
  }
  function assertTurn(turn, signal, sent = false) {
    if (turn.released) throw failure('CANCELLED', 499, sent);
    checkActive(signal, sent);
  }
  async function templateBytes(port, family, extension, signal) {
    const id = 'pi-office-template-' + randomUUID();
    const result = await rpc(port, 'tools/call', { name: 'create_' + family, arguments: { file_id: id } }, signal);
    const text = result.content?.find(entry => entry?.type === 'text')?.text;
    const fields = typeof text === 'string' ? /\bfile_id=([^,]+), file_path=(.+)$/.exec(text) : null;
    const filename = result.file_path ?? fields?.[2];
    if ((result.file_id ?? fields?.[1]) !== id || typeof filename !== 'string') throw failure('SDK_BAD_RESPONSE', 502);
    const roots = [stagingRoot, path.dirname(stagingRoot), os.tmpdir()].flatMap(root => {
      try { return [fs.realpathSync(root)]; } catch { return []; }
    });
    const expected = roots.map(root => path.join(root, 'editor_uploads', String(port), id + extension));
    let actual;
    try { actual = fs.realpathSync(filename); } catch { throw failure('SDK_BAD_RESPONSE', 502); }
    if (!expected.includes(actual)) throw failure('SDK_BAD_RESPONSE', 502);
    const snapshot = fileSnapshot(path.dirname(actual), path.basename(actual));
    try { return readStable(snapshot); }
    finally {
      await closeEditor(port, id);
      fs.rmSync(actual, { force: true });
    }
  }
  async function open(turn, port, filePath, signal, createFamily) {
    const baseline = fileSnapshot(turn.cwd, filePath, { allowMissing: Boolean(createFamily) });
    if (createFamily && (baseline.stat || baseline.family !== createFamily)) throw failure('FILE_NOT_ALLOWED', 403);
    const key = fileKey(baseline.filename);
    const existing = filesByPath.get(key);
    if (existing) {
      if (turn.files.get(existing.id) !== existing) throw failure('FILE_BUSY', 409);
      if (existing.dirty) throw failure('UNSAVED_CHANGES', 409);
      if (!await closeEditor(existing.port, existing.id)) throw failure('CLOSE_FAILED', 502);
      forget(turn, existing);
    }
    if (turn.files.size >= MAX_EDITORS) throw failure('EDITOR_LIMIT', 409);
    assertTurn(turn, signal);
    if (!sameFile(baseline, fileSnapshot(turn.cwd, filePath, { allowMissing: Boolean(createFamily) }))) throw failure('FILE_CHANGED', 409);
    const id = `pi-office-${randomUUID()}`;
    const stage = privateStage(stagingRoot), source = path.join(stage, 'input' + baseline.extension);
    const record = { id, port, stage, snapshot: baseline, dirty: false };
    turn.files.set(id, record);
    filesByPath.set(key, record);
    let opening = false;
    try {
      const deadline = AbortSignal.timeout(CALL_TIMEOUT);
      const bytes = createFamily ? await templateBytes(port, createFamily, baseline.extension, deadline) : readStable(baseline);
      if (baseline.family === 'mind') {
        record.mindAttachments = await require('./office-mind-attachments.cjs').captureMindAttachments(bytes);
      }
      assertTurn(turn, signal);
      fs.writeFileSync(source, bytes, { flag: 'wx', mode: 0o600 });
      opening = true;
      // SDK 0.0.0.592 accepts the dispatcher file_id even though open_file does not advertise it.
      // wait makes the reply definitive and an adapter ID keeps the native preview instance separate.
      const result = await rpc(port, 'tools/call', { name: 'open_file', arguments: {
        file_path: source, file_id: id, file_type: EDITOR_TYPES[baseline.family], wait: true, open_with_existing: false, allow_shared: false,
      } }, AbortSignal.timeout(CALL_TIMEOUT), true);
      assertTurn(turn, signal, true);
      const detail = baseline.family === 'mind' ? 'tab headers pushed via /stream' : 'model ready';
      if (!confirms(result, `open completed (${EDITOR_TYPES[baseline.family]}), ${detail} for file_id=${id}`)) throw failure('SDK_BAD_RESPONSE', 502, true);
      if (!sameFile(baseline, fileSnapshot(turn.cwd, filePath, { allowMissing: Boolean(createFamily) }))) throw failure('FILE_CHANGED', 409);
      record.dirty = Boolean(createFamily);
      return { ...hideStage(result, record), structuredContent: { file_id: id, file_path: baseline.filename } };
    } catch (error) {
      if (!opening || await closeEditor(port, id)) forget(turn, record);
      else record.dirty = true;
      throw error;
    }
  }
  async function saveFile(turn, file, filePath, signal) {
    if (file.attachmentIncomplete) throw failure('ATTACHMENT_UNCONFIRMED', 409);
    const current = fileSnapshot(turn.cwd, filePath, { allowMissing: true });
    const previousKey = fileKey(file.snapshot.filename), key = fileKey(current.filename);
    const sameTarget = current.filename === file.snapshot.filename;
    if (current.extension !== file.snapshot.extension || (!sameTarget && current.stat)) throw failure('FILE_NOT_ALLOWED', 403);
    if (sameTarget && !sameFile(file.snapshot, current)) throw failure('FILE_CHANGED', 409);
    if (filesByPath.has(key) && filesByPath.get(key) !== file) throw failure('FILE_BUSY', 409);
    filesByPath.set(key, file);
    const destination = path.join(file.stage, randomUUID() + current.extension);
    try {
      // The SDK can only write in its native operational sandbox. Publish the staged result after checking the turn and source.
      const result = await rpc(file.port, 'tools/call', { name: 'save_file', arguments: { file_id: file.id, file_path: destination } },
        AbortSignal.timeout(CALL_TIMEOUT));
      assertTurn(turn, signal);
      if (!confirms(result, `File saved to: ${destination}`)) throw failure('SDK_BAD_RESPONSE', 502);
      let bytes = readStable(fileSnapshot(file.stage, destination));
      if (file.mindAttachments) {
        bytes = await require('./office-mind-attachments.cjs').embedMindAttachments(bytes, file.mindAttachments, { port: file.port });
        if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) throw failure('ASSET_LIMIT', 413);
      }
      assertTurn(turn, signal);
      file.snapshot = commitSave(current, bytes, turn.cwd);
      if (previousKey !== key) filesByPath.delete(previousKey);
      file.dirty = false;
      return { content: [{ type: 'text', text: `File saved to: ${current.filename}` }] };
    } finally {
      if (fileKey(file.snapshot.filename) !== key) filesByPath.delete(key);
      fs.rmSync(destination, { force: true });
    }
  }
  function stageAsset(turn, file, assetPath) {
    const asset = fileSnapshot(turn.cwd, assetPath, { assets: true });
    const total = (file.assetBytes ?? 0) + Number(asset.stat.size);
    if (total > MAX_FILE_BYTES) throw failure('ASSET_LIMIT', 413);
    const filename = path.join(file.stage, randomUUID() + asset.extension);
    const bytes = readStable(asset);
    if (!isRaster(bytes, asset.extension)) throw failure('FILE_NOT_ALLOWED', 403);
    fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
    file.assetBytes = total;
    return filename;
  }
  async function execute(turn, rawName, args, signal) {
    assertTurn(turn, signal);
    if (rawName === 'get_pool_status') {
      const editors = [...turn.files.values()].map(file => ({
        file_id: file.id, file_path: file.snapshot.filename, file_type: EDITOR_TYPES[file.snapshot.family], is_dirty: file.dirty,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(editors) }], structuredContent: { open_editors: editors } };
    }
    const creation = rawName.startsWith('create_') ? rawName.slice('create_'.length) : undefined;
    const opening = rawName === 'open_file' || Boolean(creation);
    const listing = rawName === 'office_catalog';
    const dispatched = ['office_read', 'office_edit'].includes(rawName);
    if (opening) fileSnapshot(turn.cwd, args.file_path, { allowMissing: Boolean(creation) });
    const file = !opening && !listing ? turn.files.get(dispatched ? args.arguments.file_id : args.file_id) : null;
    if (!opening && !listing && !file) throw failure('FILE_NOT_OPEN', 409);
    const { port, names, tools } = await ready(signal);
    assertTurn(turn, signal);
    if (listing) {
      const content = args.name ? describeTool(tools, args.name) : listFamily(tools, args.family);
      if (!content) throw failure('TOOL_UNAVAILABLE', 404);
      return { content: [{ type: 'text', text: JSON.stringify(content) }] };
    }
    if ((!dispatched && !names.has(rawName)) || (opening && (!names.has('open_file') || !names.has('close_file')))) {
      throw failure('TOOL_UNAVAILABLE', 503);
    }
    if (opening) return open(turn, port, args.file_path, signal, creation);
    if (file.port !== port) throw failure('FILE_NOT_OPEN', 409);
    if (rawName === 'save_file') return saveFile(turn, file, args.file_path, signal);
    if (rawName === 'close_file') {
      if (file.dirty) throw failure('UNSAVED_CHANGES', 409);
      if (!await closeEditor(port, file.id)) throw failure('CLOSE_FAILED', 502);
      forget(turn, file);
      return { content: [{ type: 'text', text: '已关闭本轮文档。' }] };
    }
    let name = rawName, input = args;
    const edit = rawName === 'slide_find_replace_text' || rawName === 'office_edit';
    if (dispatched) {
      name = args.name;
      ({ input } = prepareTool(tools, name, edit ? 'edit' : 'read', args.arguments, {
        invalid: () => failure('INVALID_ARGUMENTS', 400),
        validateHandle: (id, family) => {
          const target = turn.files.get(id);
          if (!target || target.port !== port || target.snapshot.family !== family) throw failure('FILE_NOT_OPEN', 409);
        },
        stageAsset: value => stageAsset(turn, file, value),
      }));
    } else if (file.snapshot.family !== 'slide') throw failure('INVALID_ARGUMENTS', 400);
    let resource, attachments;
    if (name === 'mind_add_node_attachment') {
      attachments = require('./office-mind-attachments.cjs');
      const local = fileSnapshot(turn.cwd, input.filename, { attachment: true });
      resource = await attachments.mindAttachmentResource(readStable(local), path.basename(local.filename), file.mindAttachments);
      input = { ...input, filename: resource.name, obj_key: resource.path };
    }
    if (edit) file.dirty = true;
    const deadline = AbortSignal.timeout(CALL_TIMEOUT);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let result;
    if (resource) file.attachmentIncomplete = true;
    try { result = await rpc(port, 'tools/call', { name, arguments: input }, requestSignal, edit); }
    catch (error) {
      if (resource && !error.mayHaveExecuted) file.attachmentIncomplete = false;
      throw error;
    }
    assertTurn(turn, signal, edit);
    if (resource) {
      await attachments.rememberMindAttachment(file.mindAttachments, resource, { result, nodeId: input.node_id });
      file.attachmentIncomplete = false;
    }
    if (name === 'mind_remove_node_attachment') {
      await require('./office-mind-attachments.cjs').forgetMindAttachment(file.mindAttachments, input.attachment_id);
    }
    return name === 'slide_get_info' ? documentInfo(result, file) : hideStage(result, file);
  }
  return {
    async list({ signal } = {}) { checkActive(signal); return available ? structuredClone(TOOLS) : []; },
    async call({ threadId, turnId, cwd, rawName, arguments: input, signal } = {}) {
      checkActive(signal);
      const key = turnKey(threadId, turnId);
      const args = checkedArguments(rawName, input);
      if (released.has(key)) throw failure('CANCELLED', 499);
      let turn = turns.get(key);
      if (!turn) {
        if (turns.size >= MAX_TURNS) throw failure('EDITOR_LIMIT', 409);
        turn = { cwd, files: new Map(), tail: Promise.resolve(), released: false, closing: null };
        turns.set(key, turn);
      }
      if (turn.cwd !== cwd) throw failure('INVALID_CONTEXT', 400);
      const operation = turn.tail.then(async () => {
        assertTurn(turn, signal);
        if (rawName === 'shutdown') return shutdown(signal);
        if (shuttingDown) throw failure('SHUTDOWN_BUSY', 409);
        activeOperations++;
        try { return await execute(turn, rawName, args, signal); }
        finally { activeOperations--; }
      });
      turn.tail = operation.catch(() => {});
      return operation;
    },
    async release({ threadId, turnId } = {}) {
      const key = turnKey(threadId, turnId);
      if (!await retire(key, turns.get(key))) throw failure('CLOSE_FAILED', 502);
      return { released: true };
    },
    revoke() {
      catalog = null;
      for (const [key, turn] of turns) void retire(key, turn).catch(() => {});
    },
  };
}

module.exports = { createNativeOfficeService };
