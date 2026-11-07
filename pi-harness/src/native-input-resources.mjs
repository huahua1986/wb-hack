import { createHash } from 'node:crypto';

const SCENE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const INVALID_LABEL = /[\u0000-\u001f\u007f-\u009f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const INVALID_LONG_TEXT = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const BLOCK_TYPES = new Set(['text', 'image', 'resource_link']);
const DIAGNOSTIC_SCHEMES = new Set(['scene:', 'skill:', 'command:', 'file:', 'http:', 'https:',
  'data:', 'blob:', 'connector:', 'mcp:', 'agent:', 'local-file:', 'longtext:']);
const MAX_DIAGNOSTIC_BLOCKS = 64;
const MAX_FINGERPRINT_CHARACTERS = 8192;
const MAX_LONG_TEXT_BYTES = 1024 * 1024;

function field(value, key) {
  try { return value !== null && typeof value === 'object' ? value[key] : undefined; }
  catch { return undefined; }
}
function record(value) {
  try { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null; }
  catch { return null; }
}
function invalidScene() {
  throw Object.assign(new Error('原生场景标记无效，请从首页重新选择场景。'), { code: 'NATIVE_SCENE_INVALID' });
}

/** A scene chip is classification context, never a file or tool authorization. */
export function parseNativeSceneBlock(block) {
  if (!record(block) || field(block, 'type') !== 'resource_link') return null;
  const uri = field(block, 'uri'), meta = record(field(block, '_meta'));
  const declared = typeof uri === 'string' && /^scene:/i.test(uri)
    || field(meta, 'type') === 'scene' || field(meta, 'mentionType') === 'scene';
  if (!declared) return null;
  const id = field(meta, 'sceneId'), name = field(meta, 'displayText');
  if (typeof uri !== 'string' || typeof id !== 'string' || !SCENE_ID.test(id)
    || uri !== `scene://${id}` || field(meta, 'type') !== 'scene' || field(meta, 'mentionType') !== 'scene'
    || typeof name !== 'string' || !name.trim() || name.length > 256 || Buffer.byteLength(name, 'utf8') > 256
    || INVALID_LABEL.test(name)) invalidScene();
  return { id, name };
}

function validLongTextReference(uri) {
  if (typeof uri !== 'string' || uri.length > 8192 || !uri.startsWith('longtext://')) return false;
  const separator = uri.lastIndexOf('-');
  if (separator < 'longtext://'.length) return false;
  const preview = uri.slice('longtext://'.length, separator), count = uri.slice(separator + 1);
  if (!preview.endsWith('...') || !/^[1-9][0-9]{0,15}$/.test(count) || !Number.isSafeInteger(Number(count))) return false;
  return /^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})*$/.test(preview);
}

/** The URI is an opaque preview reference; only fullText supplies user text. */
export function parseNativeLongTextBlock(block) {
  if (!record(block) || field(block, 'type') !== 'resource_link') return null;
  const uri = field(block, 'uri'), meta = record(field(block, '_meta'));
  const declared = typeof uri === 'string' && /^longtext:/i.test(uri) || field(meta, 'mentionType') === 'long-text';
  if (!declared) return null;
  const text = field(meta, 'fullText');
  if (!validLongTextReference(uri) || field(meta, 'mentionType') !== 'long-text'
    || typeof text !== 'string' || text.length > MAX_LONG_TEXT_BYTES || INVALID_LONG_TEXT.test(text)
    || Buffer.byteLength(text, 'utf8') > MAX_LONG_TEXT_BYTES) {
    throw Object.assign(new Error('原生长文本内容无效或超出大小限制，请重新粘贴文本。'), { code: 'NATIVE_LONG_TEXT_INVALID' });
  }
  return { text };
}

function uriScheme(uri) {
  if (typeof uri !== 'string') return 'unknown';
  const prefix = uri.slice(0, 33), colon = prefix.indexOf(':');
  if (colon < 1 || colon > 31) return 'unknown';
  const scheme = prefix.slice(0, colon);
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) return 'unknown';
  const normalized = scheme.toLowerCase() + ':';
  return DIAGNOSTIC_SCHEMES.has(normalized) ? normalized : 'other:';
}
function kindOf(block, type, scheme) {
  if (type === 'text' || type === 'image') return { kind: type };
  if (type !== 'resource_link') return { kind: 'unknown' };
  try {
    const scene = parseNativeSceneBlock(block);
    if (scene) return { kind: 'scene', sceneId: scene.id };
  } catch { return { kind: 'invalid-scene' }; }
  try {
    if (parseNativeLongTextBlock(block)) return { kind: 'long-text' };
  } catch { return { kind: 'invalid-long-text' }; }
  const meta = record(field(block, '_meta')), nativeType = field(meta, 'type'), mentionType = field(meta, 'mentionType');
  if (scheme === 'skill:' || scheme === 'command:' && (nativeType === 'skill' || mentionType === 'skill')) return { kind: 'skill' };
  if (field(meta, 'selectionQuote') === true || ['selection', 'tencentDocsSelection'].includes(mentionType)) return { kind: 'selection' };
  if (['connector-link-pending-auth', 'connector-link-resolved'].includes(field(meta, 'kind'))) return { kind: 'connector-link' };
  if (scheme === 'command:') return { kind: 'command' };
  const uri = field(block, 'uri');
  if (scheme === 'file:' || typeof uri === 'string' && uri.startsWith('/')) return { kind: 'file' };
  if (scheme !== 'unknown') return { kind: 'remote' };
  const localPath = field(meta, 'filePath');
  if (typeof localPath === 'string' && localPath.startsWith('/')) return { kind: 'file' };
  return { kind: 'unknown' };
}

/** Value-free private diagnostics; these classifications do not authorize input. */
export function describeNativeInput(blocks) {
  let array = false;
  try { array = Array.isArray(blocks); } catch { /* Invalid callers get an empty bounded description. */ }
  if (!array) return { version: 1, blocks: [] };
  const length = field(blocks, 'length');
  if (!Number.isSafeInteger(length) || length < 0) return { version: 1, blocks: [] };
  const described = [];
  for (let index = 0; index < Math.min(length, MAX_DIAGNOSTIC_BLOCKS); index++) {
    const block = field(blocks, index), rawType = field(block, 'type');
    const type = BLOCK_TYPES.has(rawType) ? rawType : 'unknown';
    const uri = field(block, 'uri'), scheme = uriScheme(uri);
    const descriptor = { index, type, uriScheme: scheme, ...kindOf(block, type, scheme) };
    if (typeof uri === 'string' && uri.length > 0 && uri.length <= MAX_FINGERPRINT_CHARACTERS) {
      descriptor.uriFingerprint = createHash('sha256').update(uri).digest('hex').slice(0, 16);
    }
    described.push(descriptor);
  }
  return { version: 1, blocks: described, ...(length > MAX_DIAGNOSTIC_BLOCKS ? { truncated: true } : {}) };
}
