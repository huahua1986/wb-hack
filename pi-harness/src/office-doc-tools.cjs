'use strict';

const batch = require('./office-doc-batch.cjs');

// These tools only query the turn's private editor, or mutate its in-memory copy.
const queries = [
  'doc_find', 'doc_get_comments', 'doc_get_images', 'doc_get_last_operable_pos',
  'doc_get_outline', 'doc_get_paragraph_property', 'doc_get_section_property',
  'doc_get_table_info', 'doc_get_text_property', 'doc_get_word_art_info',
  'doc_list_sections', 'doc_list_tables', 'doc_list_text_boxes_shapes',
  'doc_list_textbox_and_comment', 'doc_resolve_document_structure',
];
const edits = [
  'doc_apply_named_style', 'doc_clear_format', 'doc_copy_format',
  'doc_delete_comment', 'doc_delete_footnote', 'doc_delete_paragraph',
  'doc_delete_section_break', 'doc_delete_shapes', 'doc_delete_table',
  'doc_delete_table_column', 'doc_delete_table_row', 'doc_find_and_replace', 'doc_find_and_set',
  'doc_insert_border', 'doc_insert_comment', 'doc_insert_footer', 'doc_insert_footnote',
  'doc_insert_page_break', 'doc_insert_paragraph', 'doc_insert_section_break', 'doc_insert_table',
  'doc_insert_table_cols', 'doc_insert_table_column', 'doc_insert_table_row',
  'doc_insert_table_rows', 'doc_insert_text', 'doc_insert_toc', 'doc_insert_word_art',
  'doc_merge_table_cells', 'doc_modify_paragraph', 'doc_modify_section', 'doc_move_content',
  'doc_replace_text', 'doc_set_block_quote', 'doc_set_highlight_block', 'doc_set_page_number',
  'doc_set_table_properties', 'doc_undo_ai_edit', 'doc_unmerge_table_cells',
  'doc_update_named_style', 'doc_update_text_property',
];

function inlineMarkdown(value) {
  return typeof value === 'string' && value.trim().length > 0 &&
    !/(?:file|base64file):|<|!\s*\[|\]\s*\(|^\s*\[[^\]]*\]\s*:/im.test(value);
}

