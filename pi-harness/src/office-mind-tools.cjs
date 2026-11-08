'use strict';

const color = { type: 'string', pattern: '^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$' };
const fontFamily = { type: 'string', minLength: 1, maxLength: 128 };
const fontSize = { type: 'number', minimum: 1, maximum: 512 };
const lineWidth = { type: 'number', minimum: 0, maximum: 128 };
const styleObject = properties => ({ type: 'object', properties, additionalProperties: false });

// The SDK describes these style objects in prose and publishes no properties.
// Declare only known typed fields, so an opaque payload never reaches the SDK.
const nodeStyle = styleObject({
  fill: color,
  color,
  borderColor: color,
  borderLineWidth: lineWidth,
  lineColor: color,
  lineWidth,
  fontFamily,
  fontSize,
  fontWeight: { type: 'string', pattern: '^(normal|bold|[1-9]00)$' },
  textAlign: { type: 'string', enum: ['left', 'center', 'right'] },
  underline: { type: 'boolean' },
});
const titleStyle = styleObject({
  color,
  background: color,
  fontFamily,
  fontSize,
  fontWeight: { type: 'number', minimum: 100, maximum: 900 },
  italic: { type: 'boolean' },
  underline: { type: 'boolean' },
  strike: { type: 'boolean' },
});
const themeStyle = styleObject({
  properties: styleObject({ fill: { ...color, pattern: '^(?:#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))?$' } }),
});

function safeHref(value) {
  if (value === '') return true;
  if (/^mailto:[^\s@:/\\]+@[^\s@:/\\]+\.[a-zA-Z]{2,}$/i.test(value)) return true;
  try {
    const url = new URL(value);
    return /^https?:\/\//i.test(value) && !url.username && !url.password && !/[\x00-\x20\x7f]/.test(value);
  } catch { return false; }
}

const readTools = ['get_dirty', 'get_info', 'get_node', 'get_outline', 'get_theme'];
const editTools = [
  'add_boundary', 'add_detached_node', 'add_label', 'add_node', 'add_nodes', 'add_relationship',
  'add_summary', 'add_tab', 'find_replace_text', 'move_node', 'move_tab', 'remove_boundary',
  'remove_label', 'remove_marker', 'remove_node_attachment', 'remove_node_image', 'remove_nodes',
  'remove_relationship', 'remove_summary', 'remove_tab', 'rename_tab', 'reorder_children',
  'set_boundary_title', 'set_image_align', 'set_node_collapse', 'set_node_notes', 'set_node_structure',
  'set_relation_title', 'set_text', 'undo_ai_edit', 'update_label', 'update_node_image',
];

const policies = new Map([
  ...readTools.map(name => [name, { effect: 'read' }]),
  ...editTools.map(name => [name, { effect: 'edit' }]),
  ['add_marker', { effect: 'edit', omit: ['url'], validate: args => /^[A-Za-z0-9_-]{1,128}$/.test(args.marker_id) }],
  ['add_node_image', { effect: 'edit', assets: ['image', 'image_path'], omit: ['url', 'filename'],
    validate: args => Boolean(args.image) !== Boolean(args.image_path) }],
  ['add_node_attachment', { effect: 'edit', omit: ['url', 'obj_key'], required: ['filename'], schemaOverrides: {
    filename: { type: 'string', minLength: 1, maxLength: 4096, description: '任务工作目录内的本地附件路径。' },
    name: { type: 'string', minLength: 1, maxLength: 256, description: '脑图中显示的附件名称。' },
    classify: { type: 'string', enum: ['video', 'audio', 'doc', 'image', 'default', 'zip'] },
  }, validate: args => typeof args.filename === 'string' && Boolean(args.filename.trim()) }],
  ['list_recent_ai_edits', { effect: 'read', omit: ['record_dir'] }],
  ['set_node_href', { effect: 'edit', validate: args => safeHref(args.href) }],
  ['set_node_style', { effect: 'edit', schemaOverrides: { style: nodeStyle } }],
  ['set_relationship_style', { effect: 'edit', schemaOverrides: { style: nodeStyle } }],
  ['set_theme', { effect: 'edit', schemaOverrides: { style: themeStyle },
    validate: args => args.topic === undefined || /^[A-Za-z0-9_.-]{1,128}$/.test(args.topic) && !args.topic.includes('..') }],
  ['set_title_range_style', { effect: 'edit', schemaOverrides: { style: titleStyle } }],
]);

module.exports = new Map([...policies].map(([name, policy]) => ['mind_' + name, policy]));
