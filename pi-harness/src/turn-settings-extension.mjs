import { TURN_SETTINGS_ENV, TURN_SETTINGS_READY, parseTurnSettingsEnvironment } from './turn-settings.mjs';

// Pi exposes settings as a read-only snapshot. The Host writes an isolated agent
// settings file before spawn; this extension verifies the effective values after
// project/global merging, so a native preference cannot silently be ignored.
export default function turnSettingsExtension(pi) {
  const selected = parseTurnSettingsEnvironment(process.env[TURN_SETTINGS_ENV]);
  pi.on('session_before_compact', event => {
    // Native 0% disables proactive/pre-message compaction, not manual compact
    // or the compact-and-retry recovery after an actual provider overflow.
    if (!selected.preMessageCompaction && event.reason === 'threshold') return { cancel: true };
  });
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'rpc') throw Error('PI_SETTINGS_RPC_REQUIRED');
    const actual = pi.getSettings(), compaction = actual.compaction ?? {};
    const modelOverride = compaction.modelOverrides?.[`${selected.provider}/${selected.modelId}`] ?? {};
    if ((compaction.enabled ?? true) !== selected.autoCompaction
      || (modelOverride.reserveTokens ?? compaction.reserveTokens ?? 16384) !== selected.reserveTokens
      || (modelOverride.keepRecentTokens ?? compaction.keepRecentTokens ?? 20000) !== selected.keepRecentTokens) {
      throw Error('PI_SETTINGS_NOT_APPLIED: 项目压缩配置与会话设置冲突，本轮未发送。');
    }
    pi.setThinkingLevel(selected.thinkingLevel);
    if (pi.getThinkingLevel() !== selected.thinkingLevel) throw Error('PI_THINKING_NOT_APPLIED: 当前模型未接受所选推理档位。');
    ctx.ui.notify(TURN_SETTINGS_READY, 'info');
  });
}
