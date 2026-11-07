import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { CONTEXT_USAGE_SOURCE, projectContextUsage } from '../src/context-usage.mjs';

// Pi 1.1.0 shipped consumer/functions, copied verbatim except export keywords.
// The sole injected dependency rejects system replay, which these fixtures do not contain.
// agent-session.js SHA-256 0ba5c847b4fd2fd838f71ea84885b9f3a4f15d9bf4b5493e2e88a41d1507e20b
// compaction/compaction.js SHA-256 573f0321e9a93a4e8dca8c327f6459082ac438d1bc8b6c3c171d90894dd1543c
// session-manager.js SHA-256 046b6a1109ac3f0ed893bb85bf0648709362fa926a5da75761216cf2fcf9d926
const native = vm.runInNewContext(String.raw`
function calculateContextTokens(usage) {
    return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
/**
 * Get usage from an assistant message if available.
 * Skips aborted, error, and all-zero usage messages as they don't have valid usage data.
 */
function getAssistantUsage(msg) {
    if (msg.role === "assistant" && "usage" in msg) {
        const assistantMsg = msg;
        if (assistantMsg.stopReason !== "aborted" &&
            assistantMsg.stopReason !== "error" &&
            assistantMsg.usage &&
            calculateContextTokens(assistantMsg.usage) > 0) {
            return assistantMsg.usage;
        }
    }
    return undefined;
}
function getLastAssistantUsageInfo(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const usage = getAssistantUsage(messages[i]);
        if (usage)
            return { usage, index: i };
    }
    return undefined;
}
/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
function estimateContextTokens(messages) {
    const usageInfo = getLastAssistantUsageInfo(messages);
    if (!usageInfo) {
        let estimated = 0;
        for (const message of messages) {
            estimated += estimateTokens(message);
        }
        return {
            tokens: estimated,
            usageTokens: 0,
            trailingTokens: estimated,
            lastUsageIndex: null,
        };
    }
    const usageTokens = calculateContextTokens(usageInfo.usage);
    let trailingTokens = 0;
    for (let i = usageInfo.index + 1; i < messages.length; i++) {
        trailingTokens += estimateTokens(messages[i]);
    }
    return {
        tokens: usageTokens + trailingTokens,
        usageTokens,
        trailingTokens,
        lastUsageIndex: usageInfo.index,
    };
}
/** Estimate projected context without trusting usage captured before a later edit or compaction. */
function estimateProjectedContextTokens(projection, branchEntries) {
    const estimate = estimateContextTokens(projection.messages);
    if (estimate.lastUsageIndex !== null) {
        let projectedMessageIndex = 0;
        let usageEntryId;
        for (const entry of projection.entries) {
            const nextMessageIndex = projectedMessageIndex + entry.messages.length;
            if (estimate.lastUsageIndex < nextMessageIndex) {
                usageEntryId = entry.sourceEntry.id;
                break;
            }
            projectedMessageIndex = nextMessageIndex;
        }
        const usageEntryIndex = usageEntryId ? branchEntries.findIndex((entry) => entry.id === usageEntryId) : -1;
        let latestInvalidatingEntryIndex = -1;
        for (let i = branchEntries.length - 1; i >= 0; i--) {
            const entry = branchEntries[i];
            if (entry.type === "context_edit" || entry.type === "compaction") {
                latestInvalidatingEntryIndex = i;
                break;
            }
        }
        if (usageEntryIndex > latestInvalidatingEntryIndex)
            return estimate;
    }
    const currentSystem = getCurrentSystemMessage(projection.messages);
    let tokens = currentSystem ? estimateTokens(currentSystem) : 0;
    for (const message of projection.messages) {
        if (message.role !== "system")
            tokens += estimateTokens(message);
    }
    return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}
const ESTIMATED_IMAGE_CHARS = 4800;
function estimateTextAndImageContentChars(content) {
    if (typeof content === "string") {
        return content.length;
    }
    let chars = 0;
    for (const block of content) {
        if (block.type === "text" && block.text) {
            chars += block.text.length;
        }
        else if (block.type === "image") {
            chars += ESTIMATED_IMAGE_CHARS;
        }
    }
    return chars;
}
/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
function estimateTokens(message) {
    let chars = 0;
    switch (message.role) {
        case "system": {
            const system = message;
            chars = estimateTextAndImageContentChars(system.content);
            if (system.sections) {
                for (const section of Object.values(system.sections)) {
                    if (section)
                        chars += section.length;
                }
            }
            if (system.toolsAdded)
                chars += JSON.stringify(system.toolsAdded).length;
            return Math.ceil(chars / 4);
        }
        case "user": {
            chars = estimateTextAndImageContentChars(message.content);
            return Math.ceil(chars / 4);
        }
        case "assistant": {
            const assistant = message;
            for (const block of assistant.content) {
                if (block.type === "text") {
                    chars += block.text.length;
                }
                else if (block.type === "thinking") {
                    chars += block.thinking.length;
                }
                else if (block.type === "toolCall") {
                    chars += block.name.length + JSON.stringify(block.arguments).length;
                }
            }
            return Math.ceil(chars / 4);
        }
        case "custom":
        case "toolResult": {
            chars = estimateTextAndImageContentChars(message.content);
            return Math.ceil(chars / 4);
        }
        case "bashExecution": {
            chars = message.command.length + message.output.length;
            return Math.ceil(chars / 4);
        }
        case "branchSummary":
        case "compactionSummary": {
            chars = message.summary.length;
            return Math.ceil(chars / 4);
        }
    }
    return 0;
}
function getLatestCompactionEntry(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].type === "compaction") {
            return entries[i];
        }
    }
    return null;
}
function getCurrentSystemMessage(messages) {
    if (messages.some(message => message.role === 'system')) throw Error('Fixture excludes system replay');
    return undefined;
}
const consumer = {
    _limitsModel() {
        return this.routedModel?.model ?? this.model;
    },
    getContextUsage() {
        const model = this._limitsModel();
        if (!model)
            return undefined;
        const contextWindow = model.contextWindow ?? 0;
        if (contextWindow <= 0)
            return undefined;
        // After compaction, the last assistant usage reflects pre-compaction context size.
        // We can only trust usage from an assistant that responded after the latest compaction.
        // If no such assistant exists, context token count is unknown until the next LLM response.
        const projection = this.sessionManager.buildSessionProjection();
        const branch = this.sessionManager.getBranch();
        const latestCompaction = getLatestCompactionEntry(branch);
        if (latestCompaction) {
            const projectedAssistants = new Set(projection.entries.flatMap((entry) => entry.messages.some((message) => message.role === "assistant" &&
                message.stopReason !== "aborted" &&
                message.stopReason !== "error" &&
                calculateContextTokens(message.usage) > 0)
                ? [entry.sourceEntry.id]
                : []));
            const compactionIndex = branch.findIndex((entry) => entry.id === latestCompaction.id);
            const hasPostCompactionUsage = branch
                .slice(compactionIndex + 1)
                .some((entry) => projectedAssistants.has(entry.id));
            if (!hasPostCompactionUsage)
                return { tokens: null, contextWindow, percent: null };
        }
        const estimate = estimateProjectedContextTokens(projection, branch);
        const percent = (estimate.tokens / contextWindow) * 100;
        return {
            tokens: estimate.tokens,
            contextWindow,
            percent,
        };
    }
}; consumer;
`, {}, { timeout: 1000 });

