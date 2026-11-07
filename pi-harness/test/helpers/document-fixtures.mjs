import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';
const require = createRequire(new URL('../../document-engine/package.json', import.meta.url));
const crc32 = require('./node_modules/yauzl/crc32.js');

// Synthetic OOXML only: minimal stored/deflated ZIP writer, no third-party authoring runtime.
export function zip(entries, { compressed = false } = {}) {
  const locals = [], directory = []; let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const filename = Buffer.from(name), data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const packed = compressed ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30), central = Buffer.alloc(46), crc = crc32(data), method = compressed ? 8 : 0;
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, filename, packed); directory.push(central, filename); offset += local.length + filename.length + packed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
export const rels = body => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
export const rel = (id, type, target, mode = '') => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`;
export function officeEntries(type, main, xml) {
  const types = { docx: 'wordprocessingml.document', xlsx: 'spreadsheetml.sheet', pptx: 'presentationml.presentation' };
  return {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${types[type]}.main+xml"/></Types>`,
    '_rels/.rels': rels(rel('r1', 'officeDocument', main)), [main]: xml,
  };
}
export const docx = (text = '季度营收：123万元 &amp; 利润：45万元') => officeEntries('docx', 'word/document.xml',
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>DOCX-TABLE-OK</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`);
export function xlsx() {
  return { ...officeEntries('xlsx', 'xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="华东" r:id="s2"/><sheet name="华南" r:id="s1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': rels(rel('s1', 'worksheet', 'worksheets/sheet1.xml') + rel('s2', 'worksheet', 'worksheets/sheet2.xml') + rel('ss', 'sharedStrings', 'sharedStrings.xml')),
    'xl/sharedStrings.xml': '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>营收</t></r><r><t>数据</t></r></si></sst>',
    'xl/worksheets/sheet2.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>123</v></c><c r="D1"><f>C1*2</f><v>246</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>XLSX-OK</t></is></c><c r="B2"><f>NOW()</f></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="b"><v>1</v></c></row></sheetData></worksheet>',
  };
}
export function pptx() {
  const slide = text => `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`;
  return { ...officeEntries('pptx', 'ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="s2"/><p:sldId r:id="s1"/></p:sldIdLst></p:presentation>'),
    'ppt/_rels/presentation.xml.rels': rels(rel('s1', 'slide', 'slides/slide1.xml') + rel('s2', 'slide', 'slides/slide2.xml')),
    'ppt/slides/slide2.xml': slide('PPTX-FIRST 金融报告'), 'ppt/slides/slide1.xml': slide('PPTX-SECOND'),
    'ppt/slides/_rels/slide2.xml.rels': rels(rel('note', 'notesSlide', '../notesSlides/notesSlide1.xml') + rel('web', 'hyperlink', 'https://must-never-be-fetched.invalid/', 'External')),
    'ppt/notesSlides/notesSlide1.xml': '<notes><p><t>PPTX-NOTE</t></p></notes>',
  };
}
