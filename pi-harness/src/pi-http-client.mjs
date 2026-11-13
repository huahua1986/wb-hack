import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PiRpcError } from './pi-rpc.mjs';
import { SSH_PI_THREAD_ID } from './ssh-pi.mjs';

const MODES = new Set(['text', 'office', 'fileOffice']);
const MAX_RECORD = 8 * 1024 * 1024;
export const MAX_PI_HTTP_DOCX_BYTES = 8 * 1024 * 1024;
const MAX_CONTROL_RESPONSE = 256 * 1024;
const MAX_RPC_REQUEST = 1024 * 1024;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOCUMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,91}\.docx$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function httpsOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) throw Error('Pi HTTPS endpoint requires an origin');
  let url;
  try { url = new URL(value); }
  catch { throw Error('Invalid Pi HTTPS endpoint'); }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw Error('Pi HTTPS endpoint requires an HTTPS origin without credentials');
  }
  return url.origin;
}

function readPrivateFile(filename, maxBytes, privateMode) {
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes || (stat.mode & privateMode)
      || (privateMode === 0o077 && (stat.nlink !== 1 || process.getuid && stat.uid !== process.getuid()))) {
      throw Error('Pi HTTPS credential or CA file has unsafe permissions or size');
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length);
      if (!read) break;
      length += read;
    }
    const after = fstatSync(fd);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw Error('Pi HTTPS credential or CA file changed while reading');
    }
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

