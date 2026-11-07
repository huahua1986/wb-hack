import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/native-context-usage-591.source.json', import.meta.url), 'utf8'));
function source(name) {
  const slice = fixture.slices.find(entry => entry.name === name);
  assert.ok(slice, `Missing native source: ${name}`);
  return slice.source;
}

function pureApi() {
  const context = vm.createContext({ lO: 2 });
  vm.runInContext(['format-tokens', 'display-data', 'category-rows', 'record-helper', 'number-helper', 'usage-normalize', 'category-normalize', 'cache-normalize', 'latest-message-usage'].map(source).join('\n') + ';globalThis.api={getDisplayData,buildRows,normalizeUsage,normalizeCategory,normalizeSnapshot:normalizeSnapshot$1,selectLatestContextUsage}', context);
  return context.api;
}

function providerFromState(state) {
  const controller = { getMessageStore: () => ({ getState: () => state }) };
  const context = vm.createContext({
    s$: { useMemo: fn => fn(), useState: () => [undefined, () => {}], useEffect() {}, useCallback: fn => fn },
    c$: { useStore: (store, selector) => selector(store.getState()) },
    useConversationController: () => controller,
    useConversationSessionSelector: () => ({ conversationId: 'fixture', isBusy: false }),
    selectContextUsageSession() {}, shallow$1() {}, selectConversationContextUsage: value => value.conversationContextUsage,
    Si: value => value, Bnn: 15000, Vnn: 'CONVERSATION_CONTEXT_USAGE_REFRESH_FAILED',
  });
  vm.runInContext(['latest-message-usage', 'assistant-selector', 'message-usage-provider', 'provider-hook'].map(source).join('\n') + ';globalThis.provider=useWbContextUsageProvider(true,16000)', context);
  return context.provider;
}

function nativeTip({ onRequestUsage, isRequesting = false, isLoading = false }) {
  const states = [false, true, isLoading, false];
  const context = vm.createContext({
    HK: { useMemo: fn => fn(), useState: initial => [states.shift() ?? initial, () => {}], useRef: value => ({ current: value }), useEffect() {}, useCallback: fn => fn },
    UK: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    useInputProvider: () => ({ lastTokens: 100, maxAllowedSize: 16000, maxInputTokens: 16000, onRequestUsage, isRequesting, sessionKey: 'fixture' }),
    useI18n: () => ({ t: key => key }), usePrefixCls: () => value => 'cr-' + value, useRenderDiag() {},
    Tooltip$1: 'tooltip', RingProgress: 'ring', UsageByCategoryPopover: 'popover',
  });
  vm.runInContext(source('format-tokens') + source('display-data') + ';var RequestingTip,ContextUsageDisplayInner;' + source('requesting-tip') + ';' + source('context-usage-component') + ';globalThis.api={render:ContextUsageDisplayInner,tip:RequestingTip}', context);
  const tree = context.api.render();
  const tip = tree.props.children.props.children.find(child => child?.type === context.api.tip);
  return context.api.tip(tip.props);
}

function nativeEvents() {
  let state = { messages: [{ messageType: 'assistant', content: 'fixture' }] };
  const storeContext = vm.createContext({ t: () => state, n: update => { state = { ...state, ...update }; } });
  vm.runInContext(`globalThis.api={${source('store-usage-apply')}}`, storeContext);
  const persisted = [];
  let eventHandler;
  const context = vm.createContext({
    n: { on: (event, callback) => { assert.equal(event, 'contextUsageChanged'); eventHandler = callback; } },
    Jo: { ContextUsageChanged: 'contextUsageChanged' }, shouldSkip: () => false, V: true,
    r: { getState: () => ({ ...state, applyConversationContextUsage: value => storeContext.api.applyConversationContextUsage(value) }) },
    w: value => persisted.push(value),
  });
  vm.runInContext(['record-helper', 'number-helper', 'usage-normalize', 'assistant-presence'].map(source).join('\n') + ';' + source('context-usage-event'), context);
  return { emit: value => eventHandler(value), state: () => state, persisted };
}

