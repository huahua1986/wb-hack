import assert from 'node:assert/strict';
import test from 'node:test';
import docTools from '../src/office-doc-tools.cjs';
import catalogTools from '../src/office-tool-catalog.cjs';

test('Word policies scope cross-document handles and replace native path aliases with staged assets', () => {
  assert.equal(docTools.size, 73);
  assert.equal(docTools.get('doc_batch_execute').effect, 'edit');
  assert.deepEqual(docTools.get('doc_convert_to_html').omit, ['image_dir', 'output_path']);
  assert.deepEqual(docTools.get('doc_list_recent_ai_edits').omit, ['record_dir']);
  for (const [name, handle, filename] of [
    ['doc_compare_documents', 'other_file_id', 'other_file_path'],
    ['doc_copy_content_from', 'source_file_id', 'source_file_path'],
  ]) {
    const policy = docTools.get(name);
    assert.deepEqual(policy.fileIds, [handle]);
    assert.deepEqual(policy.omit, [filename]);
    assert.equal(policy.validate({ [filename]: '/other.docx' }), false);
    assert.equal(policy.validate({ [handle]: 'owned-document' }), true);
  }
  assert.deepEqual(docTools.get('doc_register_named_styles').fileIds, ['styles.*.source_file_id']);
  assert.deepEqual(docTools.get('doc_set_document_style').fileIds, ['doc_defaults_source_file_id', 'theme_source_file_id']);
  assert.deepEqual(docTools.get('doc_insert_image').assets, ['image_path']);
  assert.deepEqual(docTools.get('doc_insert_image').omit, ['content']);
  assert.deepEqual(docTools.get('doc_insert_paragraph_with_text').assets, ['runs.*.image_path']);
  assert.deepEqual(docTools.get('doc_set_table_cells').assets, ['cells.*.image.content']);
});

function batchFixture() {
  const string = { type: 'string' }, integer = { type: 'integer' }, object = { type: 'object' };
  const tool = (name, properties, required = [], extra = {}) => [name, { name, inputSchema: {
    type: 'object', properties: { ...properties, file_id: string }, required, ...extra,
  } }];
  return new Map([
    tool('doc_batch_execute', { blocks: { type: 'array' }, idx: integer }, ['blocks']),
    tool('doc_insert_paragraph_with_text', { idx: integer, text: string, runs: { type: 'array', items: {
      type: 'object', properties: { type: string, text: string, image_path: string, format: object },
    } } }, ['idx']),
    tool('doc_apply_named_style', { named_style_type: string, target_style_id: string, ranges: { type: 'array' },
      paragraph_ids: { type: 'array', items: string } }, [], { allOf: [
      { oneOf: [
        { properties: { target_style_id: { maxLength: 0 } }, required: ['named_style_type'] },
        { properties: { named_style_type: { maxLength: 0 } }, required: ['target_style_id'] },
      ] },
      { oneOf: [
        { properties: { paragraph_ids: { minItems: 1 } }, required: ['paragraph_ids'] },
        { properties: { ranges: { minItems: 1 } }, required: ['ranges'] },
      ] },
    ] }),
    tool('doc_insert_section_break', { idx: integer }, ['idx']),
    tool('doc_set_page_number', { scope: string, section_id: string }),
  ]);
}

test('Word batch validates each allowed child and strips synthetic anchors while retaining staged assets', () => {
  const handles = [], assets = [];
  const context = {
    invalid: () => Error('invalid batch'),
    validateHandle(id, family) { handles.push([id, family]); },
    stageAsset(asset) { assets.push(asset); return '/private/staging/image.png'; },
  };
  const children = [
    { tool: 'doc_insert_paragraph_with_text', args: { runs: [
      { text: 'Title', format: { bold: true } },
      { type: 'image', image_path: 'local-image.png' },
    ] } },
    { tool: 'doc_apply_named_style', args: { named_style_type: 'HEADING_1' } },
  ];
  const { input } = catalogTools.prepareTool(batchFixture(), 'doc_batch_execute', 'edit', {
    file_id: 'owned', blocks: { block: 'paragraph', calls: children },
  }, context);
  assert.deepEqual(input.blocks, [{ block: 'paragraph', calls: [
    { tool: 'doc_insert_paragraph_with_text', args: { runs: [
      { text: 'Title', format: { bold: true } },
      { type: 'image', image_path: '/private/staging/image.png' },
    ] } },
    children[1],
  ] }]);
  assert.deepEqual(handles, [['owned', 'doc'], ['owned', 'doc'], ['owned', 'doc']]);
  assert.deepEqual(assets, ['local-image.png']);
});

test('Word batch rejects alternate dispatch, injected selectors and whole-document page numbering', () => {
  const context = { invalid: () => Error('invalid batch'), validateHandle() {},
    stageAsset() { assert.fail('invalid asset must not be staged'); } };
  const insert = { tool: 'doc_insert_paragraph_with_text', args: { text: 'Test' } };
  for (const block of [
    { block: 'paragraph', calls: [{ ...insert, args: { text: 'Test', file_id: 'foreign' } }] },
    { block: 'paragraph', calls: [insert, { tool: 'save_file', args: { file_path: '/outside' } }] },
    { block: 'paragraph', calls: [insert, { tool: 'doc_apply_named_style', args: {
      named_style_type: 'HEADING_1', ranges: [{ begin: 0, end: 1 }],
    } }] },
    { block: 'paragraph', calls: [insert, { tool: 'doc_apply_named_style', args: {
      named_style_type: 'HEADING_1', target_style_id: 'Other',
    } }] },
    { block: 'section', calls: [{ tool: 'doc_insert_section_break' },
      { tool: 'doc_set_page_number', args: { scope: 'whole_doc' } }] },
  ]) {
    assert.throws(() => catalogTools.prepareTool(batchFixture(), 'doc_batch_execute', 'edit', {
      file_id: 'owned', blocks: [block],
    }, context), /invalid batch/);
  }
});

test('Word markup allows local formatting and blocks embedded resources and executable syntax', () => {
  const markdown = docTools.get('doc_insert_markdown');
  assert.deepEqual(markdown.omit, ['base64_markdown']);
  assert.equal(markdown.validate({ markdown: '# 标题\n\n- 本地内容' }), true);
  for (const input of [
    'file:///etc/passwd', '  base64file:///tmp/source', '![pic](https://example.org/img.png)',
    '<img src="/tmp/private.png">', '[doc](file:///tmp/a.docx)', '[img]: /tmp/a.png',
  ]) assert.equal(markdown.validate({ markdown: input }), false, input);

  const html = docTools.get('doc_insert_html_content');
  assert.equal(html.validate({ html_text: '<h1>标题</h1><p><strong>正文</strong></p>' }), true);
  for (const input of [
    '<img src="https://example.org/image.png">', '<p onclick="alert(1)">文本</p>',
    '<style>p{background:url(file:///tmp/private.png)}</style>', '&lt;img&gt;',
  ]) assert.equal(html.validate({ html_text: input }), false, input);

  const math = docTools.get('doc_insert_math');
  assert.equal(math.validate({ latex: '\\frac{\\alpha}{\\sqrt{x}}' }), true);
  assert.equal(math.validate({ latex: '\\input{/etc/passwd}' }), false);
  assert.equal(docTools.get('doc_insert_paragraph_with_text').validate({
    runs: [{ type: 'text', text: 'Formula' }, { type: 'math', latex: '\\write18{open}' }],
  }), false);
});
