import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

export const nativeInputFixture = JSON.parse(fs.readFileSync(new URL('./native-input-592.source.json', import.meta.url)));
const sha = value => createHash('sha256').update(value).digest('hex');
const source = name => {
  const slice = nativeInputFixture.slices.find(value => value.name === name);
  if (!slice || sha(slice.source) !== slice.sha256) throw Error('Native input slice pin differs: ' + name);
  return slice.source;
};

/** Exact shipped constructors. Visual SVG/React primitives are inert stand-ins. */
export function createNativeInputReplay() {
  const context = vm.createContext({ URL, Set, Map, Date, Math, console, encodeURIComponent, decodeURIComponent,
    getSceneIcon: () => '<svg aria-hidden="true"/>',
    Z: { createElement: (type, props, ...children) => ({ type, props, children }) },
    _objectSpread$6: (...values) => Object.assign({}, ...values),
    oEe: 0,
  });
  context.cI = vm.runInContext(`(${source('displayKeys')})`, context);
  context.lI = vm.runInContext(`(${source('presentationKeys')})`, context);
  context.uI = vm.runInContext(`(${source('attachmentKeys')})`, context);
  for (const name of ['triggerKinds', 'commandCategories', 'wecomHomeSceneId', 'connectorPendingKind', 'connectorResolvedKind', 'connectorProtectedMetadata']) vm.runInContext(source(name), context);
  context.ca = context.ys = context.cI;
  context.ri = context.bs = context.lI;
  context.hi = context.fI;
  context.Mi = vm.runInContext(`(${source('createPhraseBlock')})`, context);
  context.Zr = vm.runInContext(`(${source('legacyCreatePhraseBlock')})`, context);
  context.ko = context.Zr;
  context.J8 = vm.runInContext(`(${source('wecomHomeScene')})`, context);
  for (const slice of nativeInputFixture.slices) if (slice.kind === 'FunctionDeclaration' && !['createPhraseBlock', 'legacyCreatePhraseBlock', 'EmbedSceneActions'].includes(slice.name)) vm.runInContext(source(slice.name), context);
  const zeroWidth = vm.runInContext(`(${source('ZeroWidthString')})`, context);
  Object.assign(context, { EL: Intl, kL: new WeakMap(), window: {}, toContentBlocks: value => value });
  for (const name of ['nativeGraphemeSegmenter', 'longTextPreviewLength', 'clipboardMime']) vm.runInContext(source(name), context);
  for (const name of ['serializeContentBlocks', 'deserializeContentBlocks', 'extractMixedContentFromHTML', 'countAttachmentBlocks',
    'insertPastedContentBlocksWithAttachmentLimit', 'insertPastedContentBlocks', 'insertPlainTextPaste', 'insertPlainTextPasteRaw', 'withPaste']) {
    context[name] = vm.runInContext(`(${source(name)})`, context);
  }
  const paste = options => {
    const blocks = [], plain = [], hiddenBlocks = [], clipboardReads = [];
    context.insertContentBlocks = (_editor, next) => { blocks.push(...next); };
    context.insertPlainText = (_editor, text) => { plain.push(text); };
    const htmlNodes = (options.htmlBlocks ?? []).map(block => block.type === 'text'
      ? { nodeType: 3, textContent: block.text }
      : { nodeType: 1, getAttribute: name => name === 'data-contentblock' ? JSON.stringify(block) : null, childNodes: [] });
    context.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
    // Controlled DOM nodes exercise the unchanged HTML JSON extractor, not a
    // browser HTML parser or its sanitization behavior.
    context.DOMParser = class { parseFromString() { return { body: { firstChild: htmlNodes[0], childNodes: htmlNodes } }; } };
    const editor = { children: [], insertData() {}, apply() {}, insertText(text) { plain.push(text); } };
    context.withPaste(editor, { maxLength: options.maxLength, enableLongTextPasteChip: options.enableLongTextPasteChip,
      ...(options.appendHidden ? { getAppendHiddenBlock: () => block => hiddenBlocks.push(block) } : {}),
      ...(options.attachmentMaxFiles === undefined ? {} : { getAttachmentMaxFiles: () => options.attachmentMaxFiles }),
    });
    editor.insertData({ getData(type) {
      clipboardReads.push(type);
      if (type === context.NL) return options.blocks === undefined ? '' : context.serializeContentBlocks(options.blocks);
      if (type === 'text/html') return options.htmlBlocks === undefined ? '' : '<span data-contentblock="synthetic"></span>';
      if (type === 'text/plain') return options.text ?? '';
      return '';
    } });
    return { blocks, plainText: plain.join(''), hiddenBlocks, clipboardReads };
  };
  return {
    wecomScene: () => context.J8,
    homeSceneBlock: (scene = context.J8, index) => context.createHomeSceneBlock(scene, index),
    homeBlocks: (blocks, scene = context.J8) => context.composeEmbedHomeBlocks(blocks, scene),
    applyScene: (blocks, scene, prompt, index, options) => context.applyEmbedSceneBlocks(blocks, scene, prompt, index, options),
    isScene: block => context.isSceneContentBlock(block),
    sceneId: blocks => context.resolveSceneIdFromContentBlocks(blocks),
    skillBlock: input => context.buildSkillBlock(input),
    slashCommand: input => context.buildSlashCommandInsertBlock(input),
    skillInsert: input => context.buildSkillInsertBlock(input),
    fileMention: suggestion => context.createFileMentionBlock(suggestion),
    connectorLink: (match, provider, authorized, blockId = 'synthetic-link') => context.buildConversationConnectorLinkBlock(match, provider, authorized, blockId),
    completeConnectorLink: (block, rawUrl, resolved) => context.completeConversationConnectorLinkBlock(block, rawUrl, resolved),
    connectorCandidateMatches: (candidate, ids) => context.candidateMatchesInputIds(candidate, new Set(ids)),
    paste,
    inputLength: text => context.getInputTextLength(text),
    longTextContent: block => context.getLongTextContent(block),
    isAttachment: block => context.isInputAttachmentBlock(block),
    planBuddyRestore: options => context.planBuddyHomeRestore(options),
    preparedInput: input => context.mapPreparedContextToHomeInput(input),
    zeroWidth,
  };
}
