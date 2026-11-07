'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');

let sdkPromise;
async function loadSdk() {
  if (!sdkPromise) sdkPromise = import(pathToFileURL(path.join(__dirname, 'official-aicc-sdk.mjs')).href).then(chunk => {
    const exports = {};
    const imports = { 76982: 'node:crypto', 39023: 'node:util', 58611: 'node:http', 65692: 'node:https' };
    function moduleRequire(id) { if (!imports[id]) throw Error('Unexpected AICC SDK dependency'); return require(imports[id]); }
    moduleRequire.r = value => Object.defineProperty(value, '__esModule', { value: true });
    moduleRequire.d = (value, getters) => { for (const [key, get] of Object.entries(getters)) Object.defineProperty(value, key, { enumerable: true, get }); };
    chunk.__webpack_modules__[66554]({ exports }, exports, moduleRequire);
    // The vendor SDK's debug mode can disclose cryptographic material.
    exports.setAiccDebug(false); exports.setAiccVerify(false);
    exports.setLogger({ debugf() {}, infof() {}, errorf() {} }); exports.setLogLevel(exports.LogLevel.ERROR);
    return exports;
  });
  return sdkPromise;
}

function protocolError(code) { return Object.assign(Error(code), { code, status: 502 }); }
function leaves(value, parts, result = []) {
  if (!parts.length) { if (typeof value === 'string') result.push(value); }
  else if (Array.isArray(value)) for (const item of value) leaves(item, parts, result);
  else if (value && typeof value === 'object') leaves(value[parts[0]], parts.slice(1), result);
  return result;
}
function checkProtected(before, after, paths) {
  let protectedLeaves = 0;
  for (const rule of paths) {
    const a = leaves(before, rule.split('.')), b = leaves(after, rule.split('.'));
    for (let i = 0; i < a.length; i++) if (a[i]) {
      if (b[i] === undefined || b[i] === a[i]) throw protocolError('AICC_RESPONSE_PLAINTEXT');
      protectedLeaves++;
    }
  }
  return protectedLeaves;
}

class AiccSseTransform extends Transform {
  constructor(request, policy) {
    super(); this.decoder = new StringDecoder('utf8'); this.pending = ''; this.request = request;
    this.policy = policy; this.decryptor = request.newStreamDecryptor(); this.protectedLeaves = 0;
  }
  event(frame) {
    const lines = frame.split(/\r?\n/), data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) { this.push(frame + '\n\n'); return; }
    if (data === '[DONE]') { this.assertFinished(); this.push('data: [DONE]\n\n'); return; }
    let original;
    try { original = JSON.parse(data); } catch { throw protocolError('AICC_RESPONSE_INVALID_JSON'); }
    // Usage-only events are outside the protected choices paths.
    if (!Array.isArray(original.choices) || !original.choices.length) { this.push(frame + '\n\n'); return; }
    const [decoded] = this.decryptor.decryptEvent(Buffer.from(data), this.policy);
    if (decoded === null) return;
    let plain;
    try { plain = JSON.parse(decoded.toString('utf8')); } catch { throw protocolError('AICC_RESPONSE_DECRYPT_FAILED'); }
    this.protectedLeaves += checkProtected(original, plain, this.policy.streamPaths);
    const metadata = lines.filter(line => !line.startsWith('data:')).join('\n');
    this.push((metadata ? metadata + '\n' : '') + 'data: ' + JSON.stringify(plain) + '\n\n');
  }
  assertFinished() {
    if (this.protectedLeaves && this.request.mode === 1 && !this.decryptor.finished) throw protocolError('AICC_STREAM_TRUNCATED');
  }
  consume() {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.pending); if (!match) break;
      const frame = this.pending.slice(0, match.index); this.pending = this.pending.slice(match.index + match[0].length); this.event(frame);
    }
    if (Buffer.byteLength(this.pending) > 4 * 1024 * 1024) throw protocolError('AICC_EVENT_TOO_LARGE');
  }
  _transform(chunk, encoding, callback) { try { this.pending += this.decoder.write(chunk); this.consume(); callback(); } catch (error) { callback(error); } }
  _flush(callback) { try { this.pending += this.decoder.end(); this.consume(); if (this.pending.trim()) this.event(this.pending); this.assertFinished(); callback(); } catch (error) { callback(error); } }
}

function createAiccTransport({ restOperations, authenticationManager, trustedControlUrl, loadSdkImpl = loadSdk }) {
  const context = new AsyncLocalStorage(); let poolPromise, closed = false;
  async function pool() {
    if (closed) throw protocolError('AICC_CLOSED');
    return poolPromise ||= loadSdkImpl().then(sdk => {
      const transport = async request => {
        const headers = Object.fromEntries(Object.entries(request.header || {}).filter(([name]) => name.toLowerCase() !== 'authorization'));
        const send = async () => {
          if (authenticationManager) await authenticationManager.waitForSessionRefresh();
          return restOperations.request({ url: trustedControlUrl(), method: 'POST', data: request.body, headers,
            signal: context.getStore()?.signal, responseType: 'arraybuffer', timeout: 15000, maxRedirects: 0,
            validateStatus: () => true, maxBodyLength: 1048576, maxContentLength: 1048576 });
        };
        let response = await send();
        if (response.status === 401 && authenticationManager && !context.getStore()?.signal?.aborted) {
          await authenticationManager.refreshSessionForAuthenticationFailure(); response = await send();
        }
        const body = Buffer.isBuffer(response.data) ? response.data : typeof response.data === 'string' ? Buffer.from(response.data) : Buffer.from(JSON.stringify(response.data));
        return { statusCode: response.status, body };
      };
      const endpoint = 'https://aicc.invalid/v1/aicc';
      const instance = new sdk.ModelPool(endpoint, '', 300, () => new sdk.SessionPool(new sdk.SessionFactory(endpoint, null)
        .setTransport(transport).setProtocol(sdk.WireProtocol.OPENAI_CHAT_COMPLETIONS).setMode(sdk.Mode.COMPATIBLE), 2)).setTransport(transport);
      if (closed) instance.close();
      return { sdk, instance, policy: sdk.defaultPolicy(sdk.Protocol.OPENAI) };
    }).catch(error => { poolPromise = undefined; throw error; });
  }
  return {
    async prepare(model, body, signal) {
      const { instance, policy } = await pool(); signal?.throwIfAborted();
      const request = await context.run({ signal }, () => instance.newRequest(model.id, null));
      if (signal?.aborted) { request.close(); signal.throwIfAborted(); }
      try {
        const plain = Buffer.from(JSON.stringify(body)), encrypted = request.encryptRequest(plain, policy);
        if (plain.equals(encrypted)) throw protocolError('AICC_REQUEST_NOT_PROTECTED');
        return { body: JSON.parse(encrypted.toString('utf8')), headers: { 'X-AICC-Mode': '1', 'X-AICC-Endpoint': request.endpoint() },
          transform: () => new AiccSseTransform(request, policy),
          decode(data) { const before = typeof data === 'string' ? JSON.parse(data) : data;
            const after = JSON.parse(request.decryptResponse(Buffer.from(JSON.stringify(before)), policy).toString('utf8'));
            checkProtected(before, after, policy.responsePaths); return after; },
          close: () => request.close() };
      } catch (error) { request.close(); throw error; }
    },
    close() { closed = true; poolPromise?.then(value => value.instance.close()).catch(() => {}); poolPromise = undefined; },
  };
}

module.exports = { createAiccTransport, AiccSseTransform, checkProtected, loadSdk };
