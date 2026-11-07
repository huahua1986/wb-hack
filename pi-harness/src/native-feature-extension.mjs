import { readFileSync, lstatSync } from 'node:fs';

export const NATIVE_READY = 'workbuddy-native-features-ready-v1';
export const NATIVE_CALL = 'workbuddy-native-mcp-call-v1';
export const NATIVE_TITLE = 'WorkBuddy Native MCP';
export const NATIVE_TOOL = /^wb_mcp_[a-f0-9]{24}$/;
const MAX_CONTEXT = 1024 * 1024;

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
        if (result?.ok !== true || !Object.hasOwn(result, 'result')) throw Error(result?.code === 'NATIVE_MCP_OUTCOME_UNKNOWN'
          ? 'MCP 请求已发出但结果未确认，请检查远端实际结果后决定是否重新调用；本次不会自动重试。'
          : 'WorkBuddy MCP 调用失败、已断开或授权已撤销。');
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