function assistant(totalTokens, components = {}) {
  return { role: 'assistant', content: [], stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, ...components } };
}
function piStats(messages, { branch, window = 1000, routedWindow } = {}) {
  const entries = messages.map((message, index) => ({ id: `m${index}`, type: 'message', message }));
  const receiver = {
    ...native,
    model: { contextWindow: window },
    ...(routedWindow ? { routedModel: { model: { contextWindow: routedWindow } } } : {}),
    sessionManager: {
      buildSessionProjection: () => ({ messages, entries: entries.map(entry => ({ sourceEntry: entry, messages: [entry.message] })) }),
      getBranch: () => branch ?? entries,
    },
  };
  return { tokens: { input: 900000, output: 100000, cacheRead: 200000, cacheWrite: 10000, total: 1210000 },
    contextUsage: receiver.getContextUsage() };
}
const state = { model: { id: 'hy4-preview-ioa', contextWindow: 32768, maxTokens: 8192 } };

test('source declares estimation and unavailable native categories', () => {
  assert.equal(CONTEXT_USAGE_SOURCE.label, 'Pi 当前上下文估算');
  assert.equal(CONTEXT_USAGE_SOURCE.breakdownLabel, '原生分类暂不支持');
  assert.ok(Object.isFrozen(CONTEXT_USAGE_SOURCE));
});

