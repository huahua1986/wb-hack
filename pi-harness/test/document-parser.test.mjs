import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { parseDocument, documentEngineRoot, DocumentParseError } = await import(process.env.PI_TEST_DOCUMENT_PARSER_MODULE || '../src/document-parser.mjs');
const { prepareTurnInput, TurnInputError } = await import(process.env.PI_TEST_TURN_INPUT_MODULE || '../src/turn-input.mjs');
import { zip, docx, xlsx, pptx, rels, rel } from './helpers/document-fixtures.mjs';

const rejects = (promise, code) => assert.rejects(promise, e => e instanceof DocumentParseError && e.code === `ATTACHMENT_DOCUMENT_${code}`);
test('DOCX paragraphs, Chinese, entities and table text enter the prompt without persisting document content in metadata', async t => {
  const root = realpathSync(mkdtempSync('/private/tmp/pi-doc-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, '季度.docx'); writeFileSync(path, zip(docx(), { compressed: true }));
  const result = await prepareTurnInput({ prompt: '总结附件', promptContentBlocks: [{ type: 'resource_link', uri: pathToFileURL(path).href, mimeType: 'application/octet-stream' }] });
  assert.match(result.message, /季度营收：123万元 & 利润：45万元/); assert.match(result.message, /DOCX-TABLE-OK/);
  assert.equal(result.attachments[0].kind, 'document'); assert.equal(result.attachments[0].format, 'docx');
  assert.equal(result.summary, '总结附件\n[附件：季度.docx]');
  assert.doesNotMatch(JSON.stringify(result.attachments), /123万元|DOCX-TABLE/);
});
test('XLSX uses workbook ordering, rich shared strings, sparse addresses and explicit formula cache state', async () => {
  const value = await parseDocument(zip(xlsx()), '.xlsx');
  assert.equal(value.sheets, 2); assert.match(value.text, /A1=营收数据\tC1=123\tD1=246 \[公式缓存值\]/);
  assert.ok(value.text.indexOf('华东') < value.text.indexOf('华南')); assert.match(value.text, /A2=XLSX-OK\tB2=\[公式，无缓存值\]/);
  assert.match(value.text, /A1=TRUE/); assert.ok(value.warnings.some(w => w.includes('不重算')));
});
test('PPTX follows relationship order and includes speaker notes, ignores external hyperlink targets', async () => {
  const value = await parseDocument(zip(pptx(), { compressed: true }), '.pptx');
  assert.equal(value.slides, 2); assert.ok(value.text.indexOf('PPTX-FIRST') < value.text.indexOf('PPTX-SECOND'));
  assert.match(value.text, /PPTX-NOTE/); assert.doesNotMatch(value.text, /must-never/);
});
test('rejects encrypted/broken binaries, legacy files and mislabeled Office containers', async () => {
  await rejects(parseDocument(Buffer.from('PK'), '.docx'), 'INVALID');
  await rejects(parseDocument(Buffer.from('not PDF'), '.pdf'), 'INVALID');
  await rejects(parseDocument(zip(docx()), '.xlsx'), 'MISMATCH');
  await rejects(parseDocument(Buffer.from('old'), '.doc'), 'UNSUPPORTED');
  await rejects(parseDocument(Buffer.from('d0cf11e0a1b11ae1', 'hex'), '.docx'), 'LOCKED');
  const encrypted = zip(docx(), { compressed: true }); encrypted.writeUInt16LE(0x801, encrypted.indexOf(Buffer.from('504b0102', 'hex')) + 8);
  await rejects(parseDocument(encrypted, '.docx'), 'LOCKED');
});
test('rejects unsafe ZIP names, corrupt CRC, external main relationships and XML DTD/entity input', async () => {
  await rejects(parseDocument(zip({ ...docx(), '../escape': 'no' }), '.docx'), 'INVALID');
  const corrupted = zip(docx()); corrupted[corrupted.indexOf(Buffer.from('季度'))] ^= 1;
  await rejects(parseDocument(corrupted, '.docx'), 'INVALID');
  const external = docx(); external['_rels/.rels'] = rels(rel('r', 'officeDocument', 'https://invalid.local/document.xml', 'External'));
  await rejects(parseDocument(zip(external), '.docx'), 'INVALID');
  const entity = docx(); entity['word/document.xml'] = '<!DOCTYPE document [<!ENTITY secret SYSTEM "file:///etc/passwd">]><document>&secret;</document>';
  await rejects(parseDocument(zip(entity), '.docx'), 'UNSAFE');
});
test('limits expanded XML, extracted output and cancels owned parsing worker', async () => {
  await rejects(parseDocument(zip(docx('x'.repeat(8 * 1024 * 1024)), { compressed: true }), '.docx'), 'TOO_LARGE');
  await rejects(parseDocument(zip(docx()), '.docx', { maxTextBytes: 16 }), 'TOO_LARGE');
  const controller = new AbortController();
  const promise = parseDocument(zip(docx('x'.repeat(500000))), '.docx', { signal: controller.signal }); controller.abort();
  await assert.rejects(promise, e => e.code === 'TURN_INPUT_CANCELLED');
  await rejects(parseDocument(zip(docx()), '.docx', { timeoutMs: 1 }), 'TIMEOUT');
});
test('attachment errors retain localized typed errors and never fall back to an empty prompt', async t => {
  const root = realpathSync(mkdtempSync('/private/tmp/pi-doc-fail-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'bad.docx'); writeFileSync(path, 'PK');
  await assert.rejects(prepareTurnInput({ prompt: 'hello', promptContentBlocks: [{ type: 'resource_link', uri: pathToFileURL(path).href }] }), e => e instanceof TurnInputError && e.code === 'ATTACHMENT_DOCUMENT_INVALID');
});
const native = process.platform === 'darwin' && existsSync(join(documentEngineRoot(), 'pdf-parser'));
test('native PDF extracts text and OCRs image-only pages locally, handles encrypted and blank documents', { skip: !native }, async () => {
  const fixture = name => readFileSync(new URL(`./fixtures/documents/${name}.pdf`, import.meta.url));
  const text = await parseDocument(fixture('text'), '.pdf'); assert.match(text.text, /PDF-TEXT-OK/); assert.equal(text.pages, 2);
  const scan = await parseDocument(fixture('scan'), '.pdf'); assert.match(scan.text, /SCAN-REPORT-2026/); assert.equal(scan.ocrPages, 1);
  await rejects(parseDocument(fixture('encrypted'), '.pdf'), 'LOCKED');
  await rejects(parseDocument(fixture('blank'), '.pdf'), 'EMPTY');
  await rejects(parseDocument(fixture('text'), '.pdf', { maxTextBytes: 10 }), 'TOO_LARGE');
});
