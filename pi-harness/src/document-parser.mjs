import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';

export const DOCUMENT_LIMITS = Object.freeze({
  maxFileBytes: 25 * 1024 * 1024, maxTextBytes: 512 * 1024,
  maxPages: 200, maxEntries: 10000, maxEntryBytes: 8 * 1024 * 1024,
  maxExpandedBytes: 32 * 1024 * 1024, maxNodes: 250000,
});
export const DOCUMENT_TYPES = Object.freeze({
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
});

export class DocumentParseError extends Error {
  constructor(code, message) { super(message); this.name = 'DocumentParseError'; this.code = code; }
}
const cancelled = () => new DocumentParseError('TURN_INPUT_CANCELLED', '文档解析已取消，本轮未发送。');
const failed = () => new DocumentParseError('ATTACHMENT_DOCUMENT_INVALID', '文档损坏或内容格式不受支持，请重新导出后选择。');
export function documentEngineRoot() {
  const bundled = fileURLToPath(new URL('../../DocumentEngine/', import.meta.url));
  return existsSync(join(bundled, 'package-lock.json')) ? bundled : fileURLToPath(new URL('../document-engine/', import.meta.url));
}

/** Immutable selected bytes only. No file reopening, URL fetching or document execution. */
export async function parseDocument(bytes, extension, { signal, maxTextBytes = DOCUMENT_LIMITS.maxTextBytes,
  engineRoot = documentEngineRoot(), timeoutMs = extension === '.pdf' ? 120000 : 15000 } = {}) {
  if (signal?.aborted) throw cancelled();
  if (!DOCUMENT_TYPES[extension]) throw new DocumentParseError('ATTACHMENT_DOCUMENT_UNSUPPORTED', '请将文档另存为 PDF、DOCX、XLSX 或 PPTX 后选择。');
  if (bytes.length > DOCUMENT_LIMITS.maxFileBytes) throw new DocumentParseError('ATTACHMENT_TOO_LARGE', '单个文档不能超过 25 MiB。');
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1 || maxTextBytes > DOCUMENT_LIMITS.maxTextBytes) throw new TypeError('Invalid document text limit');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid document timeout');
  if (extension !== '.pdf' && bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) {
    throw new DocumentParseError('ATTACHMENT_DOCUMENT_LOCKED', '文件可能已加密或采用旧版 Office 格式，请解除保护并另存为 DOCX、XLSX 或 PPTX。');
  }
  if ((extension === '.pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') ||
    (extension !== '.pdf' && (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50))) throw failed();
  const limits = { ...DOCUMENT_LIMITS, maxTextBytes };
  return new Promise((resolve, reject) => {
    let child, timer, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (child instanceof Worker) void child.terminate(); else if (child && child.exitCode === null) child.kill('SIGKILL');
      if (error) reject(error); else if (!value || typeof value.text !== 'string' || !value.text.trim()) reject(new DocumentParseError('ATTACHMENT_DOCUMENT_EMPTY', '文档未识别到可用文字，请检查扫描清晰度或导出文本。'));
      else if (Buffer.byteLength(value.text) > maxTextBytes) reject(new DocumentParseError('ATTACHMENT_DOCUMENT_TOO_LARGE', '文档解析后的文字超过限制，请拆分文档后选择。'));
      else resolve(value);
    };
    const abort = () => finish(cancelled());
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    timer = setTimeout(() => finish(new DocumentParseError('ATTACHMENT_DOCUMENT_TIMEOUT', '文档解析超时，请拆分文档或降低扫描分辨率后重试。')), timeoutMs);
    const result = value => {
      if (value?.error) finish(new DocumentParseError(
        /^ATTACHMENT_DOCUMENT_[A-Z_]+$/.test(value.error.code) ? value.error.code : 'ATTACHMENT_DOCUMENT_INVALID',
        typeof value.error.message === 'string' ? value.error.message.slice(0, 240) : failed().message));
      else finish(undefined, value);
    };
    try {
      if (extension !== '.pdf') {
        child = new Worker(new URL('./office-document-worker.mjs', import.meta.url), {
          workerData: { bytes, extension, limits, engineRoot },
          resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
        });
        child.on('message', result); child.on('error', () => finish(failed()));
        child.on('exit', () => { if (!settled) finish(failed()); });
      } else {
        const helper = join(engineRoot, 'pdf-parser');
        if (process.platform !== 'darwin' || !existsSync(helper)) return finish(new DocumentParseError('ATTACHMENT_DOCUMENT_ENGINE_MISSING', 'PDF 解析组件未安装，请安装包含文档解析器的新版金融buddy。'));
        child = spawn(helper, [String(maxTextBytes), String(limits.maxPages)], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
        const chunks = []; let length = 0;
        child.stdout.on('data', chunk => {
          length += chunk.length;
          if (length > maxTextBytes * 6 + 8192) return finish(new DocumentParseError('ATTACHMENT_DOCUMENT_TOO_LARGE', '文档解析后的文字超过限制，请拆分文档后选择。'));
          chunks.push(chunk);
        });
        child.on('error', () => finish(failed())); child.stdin.on('error', () => {});
        child.on('close', code => {
          if (settled) return;
          if (code !== 0) return finish(failed());
          try { result(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(failed()); }
        });
        child.stdin.end(bytes);
      }
    } catch { finish(failed()); }
  });
}
