'use strict';

// The SDK derives these anchors from the preceding insert in the same block.
const anchorFields = new Set([
  'file_id', 'idx', 'paragraph_id', 'paragraph_ids', 'ranges',
  'table_id', 'table_locate', 'section_id', 'section_index',
]);
const blocks = {
  paragraph: {
    insert: 'doc_insert_paragraph_with_text',
    after: ['doc_set_block_quote', 'doc_set_highlight_block', 'doc_modify_paragraph',
      'doc_insert_border', 'doc_apply_named_style'],
  },
  table: {
    insert: 'doc_insert_table',
    after: ['doc_set_table_properties', 'doc_set_table_cells',
      'doc_merge_table_cells', 'doc_unmerge_table_cells'],
  },
  toc: { insert: 'doc_insert_toc', after: ['doc_insert_page_break'] },
  styles: { after: ['doc_set_document_style', 'doc_update_named_style', 'doc_register_named_styles'] },
  section: {
    insert: 'doc_insert_section_break',
    after: ['doc_modify_section', 'doc_insert_header', 'doc_insert_footer', 'doc_set_page_number'],
  },
};
const paragraphLists = new Set(['doc_set_block_quote', 'doc_set_highlight_block', 'doc_apply_named_style']);
const paragraphAnchors = new Set(['doc_modify_paragraph', 'doc_insert_border']);
const maxBlocks = 64, maxCalls = 128;

function exactObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key));
}

function prepareDocBatch(input, { invalid, prepareChild }) {
  const source = Array.isArray(input.blocks) ? input.blocks : [input.blocks];
  if (!exactObject(input, ['file_id', 'idx', 'blocks']) || typeof input.file_id !== 'string' ||
    !input.file_id || (input.idx !== undefined && (!Number.isSafeInteger(input.idx) || input.idx < -1)) ||
    source.length < 1 || source.length > maxBlocks) throw invalid();

  let callCount = 0;
  input.blocks = source.map((block, blockIndex) => {
    if (!exactObject(block, ['block', 'calls']) || typeof block.block !== 'string' ||
      !Object.hasOwn(blocks, block.block) || !Array.isArray(block.calls) || block.calls.length === 0 ||
      (block.block === 'styles' && blockIndex !== 0)) throw invalid();
    callCount += block.calls.length;
    if (callCount > maxCalls) throw invalid();
    const { insert, after } = blocks[block.block];
    return { block: block.block, calls: block.calls.map((call, callIndex) => {
      if (!exactObject(call, ['tool', 'args'])) throw invalid();
      const inserts = callIndex === 0 && Boolean(insert);
      if (inserts ? call.tool !== insert : !after.includes(call.tool)) throw invalid();
      const args = call.args === undefined ? {} : call.args;
      if (args === null || typeof args !== 'object' || Array.isArray(args) ||
        Object.keys(args).some(key => anchorFields.has(key))) throw invalid();
      if (call.tool === 'doc_set_page_number' && args.scope !== 'current_section') throw invalid();

      // Validate with placeholders for SDK-provided positions, then remove them before dispatch.
      const injected = { file_id: input.file_id };
      if (inserts || call.tool === 'doc_insert_page_break') injected.idx = 0;
      if (paragraphLists.has(call.tool)) injected.paragraph_ids = ['batch-anchor'];
      if (paragraphAnchors.has(call.tool)) injected.paragraph_id = 'batch-anchor';
      const checked = prepareChild(call.tool, { ...args, ...injected });
      for (const key of Object.keys(injected)) delete checked[key];
      return { tool: call.tool, args: checked };
    }) };
  });
  return input;
}

module.exports = { effect: 'edit', prepareBatch: prepareDocBatch };