async function nativeRefresh(refreshResult) {
  const updates = [], timers = [];
  let pending;
  const controller = {
    getMessageStore: () => ({ getState: () => ({ messages: [{ messageType: 'assistant', content: 'fixture', usage: { inputTokens: 100, outputTokens: 5, lastTokens: 100, maxAllowedSize: 16000 } }] }) }),
    restoreContextUsageFromCache: async () => false,
    getConversation: () => ({ refreshContextUsage: (...args) => { assert.equal(args.length, 0); return refreshResult; } }),
    acknowledgeRuntimeActivatedByCore() {},
  };
  const context = vm.createContext({
    s$: { useMemo: fn => fn(), useState: () => [pending, value => { pending = typeof value === 'function' ? value(pending) : value; updates.push(pending); }], useEffect() {}, useCallback: fn => fn },
    c$: { useStore: (store, selector) => selector(store.getState()) },
    useConversationController: () => controller,
    useConversationSessionSelector: () => ({ conversationId: 'fixture', isBusy: false }),
    selectContextUsageSession() {}, shallow$1() {}, selectConversationContextUsage: value => value.conversationContextUsage,
    Si: value => value, Bnn: 15000, Vnn: 'CONVERSATION_CONTEXT_USAGE_REFRESH_FAILED',
    window: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); } },
    ConversationControllerApiError: class extends Error { constructor(error) { super(error.message); this.code = error.code; } },
  });
  vm.runInContext(['latest-message-usage', 'assistant-selector', 'message-usage-provider', 'api-error-read', 'api-error-throw', 'provider-hook'].map(source).join('\n') + ';globalThis.provider=useWbContextUsageProvider(true,16000)', context);
  let error;
  try { await context.provider.onRequestUsage(); } catch (caught) { error = caught; }
  return { updates, timers, error };
}

test('usage consumers preserve verified 5.9.1 candidate identity, source hashes and byte provenance', () => {
  assert.equal(fixture.workbuddyVersion, '5.9.1');
  assert.equal(fixture.candidateVersion, '0.3.0');
  assert.equal(fixture.artifactSHA256, '30a2cf892ac73edebc1eea291f8c5f11354724269c13d08274b9115fc143d536');
  assert.equal(fixture.original591ArtifactSHA256, '1fc0a56ddec5437d4dc55a55ba1c028b291ab29cb17306500827015987424233');
  const hashes = {
    'renderer/assets/src-C-yvPLiT.js': '7e4438995d9f67ac10a67b964bfdad2a543def60a7df06f708df2ed41454a1f8',
    'renderer/assets/contexts-BqwNadeD.js': '139726c975eab852879a97797315df5eb1ce9ef3cd580cf6500804b57cdb25c6',
  };
  assert.equal(fixture.slices.length, 19);
  for (const entry of fixture.slices) {
    assert.equal(entry.memberSHA256, hashes[entry.member]);
    assert.equal(entry.range.encoding, 'UTF-8');
    assert.equal(createHash('sha256').update(entry.source).digest('hex'), entry.sha256);
    assert.equal(Buffer.byteLength(entry.source), entry.bytes);
    assert.equal(entry.bytes, entry.range.end - entry.range.start);
  }
});

test('native ring prefers message usage and replaces lastTokens with positive inputTokens', () => {
  const api = pureApi();
  const messages = [{ messageType: 'assistant', content: 'fixture', usage: { inputTokens: 20, lastTokens: 100, maxAllowedSize: 16000 } }];
  assert.equal(api.selectLatestContextUsage({ messages }).lastTokens, 20);
  const provider = providerFromState({ messages, conversationContextUsage: { totalTokens: 500, contextWindow: 16000 } });
  assert.equal(provider.lastTokens, 20);
});

test('without message token projection the native provider uses current conversation totals', () => {
  const usage = { totalTokens: 500, contextWindow: 16000 };
  for (const message of [{ messageType: 'assistant', content: 'fixture' }, { messageType: 'assistant', content: 'fixture', usage: { credit: 1 } }]) {
    const provider = providerFromState({ messages: [message], conversationContextUsage: usage });
    assert.equal(provider.lastTokens, 500);
    assert.equal(provider.maxAllowedSize, 16000);
    assert.equal(provider.usageByCategory, undefined);
  }
});

test('native unknown or empty current usage does not become a fabricated zero ring', () => {
  const api = pureApi();
  assert.equal(api.getDisplayData({ lastTokens: null, maxAllowedSize: 16000 }), null);
  assert.equal(providerFromState({ messages: [], conversationContextUsage: undefined }), undefined);
  assert.equal(providerFromState({ messages: [{ messageType: 'assistant', content: 'fixture' }], conversationContextUsage: { totalTokens: 0, contextWindow: 16000 } }), undefined);
});

