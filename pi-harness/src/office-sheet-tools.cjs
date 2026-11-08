'use strict';

// The SDK can evaluate functions when a workbook is saved or opened. Only permit
// expressions built from local cell references, literals and known local functions.
const LOCAL_FUNCTIONS = new Set((
  'ABS AND AVERAGE AVERAGEIF AVERAGEIFS CEILING CHAR CHOOSE CLEAN COLUMN COLUMNS CONCAT CONCATENATE ' +
  'COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS DATE DATEDIF DAY EDATE EOMONTH EVEN EXACT FIND FLOOR ' +
  'HLOOKUP IF IFERROR IFNA IFS INDEX INT ISBLANK ISERROR ISNA ISNUMBER ISTEXT LARGE LEFT LEN ' +
  'LOWER MATCH MAX MAXIFS MEDIAN MID MIN MINIFS MOD MONTH NOT NOW OR PERCENTILE PERCENTILE.INC ' +
  'POWER PRODUCT PROPER RANK RANK.EQ REPLACE RIGHT ROUND ROUNDDOWN ROUNDUP ROW ROWS SEARCH ' +
  'SIGN SMALL SQRT STDEV STDEV.S SUBSTITUTE SUM SUMIF SUMIFS SUMPRODUCT TEXT TEXTJOIN TIME TODAY ' +
  'TRIM TRUNC UPPER VALUE VLOOKUP WEEKDAY XLOOKUP XMATCH XOR YEAR'
).split(' '));

function localFormula(value, pivotFields = false) {
  if (typeof value !== 'string' || value.length > 8192 || !value.trim()) return false;
  let expression = value.trim()
    .replace(/"(?:[^"\r\n]|"")*"/g, '0')
    .replace(/'(?:[^'\r\n\[\]|:\\/!]|'')+'!/g, '')
    .replace(/(?<![\p{L}\p{N}_.])[\p{L}_][\p{L}\p{N}_.]*!/gu, '')
    .replace(/[\p{L}_][\p{L}\p{N}_.]*(?=\s*\()/gu, name => LOCAL_FUNCTIONS.has(name.toUpperCase()) ? '' : '@')
    .replace(/(?<![\p{L}\p{N}_.])\$?[A-Z]{1,3}\$?[1-9]\d*(?![\p{L}\p{N}_.])/giu, '0')
    .replace(/\b(?:TRUE|FALSE)\b/gi, '0')
    .replace(/\b\d+(?:\.\d+)?e[+-]?\d+\b/gi, '0');
  // Calculated pivot fields refer to source header names, such as Sales or
  // 'Sale Price'. Function calls were checked above, including unknown names.
  if (pivotFields === true) {
    if (expression.includes('://')) return false;
    expression = expression.replace(/'[\p{L}\p{N} _.\-]+'|[\p{L}_][\p{L}\p{N}_.]*/gu, '0');
  }
  return /^[0-9.+\-*/^%&=<>():, \t]+$/.test(expression);
}

const optionalFormula = value => value === undefined || localFormula(value);

function localRanges(values) {
  return values === undefined || values.every(value =>
    /^(?:[A-Za-z0-9_-]+\$)?\$?[A-Z]{1,3}\$?[1-9]\d*(?::\$?[A-Z]{1,3}\$?[1-9]\d*)?$/i.test(value));
}

function conditionalFormat(args) {
  return localRanges(args.ranges) && optionalFormula(args.rule?.expression?.formula)
    && (args.rule?.cell_is?.formulas ?? []).every(localFormula);
}

function dataValidation(args) {
  const literal = /^(?:[+-]?(?:\d+(?:\.\d+)?|\.\d+)|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}:\d{2}(?::\d{2})?)$/;
  return localRanges(args.ranges) && [args.formula1, args.formula2].every(value => value === undefined || literal.test(value));
}

function plainCellText(value) {
  const text = value.trimStart();
  return !/^[=+\-@]/.test(text) || /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trimEnd());
}

function literalCsv(value) {
  // A quoted field can contain commas, escaped quotes and newlines. Validate
  // the value of each cell, including formula-like prefixes in quoted cells.
  const field = /(?:"((?:[^"]|"")*)"|([^",\r\n]*))(,|\r\n|\n|\r|$)/y;
  for (let offset = 0; offset < value.length;) {
    field.lastIndex = offset;
    const match = field.exec(value);
    if (!match || field.lastIndex === offset || !plainCellText(match[1] ?? match[2])) return false;
    offset = field.lastIndex;
  }
  return true;
}