function inlineHtml(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  // The accepted fragment has no attributes, active content, or resource references.
  const tags = /<\/?(?:p|h[1-6]|strong|em|b|i|u|s|br|ul|ol|li|blockquote|pre|code|table|thead|tbody|tr|th|td|span|div)\s*\/?>/gi;
  return !/[<>]|&(?:lt|gt|#0*(?:60|62)|#x0*(?:3c|3e));?/i.test(value.replace(tags, ''));
}

const mathCommands = new Set((
  'frac dfrac tfrac sqrt sum prod int iint iiint oint lim log ln exp sin cos tan arcsin arccos arctan ' +
  'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi omicron pi ' +
  'varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma ' +
  'Upsilon Phi Psi Omega infinity infty partial nabla mathbb mathbf mathrm mathit mathcal text operatorname ' +
  'left right big Big bigg Bigg overline underline hat bar tilde vec dot ddot overbrace underbrace ' +
  'cdot times div pm mp approx sim simeq cong neq ne ge geq le leq in ni notin subset subseteq supset ' +
  'supseteq cup cap land lor neg forall exists to mapsto rightarrow leftarrow leftrightarrow Rightarrow ' +
  'Leftarrow Leftrightarrow langle rangle lceil rceil lfloor rfloor ldots cdots vdots ddots quad qquad'
).split(/\s+/));
function inlineMath(value) {
  return typeof value === 'string' && value.trim().length > 0 &&
    [...value.matchAll(/\\([A-Za-z]+|.)/g)].every(([, command]) =>
      mathCommands.has(command) || /^[,;:! {}\[\]()%$#&_\\]$/.test(command));
}

// These object fields are documented by SDK 0.0.0.592, but it returns opaque
// object schemas for paragraph insertion and mixed text runs.
const boolean = { type: 'boolean' };
const color = { type: 'string', pattern: '^[0-9a-fA-F]{6}$' };
const textFormat = {
  type: 'object',
  properties: {
    bold: boolean, italic: boolean, strikethrough: boolean, double_strike: boolean, small_caps: boolean,
    underline: { oneOf: [boolean, { type: 'object', properties: { style: { type: 'string' }, color } }] },
    color, background_color: color, highlight: { type: 'string' },
    font_size: { type: 'number', minimum: 1, maximum: 1000 }, font_family: { type: 'string' },
    vertical_align: { type: 'string', enum: ['baseline', 'superscript', 'subscript'] },
  },
};
const paragraphFormat = {
  type: 'object',
  properties: {
    jc: { type: 'string', enum: ['left', 'center', 'right', 'both', 'distribute'] },
    spacing_before: { type: 'number' }, spacing_after: { type: 'number' }, line_spacing: { type: 'number' },
    line_spacing_rule: { type: 'integer', enum: [1, 2, 3] },
    heading_lvl: { type: 'integer', minimum: 1, maximum: 9 },
  },
};

module.exports = new Map([
  ...queries.map(name => [name, { effect: 'read' }]),
  ...edits.map(name => [name, { effect: 'edit' }]),
  ['doc_compare_documents', { effect: 'read', fileIds: ['other_file_id'], omit: ['other_file_path'],
    validate: args => typeof args.other_file_id === 'string' && args.other_file_id.length > 0 }],
  ['doc_convert_to_html', { effect: 'read', omit: ['image_dir', 'output_path'] }],
  ['doc_copy_content_from', { effect: 'edit', fileIds: ['source_file_id'], omit: ['source_file_path'],
    validate: args => typeof args.source_file_id === 'string' && args.source_file_id.length > 0 }],
  ['doc_copy_format_from', { effect: 'edit', fileIds: ['source_file_id'], omit: ['format_blob'],
    validate: args => typeof args.source_file_id === 'string' && args.source_file_id.length > 0 }],
  ['doc_insert_header', { effect: 'edit', omit: ['parts.*.code', 'parts.*.switches'] }],
  ['doc_insert_html_content', { effect: 'edit', validate: args => inlineHtml(args.html_text) }],
  ['doc_insert_image', { effect: 'edit', assets: ['image_path'], omit: ['content'],
    validate: args => typeof args.image_path === 'string' && args.image_path.length > 0 }],
  ['doc_insert_markdown', { effect: 'edit', omit: ['base64_markdown'], validate: args => inlineMarkdown(args.markdown) }],
  ['doc_insert_math', { effect: 'edit', validate: args => inlineMath(args.latex) }],
  ['doc_insert_normal_link', { effect: 'edit', links: ['link'] }],
  ['doc_insert_paragraph_with_text', {
    effect: 'edit', assets: ['runs.*.image_path'], omit: ['runs.*.content'],
    schemaOverrides: { text_format: textFormat, paragraph_property: paragraphFormat, 'runs.*.format': textFormat },
    validate: args => args.runs === undefined || (Array.isArray(args.runs) && args.runs.every(run =>
      run.type === 'image' ? typeof run.image_path === 'string' && run.image_path.length > 0
        : run.type === 'math' ? inlineMath(run.latex) : run.type === 'text' || run.type === undefined)),
  }],
  ['doc_list_recent_ai_edits', { effect: 'read', omit: ['record_dir'] }],
  ['doc_register_named_styles', { effect: 'edit', fileIds: ['styles.*.source_file_id'] }],
  ['doc_replace_image', { effect: 'edit', assets: ['new_image_path'], omit: ['new_content'],
    validate: args => typeof args.new_image_path === 'string' && args.new_image_path.length > 0 }],
  ['doc_set_document_style', { effect: 'edit', fileIds: ['doc_defaults_source_file_id', 'theme_source_file_id'] }],
  ['doc_set_table_cells', { effect: 'edit', assets: ['cells.*.image.content'], links: ['cells.*.link.url'] }],
  ['doc_batch_execute', batch],
]);