test('native ring chooses the documented requesting and idle context-window fields', () => {
  const api = pureApi();
  const usage = { lastTokens: 100, maxInputTokens: 8000, maxAllowedSize: 16000 };
  assert.equal(api.getDisplayData({ ...usage, isRequesting: true }).total, 8000);
  assert.equal(api.getDisplayData({ ...usage, isRequesting: false }).total, 16000);
});

test('empty or unknown category schemas cannot truthfully represent native breakdown v1', () => {
  const api = pureApi();
  assert.equal(api.normalizeCategory({ version: 1 }), undefined);
  assert.equal(api.normalizeCategory({ version: 1, unknown: 100 }), undefined);
  const normalized = api.normalizeUsage({ totalTokens: 100, contextWindow: 16000, byCategory: { version: 1, unknown: 100 } });
  assert.equal('unknown' in normalized.usageByCategory, false);
  assert.deepEqual(Array.from(api.buildRows(normalized.usageByCategory), row => row.value), [0, 0, 0, 0, 0]);
  assert.equal(api.normalizeSnapshot({ version: 2, used: 100, size: 16000, usageByCategory: normalized.usageByCategory, hasCompletedLlmCall: true, updatedAt: 1 }), undefined);
});

test('native breakdown cache requires the five integer categories to sum to used tokens', () => {
  const api = pureApi();
  const categories = { version: 1, systemPrompt: 20, tools: 20, conversation: 40, mcp: 10, skills: 10 };
  const snapshot = { version: 2, used: 100, size: 16000, usageByCategory: categories, hasCompletedLlmCall: true, updatedAt: 1 };
  assert.equal(api.normalizeSnapshot(snapshot).used, 100);
  assert.equal(api.normalizeSnapshot({ ...snapshot, used: 101 }), undefined);
  assert.equal(api.normalizeSnapshot({ ...snapshot, usageByCategory: { ...categories, skills: 0.5 } }), undefined);
});

test('native contextUsageChanged supports current total and window without fabricated categories', () => {
  const native = nativeEvents();
  native.emit({ totalTokens: 100, contextWindow: 16000 });
  assert.equal(native.state().conversationContextUsage.totalTokens, 100);
  assert.equal(native.state().conversationContextUsage.contextWindow, 16000);
  assert.equal(native.state().conversationContextUsage.byCategory, undefined);
  assert.equal(native.persisted.length, 0);
});

test('native contextUsageChanged persists classified detail only after assistant evidence', () => {
  const native = nativeEvents();
  native.emit({ totalTokens: 100, contextWindow: 16000, byCategory: { version: 1, systemPrompt: 20, tools: 20, conversation: 40, mcp: 10, skills: 10 } });
  assert.equal(native.state().conversationContextUsage.byCategory.conversation, 40);
  assert.equal(native.persisted.length, 1);
  assert.equal(native.persisted[0].hasCompletedLlmCall, true);
});

test('native refresh with undefined success waits 15 seconds when no breakdown arrives', async () => {
  const result = await nativeRefresh(undefined);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.updates, ['fixture']);
  assert.equal(result.timers.length, 1);
  assert.equal(result.timers[0].ms, 15000);
  result.timers[0].fn();
  assert.deepEqual(result.updates, ['fixture', undefined]);
});

test('native NOT_SUPPORTED response clears detail loading immediately without fake breakdown', async () => {
  const result = await nativeRefresh({ errorCode: 'NOT_SUPPORTED', message: 'Pi only provides a current total estimate, without category details.' });
  assert.equal(result.error.code, 'NOT_SUPPORTED');
  assert.deepEqual(result.updates, ['fixture', undefined]);
  assert.equal(result.timers.length, 0);
});

test('native RequestingTip retains its exact class, tooltip role and loading/error state contract', () => {
  const cases = [
    [{ onRequestUsage: async () => {} }, 'chatInput.contextUsage.unavailable'],
    [{ onRequestUsage: undefined }, 'chatInput.contextUsage.needMessage'],
    [{ onRequestUsage: undefined, isRequesting: true }, 'chatInput.contextUsage.requesting'],
    [{ onRequestUsage: async () => {}, isLoading: true }, 'chatInput.contextUsage.loading'],
  ];
  for (const [input, key] of cases) {
    const tip = nativeTip(input);
    assert.equal(tip.props.role, 'tooltip');
    assert.equal(tip.props.className, 'cr-context-usage-requesting-tip');
    assert.equal(tip.props.children.props.className, 'cr-context-usage-requesting-tip__text');
    assert.equal(tip.props.children.props.children, key);
  }
});
