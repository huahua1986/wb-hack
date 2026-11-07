import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const DEFAULT_RECORD_LIMIT = 8 * 1024 * 1024;

export class PiRpcError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PiRpcError';
    this.code = code;
    Object.assign(this, details);
  }
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function argument(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string without NUL`);
  }
  return value;
}

function waitFor(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise.then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * A subprocess transport for the supported Pi 1.1/1.4 JSONL RPC contract.
 *
 * The caller supplies CLI arguments, including --mode rpc and any session flags.
 * Requests resolve with response.data; prompt acceptance is not run completion.
 * Subscribe to event before prompt and wait for agent_settled in the host.
 */
export class PiRpcClient extends EventEmitter {
  #child;
  #startPromise;
  #closePromise;
  #exitPromise;
  #resolveExit;
  #closing = false;
  #exited = false;
  #failure;
  #pending = new Map();
  #notifications = new Set();
  #writeTail = Promise.resolve();
  #stdoutChunks = [];
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #stderrNotice = false;
  #stderrOverflowNotice = false;
  #exitCode;
  #exitSignal;

  constructor({
    command,
    args = [],
    cwd,
    env,
    timeoutMs = 30_000,
    logger,
    maxRecordBytes = DEFAULT_RECORD_LIMIT,
    maxPendingRequests = 256,
    maxStderrBytes = 64 * 1024,
    shutdownTimeoutMs = 1_500,
    terminateTimeoutMs = 1_500,
  } = {}) {
    super();
    this.command = argument(command, 'command');
    if (!Array.isArray(args)) throw new TypeError('args must be an array');
    this.args = args.map((value, index) => argument(value, `args[${index}]`));
    this.cwd = cwd;
    this.env = env === undefined ? process.env : env;
    this.timeoutMs = positiveInteger(timeoutMs, 'timeoutMs');
    this.logger = logger;
    this.maxRecordBytes = positiveInteger(maxRecordBytes, 'maxRecordBytes');
    this.maxPendingRequests = positiveInteger(maxPendingRequests, 'maxPendingRequests');
    this.maxStderrBytes = positiveInteger(maxStderrBytes, 'maxStderrBytes');
    this.shutdownTimeoutMs = positiveInteger(shutdownTimeoutMs, 'shutdownTimeoutMs');
    this.terminateTimeoutMs = positiveInteger(terminateTimeoutMs, 'terminateTimeoutMs');
    this.#exitPromise = new Promise(resolve => { this.#resolveExit = resolve; });
  }

  get pid() { return this.#child?.pid; }
  get isRunning() { return Boolean(this.#child?.pid) && !this.#exited; }
  get diagnostics() {
    return {
      pendingRequests: this.#pending.size,
      queuedNotifications: this.#notifications.size,
      stdoutBufferedBytes: this.#stdoutBytes,
      stderrBytes: this.#stderrBytes,
      stderrLimitExceeded: this.#stderrBytes > this.maxStderrBytes,
      stderrRetainedBytes: 0,
      exitCode: this.#exitCode,
      exitSignal: this.#exitSignal,
    };
  }

  async start() {
    if (this.#closing || this.#exited) throw this.#failure ?? new PiRpcError('PI_RPC_CLOSED', 'Pi RPC client is closed');
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.command, this.args, {
          cwd: this.cwd,
          env: this.env,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        const error = new PiRpcError('PI_RPC_START_FAILED', 'Pi RPC process could not start');
        this.#fail(error);
        this.#exited = true;
        this.#resolveExit();
        reject(error);
        return;
      }
      this.#child = child;
      child.once('spawn', () => resolve(this));
      child.once('error', () => {
        const error = new PiRpcError('PI_RPC_START_FAILED', 'Pi RPC process could not start');
        this.#fail(error);
        reject(error);
      });
      child.stdin.on('error', () => {
        if (!this.#closing && !this.#exited) {
          this.#fail(new PiRpcError('PI_RPC_WRITE_FAILED', 'Pi RPC input pipe failed'));
          this.#stopAfterFailure();
        }
      });
      child.stdout.on('data', chunk => this.#readStdout(chunk));
      child.stdout.on('error', () => {
        this.#fail(new PiRpcError('PI_RPC_READ_FAILED', 'Pi RPC output pipe failed'));
        this.#stopAfterFailure();
      });
      child.stdout.once('end', () => {
        if (this.#stdoutBytes > 0 && !this.#failure) {
          this.#fail(new PiRpcError('PI_RPC_UNTERMINATED_RECORD', 'Pi RPC stdout ended without LF'));
          this.#stopAfterFailure();
        }
      });
      child.stderr.on('data', chunk => this.#readStderr(chunk));
      child.stderr.on('error', () => {
        this.#diagnostic({ kind: 'stderr_pipe_failed' });
      });
      child.once('exit', (code, signal) => {
        this.#exited = true;
        this.#exitCode = code;
        this.#exitSignal = signal;
        this.#fail(this.#failure ?? new PiRpcError(
          this.#closing ? 'PI_RPC_CLOSED' : 'PI_RPC_EXITED',
          this.#closing ? 'Pi RPC client is closed' : 'Pi RPC process exited',
          { exitCode: code, exitSignal: signal },
        ), false);
        this.#resolveExit();
        this.emit('exit', { code, signal });
      });
      // A failed spawn emits close without exit.
      child.once('close', () => {
        if (!this.#exited) {
          this.#exited = true;
          this.#resolveExit();
        }
      });
    });
    return this.#startPromise;
  }

  async request(type, fields = {}, { timeoutMs = this.timeoutMs, signal } = {}) {
    argument(type, 'type');
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new TypeError('fields must be an object');
    positiveInteger(timeoutMs, 'timeoutMs');
    if (signal?.aborted) throw new PiRpcError('PI_RPC_ABORTED', 'Pi RPC request was cancelled', { command: type });
    await this.start();
    if (this.#failure || this.#closing || this.#exited) {
      throw this.#failure ?? new PiRpcError('PI_RPC_CLOSED', 'Pi RPC client is closed');
    }
    if (signal?.aborted) throw new PiRpcError('PI_RPC_ABORTED', 'Pi RPC request was cancelled', { command: type });
    if (this.#pending.size >= this.maxPendingRequests) throw new PiRpcError('PI_RPC_PENDING_LIMIT', 'Pi RPC pending request limit exceeded');
    const id = randomUUID();
    const line = Buffer.from(`${JSON.stringify({ ...fields, id, type })}\n`, 'utf8');
    if (line.length > this.maxRecordBytes) throw new PiRpcError('PI_RPC_REQUEST_TOO_LARGE', 'Pi RPC request exceeds the record limit', { command: type });
    const result = new Promise((resolve, reject) => {
      const finish = (error, data) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(data);
      };
      const onAbort = () => finish(new PiRpcError('PI_RPC_ABORTED', 'Pi RPC request was cancelled', { command: type }));
      const timer = setTimeout(() => finish(new PiRpcError('PI_RPC_TIMEOUT', 'Pi RPC request timed out', { command: type })), timeoutMs);
      this.#pending.set(id, { type, finish });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    this.#enqueueWrite(line, () => this.#pending.has(id)).catch(() => {
      this.#pending.get(id)?.finish(new PiRpcError('PI_RPC_WRITE_FAILED', 'Pi RPC command could not be written', { command: type }));
    });
    return result;
  }

  prompt(message, { images, streamingBehavior, ...options } = {}) {
    if (typeof message !== 'string') throw new TypeError('message must be a string');
    const fields = { message };
    if (images !== undefined) fields.images = images;
    if (streamingBehavior !== undefined) fields.streamingBehavior = streamingBehavior;
    return this.request('prompt', fields, options);
  }

  abort(options) { return this.request('abort', {}, options); }
  getState(options) { return this.request('get_state', {}, options); }
  getSessionStats(options) { return this.request('get_session_stats', {}, options); }
  getAvailableModels(options) { return this.request('get_available_models', {}, options); }
  getEntries(options) { return this.request('get_entries', {}, options); }
  getAvailableThinkingLevels(options) { return this.request('get_available_thinking_levels', {}, options); }
  setThinkingLevel(level, options) { return this.request('set_thinking_level', { level }, options); }
  compact({ customInstructions, ...options } = {}) {
    return this.request('compact', customInstructions === undefined ? {} : { customInstructions }, options);
  }
  setAutoCompaction(enabled, options) { return this.request('set_auto_compaction', { enabled }, options); }
  setModel(provider, modelId, options) {
    argument(provider, 'provider'); argument(modelId, 'modelId');
    return this.request('set_model', { provider, modelId }, options);
  }

  /** Answer a Pi confirm dialog; extension responses have no command ACK. */
  async sendExtensionUiResponse(response) {
    if (!response || typeof response !== 'object' || Array.isArray(response)
      || Object.keys(response).some(key => !['id', 'confirmed', 'value'].includes(key))
      || typeof response.id !== 'string' || response.id.length < 1 || response.id.length > 256
      || response.id.trim() !== response.id || /[\u0000-\u001f\u007f]/u.test(response.id)
      || !(typeof response.confirmed === 'boolean' && !Object.hasOwn(response, 'value')
        || typeof response.value === 'string' && Buffer.byteLength(response.value) <= 512 * 1024 && !Object.hasOwn(response, 'confirmed'))) {
      throw new TypeError('Pi UI response requires a valid id and either a boolean confirmed or a bounded string value');
    }
    await this.start();
    if (this.#failure || this.#closing || this.#exited) {
      throw this.#failure ?? new PiRpcError('PI_RPC_CLOSED', 'Pi RPC client is closed');
    }
    if (this.#notifications.size >= this.maxPendingRequests) {
      throw new PiRpcError('PI_RPC_PENDING_LIMIT', 'Pi RPC queued notification limit exceeded');
    }
    const line = Buffer.from(`${JSON.stringify({
      type: 'extension_ui_response', ...response,
    })}\n`, 'utf8');
    if (line.length > this.maxRecordBytes) {
      throw new PiRpcError('PI_RPC_REQUEST_TOO_LARGE', 'Pi RPC response exceeds the record limit');
    }
    return new Promise((resolve, reject) => {
      const finish = error => {
        if (!this.#notifications.delete(finish)) return;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new PiRpcError('PI_RPC_TIMEOUT', 'Pi RPC response write timed out')), this.timeoutMs);
      this.#notifications.add(finish);
      this.#enqueueWrite(line, () => this.#notifications.has(finish)).then(
        () => finish(),
        () => finish(this.#failure ?? new PiRpcError('PI_RPC_WRITE_FAILED', 'Pi RPC response could not be written')),
      );
    });
  }

  async close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#fail(new PiRpcError('PI_RPC_CLOSED', 'Pi RPC client is closed'), false);
    this.#closePromise = (async () => {
      if (!this.#child) {
        this.#exited = true;
        this.#resolveExit();
        return;
      }
      if (this.#exited) return;
      this.#child.stdin.end();
      if (await waitFor(this.#exitPromise, this.shutdownTimeoutMs)) return;
      this.#diagnostic({ kind: 'shutdown_signal', signal: 'SIGTERM' });
      this.#child.kill('SIGTERM');
      if (await waitFor(this.#exitPromise, this.terminateTimeoutMs)) return;
      throw new PiRpcError('PI_RPC_CLOSE_TIMEOUT', 'Pi RPC process did not exit after SIGTERM');
    })();
    return this.#closePromise;
  }

  #readStdout(chunk) {
    if (this.#failure) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const fragment = chunk.subarray(offset, end);
      if (this.#stdoutBytes + fragment.length > this.maxRecordBytes) {
        this.#fail(new PiRpcError('PI_RPC_RECORD_TOO_LARGE', 'Pi RPC stdout record exceeds the limit'));
        this.#stopAfterFailure();
        return;
      }
      if (fragment.length) {
        this.#stdoutChunks.push(fragment);
        this.#stdoutBytes += fragment.length;
      }
      if (newline === -1) return;
      let bytes = Buffer.concat(this.#stdoutChunks, this.#stdoutBytes);
      this.#stdoutChunks = [];
      this.#stdoutBytes = 0;
      if (bytes.at(-1) === 13) bytes = bytes.subarray(0, -1);
      let record;
      try {
        record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.type !== 'string') throw new Error('invalid record');
        if (record.type === 'response' && (typeof record.success !== 'boolean' || typeof record.command !== 'string')) throw new Error('invalid response');
        const expected = typeof record.id === 'string' ? this.#pending.get(record.id) : undefined;
        if (record.type === 'response' && expected && record.command !== expected.type) throw new Error('response command mismatch');
      } catch {
        this.#fail(new PiRpcError('PI_RPC_INVALID_RECORD', 'Pi RPC stdout contains an invalid JSON record'));
        this.#stopAfterFailure();
        return;
      }
      this.#record(record);
      if (this.#failure) return;
      offset = newline + 1;
    }
  }

  #enqueueWrite(line, isActive) {
    // Both command requests and one-way dialog responses share this backpressure queue.
    const write = this.#writeTail.then(() => {
      if (!isActive()) return;
      if (this.#failure || this.#closing || this.#exited) {
        throw this.#failure ?? new PiRpcError('PI_RPC_CLOSED', 'Pi RPC client is closed');
      }
      return new Promise((resolve, reject) => {
        this.#child.stdin.write(line, error => {
          if (error) reject(new PiRpcError('PI_RPC_WRITE_FAILED', 'Pi RPC input write failed'));
          else resolve();
        });
      });
    });
    this.#writeTail = write.catch(() => {});
    return write;
  }

  #record(record) {
    if (record.type !== 'response') {
      this.emit('event', record);
      return;
    }
    const pending = typeof record.id === 'string' ? this.#pending.get(record.id) : undefined;
    if (!pending) {
      this.#diagnostic({ kind: 'unmatched_response' });
      return;
    }
    if (record.success) pending.finish(undefined, record.data);
    else pending.finish(new PiRpcError('PI_RPC_COMMAND_FAILED', 'Pi RPC command failed', { command: pending.type }));
  }

  #readStderr(chunk) {
    // Never retain or forward stderr: it can contain prompts, provider URLs or keys.
    this.#stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, this.#stderrBytes + chunk.length);
    if (!this.#stderrNotice) {
      this.#stderrNotice = true;
      this.#diagnostic({ kind: 'stderr_redacted', retainedBytes: 0 });
    }
    if (this.#stderrBytes > this.maxStderrBytes && !this.#stderrOverflowNotice) {
      this.#stderrOverflowNotice = true;
      this.#diagnostic({ kind: 'stderr_limit_exceeded', limitBytes: this.maxStderrBytes, retainedBytes: 0 });
    }
  }

  #diagnostic(entry) {
    try {
      if (typeof this.logger === 'function') this.logger(entry);
      else this.logger?.warn?.(entry);
    } catch { /* Logging must not interrupt pipe consumption. */ }
    this.emit('diagnostic', entry);
  }

  #fail(error, notify = true) {
    let first = false;
    if (!this.#failure) {
      this.#failure = error;
      first = true;
    }
    this.#stdoutChunks = [];
    this.#stdoutBytes = 0;
    for (const { finish } of this.#pending.values()) finish(error);
    for (const finish of this.#notifications) finish(error);
    if (first && notify) this.emit('failure', error);
  }

  #stopAfterFailure() {
    this.close().catch(error => this.#diagnostic({ kind: 'shutdown_failed', code: error.code }));
  }
}
