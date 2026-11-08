import assert from 'node:assert/strict';
import test from 'node:test';
import { describeTool, listFamily, prepareTool } from '../src/office-tool-catalog.cjs';

const name = 'sheet_update_pivot_table';
const sdkCatalog = new Map([[name, {
  name,
  description: 'Update pivot groups and values',
  inputSchema: {
    type: 'object',
    properties: [
      ['file_id', { type: 'string' }],
      ['sheet_id', { type: 'string' }],
      ['pivot_table_id', { type: 'string' }],
      ['properties', [['row_groups', { type: 'array' }]]],
      ['required', ['sheet_id', 'pivot_table_id']],
    ],
  },
}]]);
const args = {
  file_id: 'owned-editor',
  sheet_id: '000001',
  pivot_table_id: 'pivot-smoke',
  row_groups: [{ source_data_column: 0, sort_type: 'desc' }],
  column_groups: [{ source_data_column: 1 }],
  pivot_values: [{ source_data_column: 2, summarize_function: 'SUM', display_name: 'Sales' }],
  calculated_values: [{ name: 'Double sales', formula: "='Sale Price'*2" }],
  style_name: 'PivotStyleLight16',
};
const options = {
  invalid: () => new Error('invalid pivot arguments'),
  validateHandle(id, family) {
    assert.equal(family, 'sheet');
    if (id !== 'owned-editor') throw new Error('unknown editor');
  },
};
const prepare = input => prepareTool(sdkCatalog, name, 'edit', input, options);

test('pivot update advertises the verified object schema despite the SDK tuple schema', () => {
  assert.deepEqual(listFamily(sdkCatalog, 'sheet'), [{ name, effect: 'edit' }]);
  const descriptor = describeTool(sdkCatalog, name);
  assert.deepEqual(descriptor.inputSchema.required, ['file_id', 'sheet_id', 'pivot_table_id']);
  assert.equal(descriptor.inputSchema.properties.row_groups.items.type, 'object');
  assert.deepEqual(prepare(args), { input: args, family: 'sheet' });
  assert.throws(() => prepare({ ...args, file_id: 'foreign-editor' }), /unknown editor/);
});

test('pivot update rejects external formulas and unrecognized nested SDK arguments', () => {
  for (const formula of [
    '=WEBSERVICE("https://example.invalid/")',
    "='[other.xlsx]Sheet1'!A1",
    '=file:///etc/passwd',
  ]) {
    assert.throws(() => prepare({ ...args, calculated_values: [{ name: 'external', formula }] }), /invalid pivot/);
  }
  assert.throws(() => prepare({ ...args, source_sheet_id: '000002' }), /invalid pivot/);
  assert.throws(() => prepare({ ...args, row_groups: [{ source_data_column: 0, file_path: '/tmp/other.xlsx' }] }), /invalid pivot/);
  assert.throws(() => prepare({ ...args, pivot_values: [{ source_data_column: 2, summarize_function: 'WEBSERVICE' }] }), /invalid pivot/);
});
