import { readFileSync, lstatSync } from 'node:fs';

export const NATIVE_READY = 'workbuddy-native-features-ready-v1';
export const NATIVE_CALL = 'workbuddy-native-mcp-call-v1';
export const NATIVE_TITLE = 'WorkBuddy Native MCP';
export const NATIVE_TOOL = /^wb_mcp_[a-f0-9]{24}$/;
const MAX_CONTEXT = 1024 * 1024;
const OFFICE_ERRORS = {
  NATIVE_OFFICE_UNAVAILABLE: '本地 Office 编辑器尚不可用，请检查应用后重试。',
  NATIVE_OFFICE_START_TIMEOUT: '本地 Office 编辑器启动超时，请稍后重试。',
  NATIVE_OFFICE_FILE_NOT_ALLOWED: '请选择本任务工作目录内的普通 Office 文件。',
  NATIVE_OFFICE_FILE_NOT_OPEN: '当前轮次没有这个文档句柄，请重新打开文件。',
  NATIVE_OFFICE_FILE_CHANGED: '文件已被其他操作修改，请重新打开后再编辑。',
  NATIVE_OFFICE_FILE_BUSY: '其他任务正在使用这份文件，请等待它结束。',
  NATIVE_OFFICE_SAVE_REFUSED: '当前文档的目标路径或保存权限无效。',
  NATIVE_OFFICE_SNAPSHOT_REQUIRED: '未取得可恢复的原文件快照，保存未执行。',
  NATIVE_OFFICE_SHUTDOWN_BUSY: 'Office 编辑服务仍在使用，请关闭所有编辑器或等待其他操作结束。',
  NATIVE_OFFICE_ATTACHMENT_UNCONFIRMED: '附件记录尚未确认完整，已阻止保存。请重新打开脑图后再添加。',
};

function readContext(filename) {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONTEXT) throw Error('Invalid native context');
  const value = JSON.parse(readFileSync(filename, 'utf8'));
  if (value.version !== 1 || typeof value.instructions !== 'string' || !Array.isArray(value.tools)
    || value.tools.length > 64 || new Set(value.tools.map(tool => tool.name)).size !== value.tools.length) throw Error('Invalid native context');
  for (const tool of value.tools) {
    if (!NATIVE_TOOL.test(tool.name) || typeof tool.description !== 'string'
      || tool.parameters?.type !== 'object') throw Error('Invalid native tool');
  }
  return value;
}

// Explicitly loaded by the Host. Native skills remain instructions/resources;
// their JavaScript, hooks and Pi extensions are never discovered or executed.
export default function nativeFeatureExtension(pi) {
  const filename = process.env.WORKBUDDY_PI_NATIVE_CONTEXT_FILE;
  if (!filename) throw Error('Missing native context');
  const initial = readContext(filename);
  for (const tool of initial.tools) {
    pi.registerTool({
      name: tool.name, label: tool.label || tool.name, description: tool.description,
      parameters: tool.parameters,
      async execute(toolCallId, args, signal, _onUpdate, ctx) {
        if (ctx.mode !== 'rpc' || signal?.aborted) throw Error('Native tool cancelled');
        const current = readContext(filename);
        if (!current.tools.some(entry => entry.name === tool.name)) throw Error('Native tool is no longer selected');
        // RPC's input response transports a result, never an approval. The Host
        // separately requires and consumes an exact one-shot tool approval.
        const raw = await ctx.ui.input(NATIVE_TITLE, JSON.stringify({
          protocol: NATIVE_CALL, toolCallId, name: tool.name, arguments: args,
          threadId: current.threadId, turnId: current.turnId,
        }), { signal, timeout: 120_000 });
        if (signal?.aborted || typeof raw !== 'string' || raw.length > 512 * 1024) throw Error('Native tool cancelled or unavailable');
        let result;
        try { result = JSON.parse(raw); } catch { throw Error('Invalid native tool response'); }
        if (result?.ok !== true || !Object.hasOwn(result, 'result')) {
          if (result?.code === 'NATIVE_MCP_OUTCOME_UNKNOWN') throw Error('工具请求已发出但结果未确认，请检查实际结果后决定是否重新调用；本次不会自动重试。');
          if (typeof result?.code === 'string' && result.code.startsWith('NATIVE_OFFICE_')) {
            throw Error(Object.hasOwn(OFFICE_ERRORS, result.code) ? OFFICE_ERRORS[result.code] : `本地 Office 工具调用失败（${result.code}）。`);
          }
          throw Error('WorkBuddy MCP 调用失败、已断开或授权已撤销。');
        }
        const after = readContext(filename);
        if (after.threadId !== current.threadId || after.turnId !== current.turnId
          || !after.tools.some(entry => entry.name === tool.name)) throw Error('Native tool context changed');
        return { content: [{ type: 'text', text: JSON.stringify(result.result) }], details: {} };
      },
    });
  }
  pi.on('before_agent_start', event => {
    const current = readContext(filename);
    return { systemPrompt: [event.systemPrompt, current.instructions].filter(Boolean).join('\n\n') };
  });
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode === 'rpc') ctx.ui.notify(NATIVE_READY, 'info');
  });
}