function sheetLink({ link_type: type, url }) {
  if (type === 'worksheet') return /^[a-zA-Z0-9_-]{1,128}$/.test(url);
  if (type === 'email') return /^[^\s@:/\\]+@[^\s@:/\\]+\.[a-zA-Z]{2,}$/.test(url);
  if (type === 'phone') return /^\+?[\d() -]{3,32}$/.test(url);
  try {
    const parsed = new URL(url);
    return /^https?:\/\//i.test(url) && !parsed.username && !parsed.password && !/[\x00-\x20\x7f]/.test(url);
  } catch { return false; }
}

const chartOptions = ['options.dataLabel.textStyle', 'options.series.*.dataLabel.textStyle'];
const string = (description, maxLength = 128) => ({ type: 'string', description, maxLength });
const bool = description => ({ type: 'boolean', description });
const index = (description, maximum = 16383) => ({ type: 'integer', description, minimum: 0, maximum });
const groupColumn = index('数据源列索引，从 0 开始。');
const record = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const list = (description, items) => ({ type: 'array', description, items, maxItems: 256 });
const group = record({
  source_data_column: groupColumn,
  sort_type: string('排序方向，可选 ASC、DESC 或 MANUAL。'),
}, ['source_data_column']);

// SDK 0.0.0.592 advertises this tool's properties and some nested schemas
// as tuple arrays. Its dispatcher accepts the following JSON object fields.
const pivotUpdateSchema = record({
  file_id: string('当前轮次的工作簿句柄。'),
  sheet_id: string('透视表所在子表的 ID。'),
  pivot_table_id: string('当前打开的工作簿内的透视表 ID。'),
  row_groups: list('替换现有行分组。', group),
  column_groups: list('替换现有列分组。', group),
  pivot_values: list('替换现有数据字段。', record({
    source_data_column: groupColumn,
    summarize_function: string('聚合函数，如 SUM、COUNT 或 AVERAGE。'),
    display_name: string('数据字段显示名。', 255),
    show_data_as: string('显示方式，如 NORMAL、DIFFERENCE 或 PERCENT_OF_TOTAL。'),
    base_field: index('用于差异或累计等显示方式的基准数据列。'),
    base_item: index('基准项索引，从 0 开始。', 1048575),
  }, ['source_data_column', 'summarize_function'])),
  filters: list('替换现有页字段筛选器。', record({
    source_data_column: groupColumn,
    visible_values: list('要保留的可见项。', string('源数据项的显示值。', 1024)),
  }, ['source_data_column'])),
  calculated_values: list('替换现有计算字段。', record({
    name: string('计算字段名。', 255),
    formula: string('计算公式，可以引用当前透视表的数据源表头。', 8192),
  }, ['name', 'formula'])),
  compact: bool('是否使用紧凑布局。'),
  row_grand_totals: bool('是否显示行总计。'),
  col_grand_totals: bool('是否显示列总计。'),
  style_name: string('样式主题名，如 PivotStyleLight16。空字符串清除样式。'),
  name: string('新的透视表显示名称。', 255),
  style_show_row_headers: bool('显示行标题。'),
  style_show_col_headers: bool('显示列标题。'),
  style_show_row_stripes: bool('显示行条纹。'),
  style_show_col_stripes: bool('显示列条纹。'),
  source_sheet_id: string('更换数据源时的新子表 ID，须与 source_range 同时提供。'),
  source_range: record({
    start_row: index('起始行，从 0 开始。', 1048575),
    end_row: index('结束行，从 0 开始。', 1048575),
    start_col: index('起始列，从 0 开始。'),
    end_col: index('结束列，从 0 开始。'),
  }, ['start_row', 'end_row', 'start_col', 'end_col']),
}, ['file_id', 'sheet_id', 'pivot_table_id']);

const sortTypes = new Set(['ASC', 'DESC', 'MANUAL']);
const aggregations = new Set(['SUM', 'COUNT', 'COUNTA', 'AVERAGE', 'MAX', 'MIN', 'PRODUCT', 'COUNTNUMS', 'STDEV', 'STDEVP', 'VAR', 'VARP']);
const displayModes = new Set([
  'NORMAL', 'DIFFERENCE', 'PERCENT', 'PERCENT_DIFF', 'RUN_TOTAL',
  'PERCENT_OF_ROW', 'PERCENT_OF_COL', 'PERCENT_OF_TOTAL', 'INDEX',
]);

