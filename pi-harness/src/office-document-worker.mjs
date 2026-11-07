import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';

const { bytes, extension, limits, engineRoot } = workerData;
const require = createRequire(join(engineRoot, 'package.json'));
const yauzl = require('yauzl');
const { SaxesParser } = require('saxes');
const crc32 = require(join(engineRoot, 'node_modules/yauzl/crc32.js'));
const bad = (suffix = 'INVALID', message = 'Office 文档损坏或格式不受支持，请重新导出后选择。') => {
  const error = new Error(message); error.code = `ATTACHMENT_DOCUMENT_${suffix}`; throw error;
};
const tooLarge = () => bad('TOO_LARGE', 'Office 文档解压后的内容超过限制，请拆分后选择。');
const child = (node, name) => node.children.find(c => typeof c === 'object' && c.name === name);
const children = (node, name) => node.children.filter(c => typeof c === 'object' && c.name === name);
const text = node => node ? node.children.map(c => typeof c === 'string' ? c : text(c)).join('') : '';
function descendants(node, name) {
  const result = [];
  const visit = n => { for (const c of n.children) if (typeof c === 'object') { if (c.name === name) result.push(c); else visit(c); } };
  visit(node); return result;
}
function xml(bytes) {
  let value;
  try {
    // OOXML permits UTF-16; decode explicitly and reject malformed byte sequences.
    const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    value = new TextDecoder(utf16, { fatal: true }).decode(bytes);
  } catch { bad(); }
  const root = { name: '#document', children: [] }, stack = [root]; let nodes = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => bad('UNSAFE', '文档 XML 含 DTD，无法安全解析；请重新另存为 Office 文档。'));
  parser.on('opentag', tag => {
    if (++nodes > limits.maxNodes || stack.length > 128) tooLarge();
    const attrs = {};
    for (const a of Object.values(tag.attributes)) attrs[a.name] = a.value;
    const node = { name: tag.local, uri: tag.uri, attrs, children: [] };
    stack.at(-1).children.push(node); stack.push(node);
  });
  const onText = value => { if (++nodes > limits.maxNodes) tooLarge(); stack.at(-1).children.push(value); };
  parser.on('text', onText); parser.on('cdata', onText);
  parser.on('closetag', () => stack.pop()); parser.on('error', () => bad());
  parser.write(value).close();
  return root.children.find(c => typeof c === 'object') ?? bad();
}
async function openArchive() {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(Buffer.from(bytes), {
    lazyEntries: true, strictFileNames: true, validateEntrySizes: true,
  }, (error, value) => error ? reject(error) : resolve(value)));
  if (zip.entryCount > limits.maxEntries) tooLarge();
  const entries = new Map();
  await new Promise((resolve, reject) => {
    zip.on('error', reject); zip.on('end', resolve);
    zip.on('entry', entry => {
      try {
        const name = entry.fileName;
        if (entries.size >= limits.maxEntries || name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || entries.has(name)) bad();
        if (entry.isEncrypted()) bad('LOCKED', 'Office 文档已加密，请解除保护后重新选择。');
        if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) bad('UNSAFE', '文档包含符号链接，无法解析。');
        entries.set(name, entry); zip.readEntry();
      } catch (error) { reject(error); }
    });
    zip.readEntry();
  });
  let expanded = 0;
  const cache = new Map();
  async function read(name, optional = false) {
    if (cache.has(name)) return cache.get(name);
    const entry = entries.get(name);
    if (!entry) { if (optional) return undefined; bad(); }
    if (entry.uncompressedSize > limits.maxEntryBytes || expanded + entry.uncompressedSize > limits.maxExpandedBytes) tooLarge();
    const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
    const chunks = []; let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > limits.maxEntryBytes || expanded + size > limits.maxExpandedBytes) { stream.destroy(); tooLarge(); }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (size !== entry.uncompressedSize || crc32(buffer) !== entry.crc32) bad();
    expanded += size;
    const value = xml(buffer); cache.set(name, value); return value;
  }
  return { entries, read };
}
function relationshipMap(node, part) {
  if (node.name !== 'Relationships') bad();
  const result = new Map();
  for (const rel of children(node, 'Relationship')) {
    const { Id, Target, TargetMode, Type } = rel.attrs;
    if (!Id || result.has(Id) || !Target) bad();
    if (TargetMode === 'External') { result.set(Id, { external: true, type: Type }); continue; }
    if (Target.includes('\\') || Target.includes('\0') || /[?#%]/.test(Target) || /^[a-z][a-z0-9+.-]*:/i.test(Target)) bad();
    const target = posix.normalize(Target.startsWith('/') ? Target.slice(1) : posix.join(posix.dirname(part), Target));
    if (target.startsWith('../') || target === '..' || target.startsWith('/')) bad();
    result.set(Id, { target, type: Type });
  }
  return result;
}
const relsName = part => posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels');
function linked(map, id, kind) {
  const rel = map.get(id);
  if (!rel || rel.external || !rel.type?.endsWith('/' + kind)) bad();
  return rel.target;
}
function paragraphs(node) {
  let output = '';
  function visit(n) {
    if (['del', 'instrText'].includes(n.name)) return;
    if (n.name === 't') { output += text(n); return; }
    if (n.name === 'tab') output += '\t';
    else if (['br', 'cr'].includes(n.name)) output += '\n';
    for (const c of n.children) if (typeof c === 'object') visit(c);
    if (['p', 'tr'].includes(n.name)) output += '\n';
    else if (n.name === 'tc') output += '\t';
  }
  visit(node); return output.trim();
}
async function parseOffice() {
  const archive = await openArchive(), { read, entries } = archive;
  const types = await read('[Content_Types].xml');
  if (types.name !== 'Types') bad();
  const rootRels = relationshipMap(await read('_rels/.rels'), '');
  const roots = [...rootRels.values()].filter(r => !r.external && r.type?.endsWith('/officeDocument'));
  if (roots.length !== 1) bad();
  const main = roots[0].target;
  const expected = { '.docx': ['document', 'wordprocessingml.document.main+xml'], '.xlsx': ['workbook', 'spreadsheetml.sheet.main+xml'], '.pptx': ['presentation', 'presentationml.presentation.main+xml'] }[extension];
  const contentType = children(types, 'Override').find(c => c.attrs.PartName === '/' + main)?.attrs.ContentType;
  if (!contentType?.endsWith(expected[1])) bad('MISMATCH', 'Office 扩展名与内部文档类型不一致，请使用正确格式重新导出。');
  const document = await read(main);
  if (document.name !== expected[0]) bad();
  const parts = [], warnings = ['仅提取文字与表格值；图表、内嵌对象和 Office 文档内图片不作识别，不执行宏或外部链接。'];
  let length = 0, meaningful = false;
  function append(heading, value) {
    if (value.trim()) meaningful = true;
    const part = `${heading}\n${value || '[无文字内容]'}`;
    length += Buffer.byteLength(part) + 2;
    if (length > limits.maxTextBytes) tooLarge(); parts.push(part);
  }
  const metadata = { format: extension.slice(1), warnings };
  if (extension === '.docx') {
    append('[文档正文]', paragraphs(document));
    for (const name of [...entries.keys()].filter(n => /^word\/(header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(n)).sort()) append(`[${posix.basename(name)}]`, paragraphs(await read(name)));
  } else if (extension === '.xlsx') {
    const rels = relationshipMap(await read(relsName(main)), main);
    const stringsPart = [...rels.values()].find(r => !r.external && r.type?.endsWith('/sharedStrings'));
    const shared = stringsPart ? children(await read(stringsPart.target), 'si').map(si => descendants(si, 't').map(text).join('')) : [];
    const sheets = children(child(document, 'sheets') ?? { children: [] }, 'sheet');
    if (sheets.length > 256) tooLarge(); metadata.sheets = sheets.length;
    let formulas = false;
    for (const sheet of sheets) {
      const sheetDoc = await read(linked(rels, sheet.attrs['r:id'] ?? Object.entries(sheet.attrs).find(([k]) => k.endsWith(':id'))?.[1], 'worksheet'));
      if (sheetDoc.name !== 'worksheet') bad();
      const rows = [];
      for (const row of children(child(sheetDoc, 'sheetData') ?? { children: [] }, 'row')) {
        const cells = [];
        for (const cell of children(row, 'c')) {
          const ref = cell.attrs.r;
          if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(ref ?? '')) bad();
          const type = cell.attrs.t, v = text(child(cell, 'v')), formula = child(cell, 'f'); let value = v;
          if (type === 's') { if (!/^\d+$/.test(v) || Number(v) >= shared.length) bad(); value = shared[Number(v)]; }
          else if (type === 'inlineStr') value = descendants(child(cell, 'is') ?? { children: [] }, 't').map(text).join('');
          else if (type === 'b') { if (!['0', '1'].includes(v)) bad(); value = v === '1' ? 'TRUE' : 'FALSE'; }
          if (formula) { formulas = true; value = v ? `${value} [公式缓存值]` : '[公式，无缓存值]'; }
          if (value) cells.push(`${ref}=${value.replace(/[\t\r\n]+/g, ' ')}`);
        }
        if (cells.length) rows.push(cells.join('\t'));
      }
      append(`[工作表：${sheet.attrs.name ?? ''}${sheet.attrs.state && sheet.attrs.state !== 'visible' ? '（隐藏）' : ''}]`, rows.join('\n'));
    }
    warnings.push('单元格保留地址和原始存储值；日期/金额显示格式不重建。');
    if (formulas) warnings.push('公式仅读取已保存的缓存结果，不重算；无缓存的单元格已标记。');
  } else {
    const rels = relationshipMap(await read(relsName(main)), main);
    const slides = children(child(document, 'sldIdLst') ?? { children: [] }, 'sldId');
    if (slides.length > limits.maxPages) tooLarge(); metadata.slides = slides.length;
    for (let i = 0; i < slides.length; i++) {
      const attrs = slides[i].attrs;
      const name = linked(rels, attrs['r:id'] ?? Object.entries(attrs).find(([k]) => k.endsWith(':id'))?.[1], 'slide');
      const slide = await read(name); if (slide.name !== 'sld') bad();
      append(`[第 ${i + 1} 张幻灯片]`, paragraphs(slide));
      const slideRels = await read(relsName(name), true);
      if (slideRels) {
        const note = [...relationshipMap(slideRels, name).values()].find(r => !r.external && r.type?.endsWith('/notesSlide'));
        if (note) append(`[第 ${i + 1} 张备注]`, paragraphs(await read(note.target)));
      }
    }
  }
  if (!meaningful) bad('EMPTY', 'Office 文档未提取到可用文字；图片型文档请导出为 PDF 后选择。');
  return { text: parts.join('\n\n'), ...metadata };
}
try { parentPort.postMessage(await parseOffice()); }
catch (error) {
  parentPort.postMessage({ error: { code: /^ATTACHMENT_DOCUMENT_/.test(error.code ?? '') ? error.code : 'ATTACHMENT_DOCUMENT_INVALID',
    message: /^ATTACHMENT_DOCUMENT_/.test(error.code ?? '') ? error.message : 'Office 文档损坏或格式不受支持，请重新导出后选择。' } });
}