test('native Pi consumer uses latest valid usage plus trailing estimate, never cumulative session tokens', () => {
  const stats = piStats([assistant(250), assistant(160, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }),
    { role: 'user', content: '12345678' }]);
  const projected = projectContextUsage({ stats, state });
  assert.equal(projected.status, 'available');
  assert.equal(projected.tokens, 162);
  assert.equal(projected.percent, 16.2);
  assert.equal(projected.contextWindow, 1000);
  assert.equal(projected.configuredMaxOutputTokens, 8192);
  assert.equal(projected.modelId, 'hy4-preview-ioa');
  assert.equal(projected.breakdown, null);
  assert.ok(!Object.hasOwn(projected, 'byCategory'));
  assert.ok(!Object.hasOwn(projected, 'cost'));
  assert.ok(projected.tokens < stats.tokens.total);
});

test('native zero-total fallback includes cache components as context, not categories', () => {
  const stats = piStats([assistant(0, { input: 50, output: 10, cacheRead: 30, cacheWrite: 10 })]);
  const projected = projectContextUsage({ stats, state });
  assert.equal(projected.tokens, 100);
  assert.equal(projected.percent, 10);
  assert.equal(projected.breakdown, null);
});

test('native aborted/error usage cannot replace the last valid baseline', () => {
  const stats = piStats([assistant(100), { ...assistant(800), stopReason: 'aborted' },
    { ...assistant(900), stopReason: 'error' }]);
  assert.equal(projectContextUsage({ stats, state }).tokens, 100);
});

test('native compaction without a fresh valid response remains explicitly unknown', () => {
  const stats = piStats([assistant(800)], { branch: [{ id: 'm0', type: 'message' }, { id: 'compact', type: 'compaction' }] });
  assert.equal(stats.contextUsage.tokens, null);
  const projected = projectContextUsage({ stats, state });
  assert.equal(projected.status, 'unknown');
  assert.equal(projected.tokens, null);
  assert.equal(projected.percent, null);
  assert.equal(projected.contextWindow, 1000);
  assert.equal(projected.unknownReason, 'context-tokens-unknown');
});

test('native post-compaction response provides a new baseline', () => {
  const stats = piStats([assistant(80)], { branch: [{ id: 'compact', type: 'compaction' }, { id: 'm0', type: 'message' }] });
  assert.equal(projectContextUsage({ stats, state }).tokens, 80);
});

test('native invalidating context edit discards stale usage and re-estimates current messages', () => {
  const stats = piStats([{ ...assistant(800), content: [{ type: 'text', text: '12345678' }] }],
    { branch: [{ id: 'm0', type: 'message' }, { id: 'edit', type: 'context_edit' }] });
  assert.equal(projectContextUsage({ stats, state }).tokens, 2);
});

