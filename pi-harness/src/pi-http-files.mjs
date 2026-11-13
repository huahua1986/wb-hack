import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  DOCX_MIME, MAX_DOCX_BYTES, MAX_FILES_PER_KIND, docxDirectory, docxError, fileDigest,
  isDocxName, publishDocxFile, readDocxFile, validateDocx,
} from '../remote-office/docx.mjs';

const tools = 'read_docx,office_replace_text';

export function createFileOfficePiLauncher({ officeExtension, launchPi = spawn }) {
  if (typeof officeExtension !== 'string' || !isAbsolute(officeExtension)) throw Error('Office extension path required');
  const info = lstatSync(officeExtension);
  if (!info.isFile() || (info.mode & 0o022)) throw Error('Unsafe Office extension file');
  return (command, args, options) => {
    const disabled = args.indexOf('--no-tools');
    if (disabled === -1 || args.includes('--extension')) throw Error('Unexpected Pi Office arguments');
    const officeArgs = [...args];
    officeArgs.splice(disabled, 1, '--no-builtin-tools', '--tools', tools, '--extension', officeExtension);
    return launchPi(command, officeArgs, options);
  };
}

function json(res, status, value) {
  const data = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

async function collectUpload(req) {
  const declared = req.headers['content-length'];
  if (typeof declared !== 'string' || !/^[1-9][0-9]{0,8}$/.test(declared)) {
    throw docxError('OFFICE_FILE_LENGTH_REQUIRED', 411);
  }
  const length = Number(declared);
  if (length > MAX_DOCX_BYTES) throw docxError('OFFICE_DOCX_TOO_LARGE', 413);
  if (![DOCX_MIME, 'application/octet-stream'].includes(req.headers['content-type'])) {
    throw docxError('OFFICE_DOCX_CONTENT_TYPE', 415);
  }
  const suppliedDigest = req.headers['x-content-sha256'];
  if (suppliedDigest !== undefined && !/^[a-f0-9]{64}$/.test(suppliedDigest)) {
    throw docxError('OFFICE_FILE_DIGEST_INVALID', 400);
  }
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > length) throw docxError('OFFICE_DOCX_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  if (total !== length) throw docxError('OFFICE_FILE_LENGTH_MISMATCH', 400);
  const bytes = Buffer.concat(chunks);
  const sha256 = fileDigest(bytes);
  if (suppliedDigest !== undefined && suppliedDigest !== sha256) {
    throw docxError('OFFICE_FILE_DIGEST_MISMATCH', 400);
  }
  await validateDocx(bytes);
  return { bytes, sha256 };
}

function decodeFilename(action) {
  let name;
  try { name = decodeURIComponent(action.slice('/files/'.length)); } catch {
    throw docxError('OFFICE_FILE_NAME_INVALID', 400);
  }
  if (!isDocxName(name)) throw docxError('OFFICE_FILE_NAME_INVALID', 400);
  return name;
}

/** Server calls this only for an authorized, exclusively held Office thread. */
export async function handlePiHttpFiles(req, res, { action, workspace, threadBusy = () => false }) {
  if (action !== '/files' && !action.startsWith('/files/')) return false;
  if (threadBusy()) throw docxError('OFFICE_THREAD_BUSY', 409);
  if (action === '/files' && req.method === 'GET') {
    const files = [];
    for (const kind of ['input', 'output']) {
      const directory = await docxDirectory(workspace, kind);
      const names = (await readdir(directory)).filter(isDocxName).sort();
      if (names.length > MAX_FILES_PER_KIND) throw docxError('OFFICE_FILE_COUNT_LIMIT', 413);
      for (const name of names) {
        const bytes = await readDocxFile(directory, name);
        files.push({ name, kind, size: bytes.length, sha256: fileDigest(bytes) });
      }
    }
    json(res, 200, { files });
    return true;
  }
  if (action === '/files') throw docxError('OFFICE_FILE_METHOD_INVALID', 405);
  const name = decodeFilename(action);
  if (req.method === 'PUT') {
    const directory = await docxDirectory(workspace, 'input');
    const output = await docxDirectory(workspace, 'output');
    if ((await readdir(output)).some(item => item.toLowerCase() === name.toLowerCase())) {
      throw docxError('OFFICE_FILE_EXISTS', 409);
    }
    const { bytes, sha256 } = await collectUpload(req);
    const names = (await readdir(directory)).filter(isDocxName);
    const previous = names.find(item => item.toLowerCase() === name.toLowerCase());
    if (previous !== undefined) {
      const existing = await readDocxFile(directory, previous);
      if (previous !== name || fileDigest(existing) !== sha256) throw docxError('OFFICE_FILE_EXISTS', 409);
      json(res, 200, { file: { name, size: bytes.length, sha256, kind: 'input' } });
      return true;
    }
    if (names.length >= MAX_FILES_PER_KIND) throw docxError('OFFICE_FILE_COUNT_LIMIT', 413);
    await publishDocxFile(directory, name, bytes);
    json(res, 201, { file: { name, size: bytes.length, sha256, kind: 'input' } });
    return true;
  }
  if (req.method === 'GET') {
    const output = await docxDirectory(workspace, 'output');
    let bytes;
    try { bytes = await readDocxFile(output, name); } catch (error) {
      if (error.code !== 'OFFICE_FILE_NOT_FOUND') throw error;
      bytes = await readDocxFile(await docxDirectory(workspace, 'input'), name);
    }
    await validateDocx(bytes);
    res.writeHead(200, {
      'Content-Type': DOCX_MIME, 'Content-Length': bytes.length,
      'Content-Disposition': `attachment; filename="${name}"`,
      'X-Content-SHA256': fileDigest(bytes), 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(bytes);
    return true;
  }
  throw docxError('OFFICE_FILE_METHOD_INVALID', 405);
}
