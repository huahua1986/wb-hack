export const CONTEXT_USAGE_SOURCE = Object.freeze({
  id: 'pi-context-estimate',
  label: 'Pi 当前上下文估算',
  breakdownLabel: '原生分类暂不支持',
});

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const limit = value => Number.isSafeInteger(value) && value > 0;

/** Project Pi 1.1 get_session_stats data, never cumulative session/turn usage. */
export function projectContextUsage(input = {}) {
  const { stats, state } = record(input) ? input : {};
  const model = record(state?.model) ? state.model : undefined;
  const result = {
    status: 'unknown',
    source: CONTEXT_USAGE_SOURCE.id,
    tokens: null,
    contextWindow: null,
    percent: null,
    configuredMaxOutputTokens: limit(model?.maxTokens) ? model.maxTokens : null,
    modelId: typeof model?.id === 'string' && model.id.length > 0 ? model.id : null,
    breakdown: null,
  };
  const usage = record(stats) ? stats.contextUsage : undefined;
  if (usage === undefined || usage === null) {
    return { ...result, unknownReason: 'context-unavailable' };
  }
  if (!record(usage) || !limit(usage.contextWindow)) {
    return { ...result, unknownReason: 'invalid-context-usage' };
  }
  // This window is resolved by Pi's _limitsModel(), which can differ from get_state.model.
  result.contextWindow = usage.contextWindow;
  if (usage.tokens === null && usage.percent === null) {
    return { ...result, unknownReason: 'context-tokens-unknown' };
  }
  if (!count(usage.tokens) || !Number.isFinite(usage.percent) || usage.percent < 0) {
    return { ...result, unknownReason: 'invalid-context-usage' };
  }
  const percent = usage.tokens / usage.contextWindow * 100;
  const tolerance = Number.EPSILON * Math.max(1, percent) * 8;
  if (Math.abs(usage.percent - percent) > tolerance) {
    return { ...result, unknownReason: 'invalid-context-usage' };
  }
  // Overflow is meaningful; the visual ring may clamp its arc, but the metric must not.
  return { ...result, status: 'available', tokens: usage.tokens, percent };
}