test('native routed model window wins over get_state model; output limit stays configured metadata', () => {
  const stats = piStats([assistant(2048)], { window: 32768, routedWindow: 4096 });
  const projected = projectContextUsage({ stats, state });
  assert.equal(projected.contextWindow, 4096);
  assert.equal(projected.percent, 50);
  assert.equal(projected.configuredMaxOutputTokens, 8192);
});

test('missing context never falls back to session totals, turn totals, or configured window', () => {
  for (const input of [undefined, null, [], 5, {}, { state },
    { state, stats: { tokens: { total: 900000 }, usage: { totalTokens: 5000 } } }]) {
    const projected = projectContextUsage(input);
    assert.equal(projected.status, 'unknown');
    assert.equal(projected.tokens, null);
    assert.equal(projected.contextWindow, null);
    assert.equal(projected.percent, null);
    assert.equal(projected.breakdown, null);
    assert.equal(projected.unknownReason, 'context-unavailable');
  }
});

test('real zero is preserved, overflow is not clamped, and max output is not subtracted', () => {
  const zero = projectContextUsage({ stats: { contextUsage: { tokens: 0, contextWindow: 1000, percent: 0 } }, state });
  assert.equal(zero.status, 'available');
  assert.equal(zero.tokens, 0);
  assert.equal(zero.percent, 0);
  const overflow = projectContextUsage({ stats: { contextUsage: { tokens: 1500, contextWindow: 1000, percent: 150 } }, state });
  assert.equal(overflow.tokens, 1500);
  assert.equal(overflow.percent, 150);
  assert.equal(overflow.contextWindow, 1000);
});

test('invalid numbers and inconsistent native percentage are unknown, never coerced to zero', () => {
  const base = { tokens: 100, contextWindow: 1000, percent: 10 };
  const bad = [[], '10', false, {}, ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100', null, undefined].map(tokens => ({ ...base, tokens })),
    ...[0, -1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1000', null].map(contextWindow => ({ ...base, contextWindow })),
    ...[-1, NaN, Infinity, '10', null, undefined, 11].map(percent => ({ ...base, percent }))];
  for (const contextUsage of bad) {
    const projected = projectContextUsage({ stats: { contextUsage }, state });
    assert.equal(projected.status, 'unknown');
    assert.equal(projected.tokens, null);
    assert.equal(projected.percent, null);
    assert.equal(projected.unknownReason, 'invalid-context-usage');
  }
});

test('null unknown stays null, while malformed mixed null/numeric fields are invalid', () => {
  const unknown = projectContextUsage({ stats: { contextUsage: { tokens: null, contextWindow: 1000, percent: null } } });
  assert.equal(unknown.unknownReason, 'context-tokens-unknown');
  for (const contextUsage of [{ tokens: null, contextWindow: 1000, percent: 0 },
    { tokens: 0, contextWindow: 1000, percent: null }]) {
    assert.equal(projectContextUsage({ stats: { contextUsage } }).unknownReason, 'invalid-context-usage');
  }
});

test('projection is pure and does not expose session paths, ids, costs, or arbitrary source fields', () => {
  const contextUsage = Object.freeze({ tokens: 10, contextWindow: 1000, percent: 1 });
  const stats = Object.freeze({ contextUsage, tokens: { total: 100000 }, cost: 4.5,
    sessionFile: '/fixture/private-session.jsonl', sessionId: 'fixture-session', arbitrary: 'not-forwarded' });
  const projected = projectContextUsage({ stats, state: Object.freeze({ model: Object.freeze(state.model) }) });
  assert.deepEqual(Object.keys(projected).sort(), ['status', 'source', 'tokens', 'contextWindow', 'percent',
    'configuredMaxOutputTokens', 'modelId', 'breakdown'].sort());
  assert.ok(!JSON.stringify(projected).includes('fixture-session'));
  assert.ok(!JSON.stringify(projected).includes('private-session'));
  assert.ok(!JSON.stringify(projected).includes('not-forwarded'));
});
