import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { docx, zip } from './helpers/document-fixtures.mjs';
import { createFileOfficePiLauncher, handlePiHttpFiles } from '../src/pi-http-files.mjs';
import {
  DOCX_MIME, docxDirectory, fileDigest, publishDocxFile, replaceDocxText, validateDocx,
} from '../remote-office/docx.mjs';

async function workspace(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'pi-http-docx-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function invoke(workspace, action, method, bytes, extra = {}) {
  const req = Readable.from(bytes ? [bytes] : []);
  Object.assign(req, { method, headers: bytes ? {
    'content-length': String(bytes.length), 'content-type': DOCX_MIME, 'x-content-sha256': fileDigest(bytes),
  } : {} });
  const response = new EventEmitter();
  response.writeHead = (status, headers) => Object.assign(response, { status, headers });
  response.end = data => { response.data = data; };
  assert.equal(await handlePiHttpFiles(req, response, { action, workspace, ...extra }), true);
  return response;
}

test('Office HTTP uploads a valid DOCX, preserves the source and returns the processed artifact with its digest', async t => {
  const directory = await workspace(t);
  const input = zip(docx('original &amp; test'));
  const upload = await invoke(directory, '/files/input.docx', 'PUT', input);
  assert.equal(upload.status, 201);
  assert.equal(JSON.parse(upload.data).file.sha256, fileDigest(input));
  assert.equal((await invoke(directory, '/files/input.docx', 'PUT', input)).status, 200);
  await assert.rejects(invoke(directory, '/files/input.docx', 'PUT', zip(docx('other content'))), { code: 'OFFICE_FILE_EXISTS' });
  const changed = await replaceDocxText(input, 'original & test', 'replaced <text>');
  await publishDocxFile(await docxDirectory(directory, 'output'), 'result.docx', changed);
  await assert.rejects(invoke(directory, '/files/result.docx', 'PUT', input), { code: 'OFFICE_FILE_EXISTS' });
  const listing = await invoke(directory, '/files', 'GET');
  assert.deepEqual(JSON.parse(listing.data).files.map(({ name, kind }) => [name, kind]), [
    ['input.docx', 'input'], ['result.docx', 'output'],
  ]);
  const download = await invoke(directory, '/files/result.docx', 'GET');
  assert.equal(download.headers['X-Content-SHA256'], fileDigest(changed));
  assert.deepEqual(download.data, changed);
  const result = await validateDocx(changed);
  const source = await validateDocx(input);
  assert.match(result.get('word/document.xml').toString(), /replaced &lt;text&gt;/);
  assert.match(result.get('word/document.xml').toString(), /DOCX-TABLE-OK/);
  assert.deepEqual(result.get('_rels/.rels'), source.get('_rels/.rels'));
  assert.deepEqual(await readFile(join(await docxDirectory(directory, 'input'), 'input.docx')), input);
});

test('Office upload and download reject unsupported documents, traversal, symlinks and busy threads', async t => {
  const directory = await workspace(t);
  await assert.rejects(invoke(directory, '/files/%2e%2e%2fsecret.docx', 'GET'), { code: 'OFFICE_FILE_NAME_INVALID' });
  await assert.rejects(invoke(directory, '/files/file.docx', 'PUT', Buffer.from('not a docx')), { code: 'OFFICE_DOCX_INVALID' });
  const linked = docx('example');
  linked['word/_rels/document.xml.rels'] =
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="test" Type="test" TargetMode="External" Target="https://example.test/file"/></Relationships>';
  await assert.rejects(invoke(directory, '/files/link.docx', 'PUT', zip(linked)), { code: 'OFFICE_DOCX_EXTERNAL_LINK' });
  await assert.rejects(invoke(directory, '/files', 'GET', undefined, { threadBusy: () => true }), { code: 'OFFICE_THREAD_BUSY' });
  const input = await docxDirectory(directory, 'input');
  await symlink('/etc/passwd', join(input, 'symlink.docx'));
  await assert.rejects(invoke(directory, '/files/symlink.docx', 'GET'), { code: 'OFFICE_FILE_INVALID' });
  await assert.rejects(replaceDocxText(zip(docx('repeat repeat')), 'repeat', 'new'), { code: 'OFFICE_TEXT_AMBIGUOUS' });
  await assert.rejects(replaceDocxText(zip(docx('aaa')), 'aa', 'new'), { code: 'OFFICE_TEXT_AMBIGUOUS' });
});

test('Office launcher enables only the reviewed file tools and wrapper', () => {
  const officeExtension = new URL('../remote-office/extension.ts', import.meta.url).pathname;
  const launch = createFileOfficePiLauncher({ officeExtension, launchPi: (...args) => args });
  const result = launch('/usr/bin/flock', ['/usr/local/bin/pi', '--no-extensions', '--no-tools'], { cwd: '/scope' });
  assert.deepEqual(result[1], [
    '/usr/local/bin/pi', '--no-extensions', '--no-builtin-tools', '--tools', 'read_docx,office_replace_text',
    '--extension', officeExtension,
  ]);
  assert.throws(() => launch('pi', ['--no-tools', '--extension', '/arbitrary-extension']), /Unexpected/);
});