export function normalizeHttpPi(value, base = process.cwd()) {
  if (!object(value) || Object.keys(value).some(key => !['url', 'tokenFile', 'caFile', 'mode'].includes(key))
    || (value.mode !== undefined && !MODES.has(value.mode))) throw Error('Invalid Pi HTTPS configuration');
  const result = { url: httpsOrigin(value.url), mode: value.mode ?? 'text' };
  for (const [field, limit, mode] of [['tokenFile', 1024, 0o077], ['caFile', 256 * 1024, 0o022]]) {
    if (field === 'caFile' && value[field] === undefined) continue;
    const filename = value[field];
    if (typeof filename !== 'string' || !filename.trim() || /[\x00-\x1f\x7f]/.test(filename)) {
      throw Error(`Pi HTTPS configuration requires a valid ${field}`);
    }
    result[field] = resolve(base, filename.replace(/^~\//, homedir() + '/'));
    readPrivateFile(result[field], limit, mode);
  }
  return result;
}

function failure(code, message, status) {
  return new PiRpcError(code, message, status === undefined ? {} : { status });
}

export function isPiHttpDocxName(name) {
  return typeof name === 'string' && DOCUMENT_NAME.test(name) && !name.includes('..');
}

function validateFileName(name) {
  if (!isPiHttpDocxName(name)) throw Error('Invalid remote Pi DOCX filename');
  return name;
}

function validateFile(file, name = file?.name) {
  if (!object(file) || file.name !== validateFileName(name) || !Number.isSafeInteger(file.size)
    || file.size < 1 || file.size > MAX_PI_HTTP_DOCX_BYTES || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)
    || (file.kind !== undefined && !['input', 'output'].includes(file.kind))) {
    throw Error('Invalid remote Pi file metadata');
  }
  return { name, size: file.size, sha256: file.sha256, ...(file.kind ? { kind: file.kind } : {}) };
}

/** Pi JSONL RPC over authenticated HTTPS requests and an independent SSE stream. */
export class PiHttpClient extends EventEmitter {
  #origin;
  #requestImpl;
  #headers;
  #ca;
  #basePath;
  #mode;
  #epoch;
  #cursor = 0;
  #start;
  #close;
  #closing = false;
  #terminal;
  #remoteExited = false;
  #exit;
  #finishExit;
  #stream = new AbortController();
  #pending = new Map();
  #writeTail = Promise.resolve();

  constructor({ url, tokenFile, caFile, threadId, office = false, mode = office ? 'office' : 'text',
    timeoutMs = 30_000, requestImpl = httpsRequest } = {}) {
    super();
    if (typeof threadId !== 'string' || !SSH_PI_THREAD_ID.test(threadId) || !MODES.has(mode)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || typeof requestImpl !== 'function') throw Error('Invalid Pi HTTPS client configuration');
    this.#origin = httpsOrigin(url);
    this.#requestImpl = requestImpl;
    const token = readPrivateFile(tokenFile, 1024, 0o077).toString('utf8').trim();
    if (!/^[A-Za-z0-9._~-]{32,512}$/.test(token)) throw Error('Invalid Pi HTTPS bearer credential');
    this.#headers = { authorization: 'Bearer ' + token };
    this.#ca = caFile ? readPrivateFile(caFile, 256 * 1024, 0o022) : undefined;
    this.#basePath = '/v1/pi/threads/' + threadId;
    this.#mode = mode;
    this.timeoutMs = timeoutMs;
    this.#exit = new Promise(resolve => { this.#finishExit = resolve; });
  }

  get isRunning() { return Boolean(this.#epoch && !this.#terminal); }

  async start() {
    if (this.#closing || this.#terminal) throw this.#terminal ?? failure('PI_RPC_CLOSED', 'Pi HTTPS client is closed');
    this.#start ??= this.#open();
    return this.#start;
  }

  async #open() {
    const { data } = await this.#json('POST', '/open', { mode: this.#mode });
    if (data.threadId !== this.#basePath.split('/').at(-1) || !EPOCH.test(data.epoch)
      || data.mode !== this.#mode || !Number.isSafeInteger(data.cursor ?? 0) || (data.cursor ?? 0) < 0) {
      throw failure('PI_HTTP_INVALID_RESPONSE', 'Pi HTTPS returned invalid session information');
    }
    this.#epoch = data.epoch;
    this.#cursor = data.cursor ?? 0;
    let connected, disconnected;
    const ready = new Promise((resolve, reject) => { connected = resolve; disconnected = reject; });
    void this.#listen(connected).catch(error => {
      disconnected(error);
      this.#terminate(error, true);
    });
    await ready;
    return this;
  }

  async #listen(connected) {
    const signal = this.#stream.signal;
    let retryFrom = Date.now(), retryDelay = 100;
    while (!signal.aborted) {
      let openedAt;
      const before = this.#cursor;
      try {
        const response = await this.#send('GET', `/events?epoch=${this.#epoch}&after=${this.#cursor}`, {
          signal, inactivityMs: 35_000, headers: { accept: 'text/event-stream', 'last-event-id': String(this.#cursor) },
        });
        if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers['content-type'] ?? '')) {
          response.destroy();
          throw failure('PI_HTTP_INVALID_RESPONSE', 'Pi HTTPS did not provide an SSE stream');
        }
        openedAt = Date.now();
        connected();
        await this.#readSse(response, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (this.#closing && ['PI_THREAD_NOT_OPEN', 'STALE_PI_EPOCH'].includes(error?.remoteCode)) {
          this.#remoteExited = true;
          this.#finishExit();
          this.#terminate(failure('PI_RPC_CLOSED', 'Pi HTTPS worker is closed'), false);
          return;
        }
        if (error.code !== 'PI_HTTP_NETWORK' && error.code !== 'PI_HTTP_TIMEOUT'
          && ![502, 503, 504].includes(error.status)) throw error;
      }
      if (this.#cursor !== before || openedAt && Date.now() - openedAt >= 1000) {
        retryFrom = Date.now();
        retryDelay = 100;
      }
      if (Date.now() - retryFrom >= this.timeoutMs) {
        throw failure('PI_HTTP_DISCONNECTED', 'Pi HTTPS event stream could not be resumed');
      }
      await delay(retryDelay, undefined, { signal });
      retryDelay = Math.min(1000, retryDelay * 2);
    }
  }

  async #readSse(response, signal) {
    let parts = [], bytes = 0, id, data;
    const decoder = new TextDecoder('utf8', { fatal: true });
    try {
      for await (const chunk of response) {
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline;
          const slice = chunk.subarray(offset, end);
          bytes += slice.length;
          if (bytes > MAX_RECORD + 64) throw failure('PI_RPC_RECORD_TOO_LARGE', 'Pi HTTPS event exceeds the record limit');
          if (slice.length) parts.push(slice);
          if (newline < 0) break;
          const line = decoder.decode(Buffer.concat(parts, bytes)).replace(/\r$/, '');
          parts = []; bytes = 0; offset = newline + 1;
          if (!line) {
            if (data !== undefined) this.#event(id, data);
            if (signal.aborted || this.#remoteExited) return;
            id = undefined; data = undefined;
          } else if (line.startsWith('id:')) {
            id = line.slice(3).trim();
          } else if (line.startsWith('data:')) {
            if (data !== undefined) throw failure('PI_HTTP_INVALID_RESPONSE', 'Pi HTTPS SSE event contains multiple records');
            data = line.slice(5).trimStart();
          }
        }
      }
    } catch (error) {
      if (error instanceof PiRpcError) throw error;
      if (error?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
        throw failure('PI_HTTP_INVALID_RESPONSE', 'Pi HTTPS SSE event contains invalid text');
      }
      throw failure('PI_HTTP_NETWORK', 'Pi HTTPS event stream was interrupted');
    } finally {
      response.destroy();
    }
  }

  #event(id, data) {
    const sequence = Number(id);
    if (!/^[1-9][0-9]*$/.test(id ?? '') || !Number.isSafeInteger(sequence)) {
      throw failure('PI_HTTP_INVALID_RESPONSE', 'Pi HTTPS event is missing its sequence number');
    }
    if (sequence <= this.#cursor) return;
    if (sequence !== this.#cursor + 1) throw failure('PI_HTTP_EVENT_GAP', 'Pi HTTPS events are missing');
    let record;
    try { record = JSON.parse(data); } catch { /* The protocol error below contains no payload. */ }
    if (!object(record) || typeof record.type !== 'string'
      || (record.type === 'response' && (typeof record.command !== 'string' || typeof record.success !== 'boolean'))) {
      throw failure('PI_RPC_INVALID_RECORD', 'Pi HTTPS returned an invalid RPC record');
    }
    this.#cursor = sequence;
    if (record.type === 'workbuddy_transport_closed') {
      this.#remoteExited = true;
      this.#finishExit();
      this.#terminate(failure('PI_RPC_EXITED', 'Remote Pi worker has exited'), !this.#closing, record.code);
    } else if (record.type === 'response') {
      const pending = this.#pending.get(record.id);
      if (!pending) return;
      if (record.command !== pending.type) throw failure('PI_RPC_INVALID_RECORD', 'Pi HTTPS returned a mismatched RPC response');
      if (record.success) pending.finish(null, record.data);
      else pending.finish(failure('PI_RPC_COMMAND_FAILED', 'Pi HTTPS RPC command failed'));
    } else if (!this.#terminal) {
      try { this.emit('event', record); }
      catch { throw failure('PI_HTTP_EVENT_DELIVERY', 'Pi HTTPS event could not be applied'); }
    }
  }

  #terminate(error, notify, code) {
    if (this.#terminal) return;
    this.#terminal = error;
    this.#stream.abort();
    for (const { finish } of this.#pending.values()) finish(error);
    if (notify) {
      this.emit('failure', error);
      this.emit('exit', { code, signal: null });
    }
  }

  #send(method, suffix, { body, headers = {}, signal, inactivityMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      let headersDeadline;
      const request = this.#requestImpl(this.#origin + this.#basePath + suffix, {
        method, agent: false, ca: this.#ca, signal, rejectUnauthorized: true,
        headers: {
          ...this.#headers, ...(this.#epoch ? { 'x-pi-epoch': this.#epoch } : {}),
          ...(body ? { 'content-length': body.length } : {}), ...headers,
        },
      }, response => {
        clearTimeout(headersDeadline);
        const status = response.statusCode;
        if (status < 200 || status >= 300) {
          const error = failure('PI_HTTP_STATUS', `Pi HTTPS request returned HTTP ${status}`, status);
          void this.#body(response, 4096).then(bytes => {
            try {
              const code = JSON.parse(bytes.toString('utf8'))?.error?.code;
              // Only recognize fixed protocol codes. Never expose upstream error text.
              if (['PI_THREAD_NOT_OPEN', 'STALE_PI_EPOCH'].includes(code)) error.remoteCode = code;
            } catch { /* An intermediary may return a non-JSON error body. */ }
            reject(error);
          }, () => reject(error));
        } else {
          resolve(response);
        }
      });
      request.once('error', error => {
        clearTimeout(headersDeadline);
        const tlsError = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(error.code ?? '');
        reject(failure(tlsError ? 'PI_HTTP_TLS' : 'PI_HTTP_NETWORK',
          tlsError ? 'Pi HTTPS certificate validation failed' : 'Pi HTTPS connection failed'));
      });
      request.setTimeout(inactivityMs, () => {
        reject(failure('PI_HTTP_TIMEOUT', 'Pi HTTPS request timed out'));
        request.destroy();
      });
      headersDeadline = setTimeout(() => {
        reject(failure('PI_HTTP_TIMEOUT', 'Pi HTTPS response headers timed out'));
        request.destroy();
      }, Math.min(8000, this.timeoutMs));
      headersDeadline.unref();
      request.end(body);
    });
  }

  async #body(response, limit) {
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of response) {
        size += chunk.length;
        if (size > limit) throw failure('PI_HTTP_BODY_LIMIT', 'Pi HTTPS response exceeds the size limit');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      if (error instanceof PiRpcError) throw error;
      throw failure('PI_HTTP_NETWORK', 'Pi HTTPS response was interrupted');
    } finally {
      response.destroy();
    }
  }

  async #json(method, suffix, value, signal = AbortSignal.timeout(this.timeoutMs)) {
    const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
    if (body?.length > MAX_RPC_REQUEST) throw failure('PI_RPC_REQUEST_TOO_LARGE', 'Pi HTTPS request exceeds the record limit');
    const response = await this.#send(method, suffix, {
      body, signal, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    });
    const bytes = await this.#body(response, MAX_CONTROL_RESPONSE);
    let data;
    try { data = JSON.parse(bytes.toString('utf8')); } catch { /* No payload in the protocol error. */ }
    if (!object(data)) throw failure('PI_HTTP_INVALID_RESPONSE', 'Pi HTTPS returned invalid control data');
    return { data, status: response.statusCode };
  }

  #write(record, signal) {
    const send = this.#writeTail.then(async () => {
      signal.throwIfAborted();
      if (this.#closing || this.#terminal) throw this.#terminal ?? failure('PI_RPC_CLOSED', 'Pi HTTPS client is closed');
      for (let attempt = 0; ; attempt++) {
        try {
          const { data, status } = await this.#json('POST', '/rpc', record, signal);
          if (status !== 202 || data.accepted !== true) throw failure('PI_HTTP_INVALID_RESPONSE', 'Pi HTTPS RPC was not acknowledged');
          return;
        } catch (error) {
          // An uncertain HTTP write may already be accepted. The server deduplicates the same record ID.
          if (attempt || signal.aborted || !['PI_HTTP_NETWORK', 'PI_HTTP_TIMEOUT'].includes(error.code)) throw error;
        }
      }
    });
    this.#writeTail = send.catch(() => {});
    return send;
  }

  async request(type, fields = {}, { timeoutMs = this.timeoutMs, signal } = {}) {
    if (typeof type !== 'string' || !type || !object(fields) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw TypeError('Invalid Pi HTTPS RPC command');
    }
    if (signal?.aborted) throw failure('PI_RPC_ABORTED', 'Pi HTTPS RPC wait was cancelled');
    await this.start();
    if (signal?.aborted) throw failure('PI_RPC_ABORTED', 'Pi HTTPS RPC wait was cancelled');
    if (this.#closing || this.#terminal) throw this.#terminal ?? failure('PI_RPC_CLOSED', 'Pi HTTPS client is closed');
    if (this.#pending.size >= 256) throw failure('PI_RPC_PENDING_LIMIT', 'Pi HTTPS pending command limit exceeded');
    const id = randomUUID();
    const deadline = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    return new Promise((resolve, reject) => {
      const finish = (error, data) => {
        if (!this.#pending.delete(id)) return;
        requestSignal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(data);
      };
      const abort = () => finish(signal?.aborted ? failure('PI_RPC_ABORTED', 'Pi HTTPS RPC wait was cancelled')
        : failure('PI_RPC_TIMEOUT', 'Pi HTTPS RPC command timed out'));
      this.#pending.set(id, { type, finish });
      requestSignal.addEventListener('abort', abort, { once: true });
      this.#write({ ...fields, id, type }, requestSignal).catch(finish);
    });
  }

  prompt(message, { images, streamingBehavior, ...options } = {}) {
    if (typeof message !== 'string') throw TypeError('message must be a string');
    return this.request('prompt', { message, ...(images === undefined ? {} : { images }),
      ...(streamingBehavior === undefined ? {} : { streamingBehavior }) }, options);
  }

  abort(options) { return this.request('abort', {}, options); }
  getState(options) { return this.request('get_state', {}, options); }
  getSessionStats(options) { return this.request('get_session_stats', {}, options); }

  async sendExtensionUiResponse(response) {
    if (!object(response) || typeof response.id !== 'string' || !response.id.trim() || response.id.length > 128
      || Object.keys(response).some(key => !['id', 'confirmed', 'value'].includes(key))
      || !(typeof response.confirmed === 'boolean' && !Object.hasOwn(response, 'value')
        || typeof response.value === 'string' && !Object.hasOwn(response, 'confirmed') && Buffer.byteLength(response.value) <= 512 * 1024)) {
      throw TypeError('Invalid Pi HTTPS extension response');
    }
    await this.start();
    return this.#write({ type: 'extension_ui_response', ...response }, AbortSignal.timeout(this.timeoutMs));
  }

  async #fileSignal(signal) {
    if (this.#mode !== 'fileOffice') throw Error('Pi HTTPS file operations require fileOffice mode');
    signal?.throwIfAborted();
    await this.start();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    return signal ? AbortSignal.any([signal, deadline]) : deadline;
  }

  async putFile(name, bytes, { signal } = {}) {
    validateFileName(name);
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_PI_HTTP_DOCX_BYTES) throw Error('Invalid Pi HTTPS DOCX upload');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const response = await this.#send('PUT', '/files/' + encodeURIComponent(name), {
      body: bytes, signal: await this.#fileSignal(signal), headers: { 'content-type': DOCX_MIME, 'x-content-sha256': sha256 },
    });
    const raw = await this.#body(response, MAX_CONTROL_RESPONSE);
    const entry = validateFile(JSON.parse(raw.toString('utf8')).file, name);
    if (![200, 201].includes(response.statusCode) || entry.size !== bytes.length || entry.sha256 !== sha256) {
      throw Error('Pi HTTPS upload integrity check failed');
    }
    return entry;
  }

  async listFiles({ signal } = {}) {
    const { data } = await this.#json('GET', '/files', undefined, await this.#fileSignal(signal));
    if (!Array.isArray(data.files) || data.files.length > 16) throw Error('Invalid remote Pi file manifest');
    return data.files.map(file => validateFile(file));
  }

  async getFile(name, { signal } = {}) {
    validateFileName(name);
    const response = await this.#send('GET', '/files/' + encodeURIComponent(name), { signal: await this.#fileSignal(signal) });
    const size = Number(response.headers['content-length']);
    const sha256 = response.headers['x-content-sha256'];
    if (response.headers['content-type'] !== DOCX_MIME || !Number.isSafeInteger(size) || size < 1 || size > MAX_PI_HTTP_DOCX_BYTES
      || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
      response.destroy();
      throw Error('Invalid Pi HTTPS download metadata');
    }
    const bytes = await this.#body(response, size);
    if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== sha256) {
      throw Error('Pi HTTPS download integrity check failed');
    }
    return bytes;
  }

  async close() {
    if (this.#close) return this.#close;
    this.#closing = true;
    this.#close = (async () => {
      try {
        await this.#start?.catch(() => {});
        if (!this.#epoch || this.#remoteExited) return;
        const deadline = AbortSignal.timeout(5000);
        try {
          const { data, status } = await this.#json('POST', '/close', {}, deadline);
          if (status !== 202 || data.accepted !== true) throw failure('PI_HTTP_INVALID_RESPONSE', 'Pi HTTPS close was not acknowledged');
        }
        catch (error) {
          if (!['PI_THREAD_NOT_OPEN', 'STALE_PI_EPOCH'].includes(error.remoteCode)) throw error;
          return;
        }
        if (this.#stream.signal.aborted && !this.#remoteExited) {
          const response = await this.#send('GET', `/events?epoch=${this.#epoch}&after=${this.#cursor}`, {
            signal: deadline, headers: { accept: 'text/event-stream', 'last-event-id': String(this.#cursor) },
          });
          await this.#readSse(response, deadline);
        }
        let abort;
        try {
          await Promise.race([this.#exit, new Promise((_, reject) => {
            abort = () => reject(failure('PI_RPC_CLOSE_TIMEOUT', 'Remote Pi closure was not confirmed'));
            if (deadline.aborted) abort();
            else deadline.addEventListener('abort', abort, { once: true });
          })]);
        } finally { deadline.removeEventListener('abort', abort); }
      } finally {
        this.#terminate(failure('PI_RPC_CLOSED', 'Pi HTTPS client is closed'), false);
      }
    })();
    return this.#close;
  }
}
