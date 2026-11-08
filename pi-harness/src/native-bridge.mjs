import { readOfficialLocator } from './official-bridge.mjs';

const OFFICE_CONNECTOR = 'builtin-office:editor-sdk';
const OFFICE_HEADER = 'x-workbuddy-pi-office';

async function readResponse(response, limit) {
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > limit) throw Error('MCP 响应超过大小限制。');
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (cause) { await reader.cancel().catch(() => {}); throw cause; }
  finally { reader.releaseLock(); }
}

export class NativeBridgeClient {
  #officeSecret;

  constructor(directory, { fetchImpl = globalThis.fetch, officeSecret = process.env.WORKBUDDY_PI_OFFICE_SECRET } = {}) {
    this.directory = directory; this.fetch = fetchImpl; this.#officeSecret = officeSecret;
  }
  async request(operation, params) {
    if (!['list', 'call', 'release'].includes(operation)) throw Error('不支持的 MCP 桥操作。');
    const { signal, ...body } = params;
    const officeCall = operation === 'call' && body.serverId === OFFICE_CONNECTOR;
    const officeSelected = officeCall || operation === 'release'
      || (operation === 'list' && Array.isArray(body.connectors) && body.connectors.includes(OFFICE_CONNECTOR));
    const locator = readOfficialLocator(this.directory);
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text) > 64 * 1024) throw Error('MCP 请求参数过大。');
    let response;
    try { response = await this.fetch(`http://127.0.0.1:${locator.port}/v1/native/mcp/${operation}`, {
      method: 'POST', headers: { Authorization: `Bearer ${locator.ticket}`, 'Content-Type': 'application/json',
        ...(officeSelected && this.#officeSecret ? { [OFFICE_HEADER]: this.#officeSecret } : {}) },
      body: text, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(operation === 'call' ? 120_000 : 15_000)]), redirect: 'error',
    }); } catch {
      throw Object.assign(Error('WorkBuddy MCP 连接中断；调用结果可能尚未确认。'), { code: 'NATIVE_MCP_UNAVAILABLE', mayHaveExecuted: operation === 'call' });
    }
    // Never replay a tool call after timeout, ticket rotation or login changes.
    if (!response.ok) {
      if (officeSelected) {
        const error = (await readResponse(response, 4 * 1024).catch(() => null))?.error;
        if (typeof error?.code === 'string' && /^NATIVE_OFFICE_[A-Z0-9_]{1,64}$/.test(error.code)) {
          throw Object.assign(Error(error.code), { code: error.code, mayHaveExecuted: error.mayHaveExecuted === true });
        }
      } else await response.body?.cancel();
      throw Object.assign(Error('WorkBuddy MCP 未连接、权限变化或调用失败，请检查连接器后重试。'),
        { code: 'NATIVE_MCP_UNAVAILABLE', mayHaveExecuted: officeCall || (operation === 'call' && response.status >= 500) });
    }
    try { return (await readResponse(response, 512 * 1024)).result; }
    catch { throw Object.assign(Error('MCP 响应不完整或超过大小限制。'), { code: 'NATIVE_MCP_UNAVAILABLE', mayHaveExecuted: operation === 'call' }); }
  }
  listTools(params) { return this.request('list', params); }
  callTool(params) { return this.request('call', params); }
  releaseOffice(params) { return this.request('release', params); }
}
