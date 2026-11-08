import { createHash } from 'node:crypto';

const bad = message => Object.assign(new Error(message), { code: 'NATIVE_MCP_INVALID' });
export const OFFICE_SERVER_ID = 'builtin-office:editor-sdk';
export const nativeToolName = (server, name) => `wb_mcp_${createHash('sha256').update(`${server}\0${name}`).digest('hex').slice(0, 24)}`;

/** Credentials and launch configurations never cross this catalog boundary. */
export function normalizeNativeTools(records, selected) {
  if (!Array.isArray(selected) || selected.some(id => typeof id !== 'string' || !id || id.length > 512)
    || selected.length > 32 || new Set(selected).size !== selected.length) throw bad('连接器选择无效。');
  if (!Array.isArray(records) || records.length > 256) throw bad('WorkBuddy MCP 工具目录无效。');
  const result = [], names = new Set();
  for (const entry of records) {
    const globalUser = entry?.sourceType === 'user' && entry.selectedGlobally === true
      && typeof entry.serverId === 'string' && entry.serverId.startsWith('custom-mcp:') && entry.serverId.length > 11
      && entry.connectorId === entry.serverId;
    if (entry?.sourceType === 'user' && !globalUser) throw bad('自定义 MCP 缺少原生启用与信任状态。');
    const selectedId = globalUser ? entry.serverId : selected.find(id => id.replace(/^connector:/, '') === String(entry?.connectorId ?? entry?.serverId).replace(/^connector:/, ''));
    if (!selectedId) continue;
    if (typeof entry.serverId !== 'string' || !entry.serverId || entry.serverId.length > 512
      || typeof entry.rawName !== 'string' || !entry.rawName || entry.rawName.length > 256
      || entry.inputSchema?.type !== 'object' || (entry.inputSchema.properties !== undefined && (typeof entry.inputSchema.properties !== 'object'
      || Array.isArray(entry.inputSchema.properties) || entry.inputSchema.properties === null))) throw bad('MCP 工具定义无效。');
    // No external schemas/remote references: Pi validates the supplied schema locally.
    const schema = JSON.stringify(entry.inputSchema);
    if (Buffer.byteLength(schema) > 16 * 1024 || /"\$ref"\s*:\s*"(?!#)/.test(schema)) throw bad('MCP 工具参数 schema 超限或包含外部引用。');
    const name = nativeToolName(entry.serverId, entry.rawName);
    if (names.has(name)) throw bad('MCP 工具目录包含重复定义。');
    names.add(name);
    result.push({ name, serverId: entry.serverId, connectorId: selectedId, rawName: entry.rawName,
      label: String(entry.label ?? `${entry.serverId} / ${entry.rawName}`).slice(0, 512),
      description: `${String(entry.description ?? '').slice(0, 4096)}\n通过 WorkBuddy 已选择的连接器 ${entry.serverId} 执行；每次调用均需用户确认。`,
      parameters: { ...structuredClone(entry.inputSchema), properties: structuredClone(entry.inputSchema.properties ?? {}) } });
  }
  if (result.length > 64 || Buffer.byteLength(JSON.stringify(result)) > 192 * 1024) throw bad('选中的 MCP 工具过多，请减少连接器。');
  for (const id of selected) {
    if (!result.some(tool => tool.connectorId === id)) throw bad(`连接器 ${id} 尚未连接、没有工具或未完成授权，或该传输类型尚未映射。`);
  }
  return result;
}

export function validateConnectorSelection(value = []) {
  if (!Array.isArray(value) || value.length > 32 || value.some(id => typeof id !== 'string'
    || !id.trim() || id.length > 512 || /[\x00-\x1f]/.test(id)) || new Set(value).size !== value.length) throw bad('连接器选择无效。');
  return [...value];
}