function pivotUpdate(args) {
  const source = args.source_range;
  const sourceId = args.source_sheet_id;
  if ((source === undefined) !== (sourceId === undefined) ||
      (source && (!sourceId.trim() || source.end_row < source.start_row || source.end_col < source.start_col))) return false;
  if (!args.sheet_id.trim() || !args.pivot_table_id.trim() ||
      (args.style_name !== undefined && !/^[A-Za-z0-9_]*$/.test(args.style_name))) return false;
  return [...(args.row_groups ?? []), ...(args.column_groups ?? [])]
    .every(group => group.sort_type === undefined || sortTypes.has(group.sort_type.toUpperCase())) &&
    (args.pivot_values ?? []).every(value => aggregations.has(value.summarize_function.toUpperCase()) &&
      (value.show_data_as === undefined || displayModes.has(value.show_data_as.toUpperCase()))) &&
    (args.calculated_values ?? []).every(value => value.name.trim() && localFormula(value.formula, true));
}

const readTools = [
  'audit_formula_consistency', 'get_cell_data', 'get_cell_style', 'get_charts',
  'get_defined_names', 'get_dimension_size', 'get_merged_cells', 'get_object_list',
  'get_pivot_table_detail', 'get_sheet_info', 'get_used_range',
];
const editTools = [
  'add_comment', 'add_outline', 'add_pivot_table', 'add_sheet', 'add_table', 'clear_border', 'clear_link',
  'clear_range_all', 'clear_range_cells', 'clear_range_style', 'convert_cell_image_to_float_image',
  'convert_float_image_to_cell_image', 'copy_sheet', 'delete_chart', 'delete_dimension', 'delete_image',
  'delete_outline', 'delete_range', 'delete_sheet', 'insert_dimension', 'insert_range', 'merge_cell',
  'move_dimension', 'move_sheet', 'remove_comment', 'remove_conditional_format', 'remove_defined_name',
  'remove_filter', 'remove_pivot_table', 'rename_sheet', 'revert_revision', 'set_border',
  'set_cell_style', 'set_date_system', 'set_dimension_size', 'set_dimension_visible', 'set_filter', 'set_freeze',
  'set_gridlines_visible', 'set_iterative_calculation', 'set_sheet_visible', 'set_show_zeros', 'set_tab_color',
  'sort_range', 'unmerge_cell', 'unset_freeze', 'update_comment', 'update_filter', 'update_outline',
];

const policies = new Map([
  ...readTools.map(name => [name, { effect: 'read' }]),
  ...editTools.map(name => [name, { effect: 'edit' }]),
  ['add_chart', { effect: 'edit', omit: chartOptions }],
  ['update_chart', { effect: 'edit', omit: chartOptions }],
  ['add_conditional_format', { effect: 'edit', validate: conditionalFormat }],
  ['update_conditional_format', { effect: 'edit', validate: conditionalFormat }],
  ['get_conditional_format', { effect: 'read', validate: args => localRanges(args.ranges) }],
  ['add_defined_name', { effect: 'edit', validate: args => localFormula(args.formula) }],
  ['update_defined_name', { effect: 'edit', validate: args => localFormula(args.formula) }],
  ['calculate_formulas', { effect: 'read', validate: args => args.formulas.every(entry => localFormula(entry.formula)) }],
  ['calculate_single_formula', { effect: 'read', validate: args => localFormula(args.formula) }],
  ['insert_float_image', { effect: 'edit', assets: ['image'] }],
  ['insert_image', { effect: 'edit', assets: ['image'], omit: ['content', 'image_id'], validate: args => Boolean(args.image) }],
  ['multi_add_float_image', { effect: 'edit', assets: ['images.*.image'] }],
  ['update_float_image', { effect: 'edit', assets: ['image'] }],
  ['list_recent_ai_edits', { effect: 'read', omit: ['record_dir'] }],
  ['replace', { effect: 'edit', omit: ['match_formulas', 'use_regex'], validate: args => plainCellText(args.replace_text) }],
  ['set_cell_value', { effect: 'edit', validate: args => optionalFormula(args.cell.formula) }],
  ['set_data_validation', { effect: 'edit', validate: dataValidation }],
  ['set_link', { effect: 'edit', validate: sheetLink }],
  ['set_range_value', { effect: 'edit', validate: args => args.values.every(cell => optionalFormula(cell.formula)) }],
  ['set_range_value_by_csv', { effect: 'edit', validate: args => literalCsv(args.csv_data) }],
  ['update_pivot_table', { effect: 'edit', inputSchema: pivotUpdateSchema, validate: pivotUpdate }],
]);

module.exports = new Map([...policies].map(([name, policy]) => ['sheet_' + name, policy]));
