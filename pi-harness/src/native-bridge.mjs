import { readOfficialLocator } from './official-bridge.mjs';

export class NativeBridgeClient {
  constructor(directory, { fetchImpl = globalThis.fetch } = {}) { this.directory = directory; this.fetch = fetchImpl; }
  async request(operation, params) {
    if (!['list', 'call'].includes(operation)) throw Error('不支持的 MCP 桥操作。');
    const { signal, ...body } = params;
    const locator = readOfficialLocator(this.directory);
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text) > 64 * 1024) throw Error('MCP 请求参数过大。');
    let response;
    try { response = await this.fetch(`http://127.0.0.1:${locator.port}/v1/native/mcp/${operation}`, {
      method: 'POST', headers: { Authorization: `Bearer ${locator.ticket}`, 'Content-Type': 'application/json' },
      body: text, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(operation === 'call' ? 120_000 : 15_000)]), redirect: 'error',
    }); } catch {
      throw Object.assign(Error('WorkBuddy MCP 连接中断；调用结果可能尚未确认。'), { code: 'NATIVE_MCP_UNAVAILABLE', mayHaveExecuted: operation === 'call' });
    }
    // Never replay a tool call after timeout, ticket rotation or login changes.
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(Error('WorkBuddy MCP 未连接、权限变化或调用失败，请检查连接器后重试。'), { code: 'NATIVE_MCP_UNAVAILABLE', mayHaveExecuted: operation === 'call' && response.status >= 500 }); }
    const reader = response.body.getReader(), chunks = []; let bytes = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.length;
        if (bytes > 512 * 1024) throw Error('MCP 响应超过大小限制。');
        chunks.push(Buffer.from(part.value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')).result;
    } catch { await reader.cancel().catch(() => {}); throw Object.assign(Error('MCP 响应不完整或超过大小限制。'), { code: 'NATIVE_MCP_UNAVAILABLE', mayHaveExecuted: operation === 'call' }); }
    finally { reader.releaseLock(); }
  }
  listTools(params) { return this.request('list', params); }
  callTool(params) { return this.request('call', params); }
}
