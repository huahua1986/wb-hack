'use strict';

const policies = new Map([
  ...require('./office-slide-tools.cjs'),
  ...require('./office-doc-tools.cjs'),
  ...require('./office-sheet-tools.cjs'),
  ...require('./office-mind-tools.cjs'),
  ['find', { effect: 'read', family: 'sheet', validate: args => args.use_regex !== true }],
]);
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const FAMILIES = new Set(['slide', 'doc', 'sheet', 'mind']);
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function familyOf(name, policy) { return policy.family ?? name.split('_', 1)[0]; }

function catalogSchema(schema, omitted, prefix = '', overrides = {}, partial = false) {
  if (!object(schema)) return {};
  const next = { ...schema };
  delete next.$ref;
  if (object(schema.properties)) {
    next.properties = Object.fromEntries(Object.entries(schema.properties).flatMap(([key, value]) => {
      const at = prefix ? prefix + '.' + key : key;
      return omitted.has(at) || DANGEROUS_KEYS.has(key) ? []
        : [[key, catalogSchema(own(overrides, at) ? overrides[at] : value, omitted, at, overrides)]];
    }));
    if (Array.isArray(schema.required)) next.required = schema.required.filter(key => own(next.properties, key));
    next.additionalProperties = object(schema.additionalProperties)
      ? catalogSchema(schema.additionalProperties, omitted, prefix ? prefix + '.*' : '*', overrides)
      : partial && schema.additionalProperties !== false;
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(schema[key])) {
      next[key] = schema[key].map(item => catalogSchema(item, omitted, prefix, overrides, partial || object(schema.properties)));
    }
  }
  if (object(schema.items)) {
    const at = prefix ? prefix + '.*' : '*';
    next.items = catalogSchema(own(overrides, at) ? overrides[at] : schema.items, omitted, at, overrides);
  }
  return next;
}

function descriptionOf(tool, policy) {
  if (!object(tool?.inputSchema) || tool.inputSchema.type !== 'object') return null;
  const schema = catalogSchema(policy.inputSchema ?? tool.inputSchema, new Set(policy.omit ?? []), '', policy.schemaOverrides);
  if (!object(schema.properties) || !own(schema.properties, 'file_id')) return null;
  schema.properties.file_id = { type: 'string', description: '当前轮次打开或新建文档得到的 file_id。' };
  schema.required = [...new Set([...(schema.required ?? []), ...(policy.required ?? []), 'file_id'])];
  return { name: tool.name, family: familyOf(tool.name, policy), effect: policy.effect, description: String(tool.description ?? ''), inputSchema: schema };
}

function matches(value, schema, partial = false) {
  if (!object(schema)) return false;
  if (Array.isArray(schema.required) && (!object(value) || schema.required.some(key => !own(value, key)))) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (own(schema, 'const') && schema.const !== value) return false;
  // A conditional overlay checks its named properties; the enclosing schema checks the rest.
  const overlay = partial || object(schema.properties);
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(schema[key]) && !schema[key].some(branch => matches(value, branch, overlay))) return false;
  }
  if (Array.isArray(schema.allOf) && !schema.allOf.every(branch => matches(value, branch, overlay))) return false;
  if (Array.isArray(schema.type)) return schema.type.some(type => matches(value, { ...schema, type }));
  const type = schema.type;
  if (type === 'object' || object(schema.properties)) {
    if (!object(value) || (schema.required ?? []).some(key => !own(value, key))) return false;
    if (!schema.properties && (schema.oneOf || schema.anyOf || schema.allOf)) return true;
    return Object.entries(value).every(([key, item]) => {
      if (DANGEROUS_KEYS.has(key)) return false;
      const properties = schema.properties ?? {};
      if (partial && !own(properties, key) && schema.additionalProperties === true) return true;
      return matches(item, own(properties, key) ? properties[key] : schema.additionalProperties);
    });
  }
  if (type === 'array') return Array.isArray(value) && value.length <= (schema.maxItems ?? 2048) &&
    value.length >= (schema.minItems ?? 0) && value.every(item => matches(item, schema.items ?? {}));
  if (type === 'string') return typeof value === 'string' && value.length <= (schema.maxLength ?? 32768) &&
    value.length >= (schema.minLength ?? 0) && !value.includes('\0') &&
    (typeof schema.pattern !== 'string' || new RegExp(schema.pattern, 'u').test(value));
  if (type === 'number' || type === 'integer') return typeof value === 'number' && Number.isFinite(value) &&
    (type !== 'integer' || Number.isSafeInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity)
    && value > (schema.exclusiveMinimum ?? -Infinity) && value < (schema.exclusiveMaximum ?? Infinity);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  if (type === undefined && Array.isArray(value) && (schema.minItems !== undefined || schema.maxItems !== undefined)) {
    return value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? 2048);
  }
  if (type === undefined && typeof value === 'string' && (schema.minLength !== undefined || schema.maxLength !== undefined || schema.pattern !== undefined)) {
    return matches(value, { ...schema, type: 'string' });
  }
  return Boolean(schema.oneOf || schema.anyOf || schema.allOf || schema.required) ||
    value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function atPaths(value, patterns, visit) {
  const step = (parent, parts) => {
    if (parent === null || typeof parent !== 'object') return;
    const [part, ...remaining] = parts;
    const keys = part === '*' ? Object.keys(parent) : own(parent, part) ? [part] : [];
    for (const key of keys) {
      if (remaining.length) step(parent[key], remaining);
      else visit(parent, key);
    }
  };
  for (const pattern of patterns ?? []) step(value, pattern.split('.'));
}

function safeLink(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || /[\x00-\x20]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

function listFamily(catalog, family) {
  if (!FAMILIES.has(family)) return null;
  return [...policies].flatMap(([name, policy]) => {
    if (familyOf(name, policy) !== family) return [];
    const schema = descriptionOf(catalog.get(name), policy);
    return schema ? [{ name, effect: policy.effect }] : [];
  });
}
function describeTool(catalog, name) {
  const policy = policies.get(name);
  return policy && descriptionOf(catalog.get(name), policy);
}
function prepareTool(catalog, name, effect, args, context) {
  const { invalid, validateHandle, stageAsset } = context;
  const policy = policies.get(name);
  const schema = describeTool(catalog, name);
  if (!schema || policy.effect !== effect || !object(args) || (!policy.prepareBatch && !matches(args, schema.inputSchema))) throw invalid();
  const input = structuredClone(args);
  atPaths(input, policy.omit, () => { throw invalid(); });
  if (policy.validate && !policy.validate(input)) throw invalid();
  atPaths(input, ['file_id', ...(policy.fileIds ?? [])], (parent, key) => validateHandle(parent[key], schema.family));
  atPaths(input, policy.links, (parent, key) => { if (!safeLink(parent[key])) throw invalid(); });
  atPaths(input, policy.assets, (parent, key) => { parent[key] = stageAsset(parent[key]); });
  if (policy.prepareBatch) policy.prepareBatch(input, {
    invalid, prepareChild: (child, childArgs) => prepareTool(catalog, child, 'edit', childArgs, context).input,
  });
  return { input, family: schema.family };
}

module.exports = { listFamily, describeTool, prepareTool };
