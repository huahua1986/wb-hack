// Loaded explicitly by the external Host. No discovery, packages, or global Pi settings.
export const APPROVAL_PROTOCOL = 'workbuddy-host-approval-v1';
export const APPROVAL_READY = 'workbuddy-host-approval-ready-v1';
export const APPROVAL_TITLE = 'WorkBuddy Pi 操作确认';

const READ_ONLY = new Set(['read', 'grep', 'find', 'ls']);
const CONFIRM = new Set(['edit', 'write', 'bash']);

function approvalTimeout() {
  const value = Number(process.env.WORKBUDDY_PI_APPROVAL_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value >= 1_000 && value <= 3_600_000 ? value : 300_000;
}

export default function workbuddyApprovalExtension(pi) {
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode === 'rpc') ctx.ui.notify(APPROVAL_READY, 'info');
  });

  pi.on('tool_call', async (event, ctx) => {
    if (READ_ONLY.has(event.toolName)) return;
    if (!CONFIRM.has(event.toolName) && !/^wb_mcp_[a-f0-9]{24}$/.test(event.toolName)) {
      return { block: true, reason: '该工具未被 WorkBuddy Pi 工具策略允许。' };
    }
    if (ctx.mode !== 'rpc' || ctx.signal?.aborted) {
      return { block: true, reason: '操作未获得 WorkBuddy 授权。' };
    }
    try {
      const confirmed = await ctx.ui.confirm(APPROVAL_TITLE, JSON.stringify({
        protocol: APPROVAL_PROTOCOL,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
      }), { signal: ctx.signal, timeout: approvalTimeout() });
      if (confirmed === true && !ctx.signal?.aborted) return;
    } catch {
      // A missing UI, transport failure, or cancellation must never authorize a tool.
    }
    return { block: true, reason: '用户未批准本次操作。' };
  });
}
