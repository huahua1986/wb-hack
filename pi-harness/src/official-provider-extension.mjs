import { OfficialBridgeClient, OFFICIAL_PROVIDER, readOfficialLocator, applyOfficialContextWindows } from './official-bridge.mjs';
import { THINKING_LEVELS, thinkingOptionsForModel } from './turn-settings.mjs';

export const OFFICIAL_THINKING_FIELD = '__workbuddy_pi_thinking_level';
function streamThinkingLevel(model, requested) {
  const options = thinkingOptionsForModel(model);
  const level = requested ?? 'off';
  if (options.levels.includes(level)) return level;
  // Internal Pi summary calls use a small reasoning level. Match Pi's own
  // capability clamping here; explicit native preferences are validated by Host.
  if (!THINKING_LEVELS.includes(level)) throw Error('PI_THINKING_INVALID');
  const index = THINKING_LEVELS.indexOf(level);
  return THINKING_LEVELS.slice(index + 1).find(value => options.levels.includes(value))
    ?? THINKING_LEVELS.slice(0, index).reverse().find(value => options.levels.includes(value)) ?? options.defaultLevel;
}

export async function createOfficialProvider({ directory, bridge = new OfficialBridgeClient(directory), streamSimple, contextWindows = {} }) {
  let catalog = await bridge.models();
  applyOfficialContextWindows(catalog, contextWindows);
  const modelDefinitions = () => {
    const locator = readOfficialLocator(directory);
    return applyOfficialContextWindows(catalog, contextWindows).map(model => ({
      ...model, baseUrl: `http://127.0.0.1:${locator.port}/v1`,
      // Pi requires numeric pricing metadata. Host separately marks unknown prices
      // and omits cost from official usage; these zeros are never a billing claim.
      cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsDeveloperRole: false,
        maxTokensField: 'max_tokens', supportsReasoningEffort: false },
    }));
  };
  const stream = (model, context, options = {}) => streamSimple(model, context, {
    ...options, fetch: bridge.fetch, maxRetries: 0,
    async onPayload(payload, selectedModel) {
      const transformed = await options.onPayload?.(payload, selectedModel) ?? payload;
      if (!transformed || typeof transformed !== 'object') return transformed;
      const withThinking = model.reasoning ? { ...transformed, [OFFICIAL_THINKING_FIELD]: streamThinkingLevel(model, options.reasoning) } : transformed;
      if (model.supportsToolCall !== false) return withThinking;
      const { tools, tool_choice, parallel_tool_calls, ...withoutTools } = withThinking;
      return withoutTools;
    },
  });
  return {
    id: OFFICIAL_PROVIDER, name: 'WorkBuddy 官方模型',
    auth: { apiKey: {
      name: 'WorkBuddy 本机官方授权桥',
      async check() {
        try { readOfficialLocator(directory); return { source: 'WorkBuddy 本机官方授权桥' }; } catch { return undefined; }
      },
      async resolve() {
        const locator = readOfficialLocator(directory);
        return { auth: { apiKey: locator.ticket }, source: 'WorkBuddy 本机官方授权桥' };
      },
    } },
    getModels: modelDefinitions,
    filterModels: models => models.filter(model => !model.disabled),
    async refreshModels(context) {
      if (!context.allowNetwork) return;
      catalog = await bridge.models({ signal: context.signal, waitMs: 0 });
      await context.publish({ update() {} });
    },
    stream, streamSimple: stream,
  };
}

