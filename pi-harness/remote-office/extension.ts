import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createReadDocxTool } from '@mammothb/pi-office/src/tools/read-docx.ts';
import {
  MAX_FILES_PER_KIND, docxDirectory, docxError, isDocxName, publishDocxFile, readDocxFile, replaceDocxText, validateDocx,
} from './docx.mjs';

const filename = Type.String({ minLength: 6, maxLength: 97, description: 'DOCX filename without directories' });

export default function office(pi: ExtensionAPI) {
  const plugin = createReadDocxTool();
  let writes: Promise<unknown> = Promise.resolve();
  pi.registerTool({
    name: 'read_docx',
    label: 'Read uploaded DOCX',
    description: 'Use the Pi Office plugin to read one uploaded Word file or generated DOCX by filename. Returns a bounded text preview.',
    parameters: Type.Object({ path: filename }, { additionalProperties: false }),
    async execute(callId, params, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      let directory = await docxDirectory(ctx.cwd, 'input');
      let bytes;
      try { bytes = await readDocxFile(directory, params.path); }
      catch (error) {
        if (error?.code !== 'OFFICE_FILE_NOT_FOUND') throw error;
        directory = await docxDirectory(ctx.cwd, 'output');
        bytes = await readDocxFile(directory, params.path);
      }
      await validateDocx(bytes);
      signal?.throwIfAborted();
      const result = await plugin.execute(callId, { path: join(directory, params.path), maxChars: 16_000 }, signal, onUpdate, ctx);
      const outputPath = result.details?.outputPath;
      if (typeof outputPath === 'string') {
        const directory = dirname(outputPath);
        if (dirname(directory) === tmpdir() && basename(directory).startsWith('pi-office-')) {
          await rm(directory, { recursive: true, force: true });
        }
      }
      signal?.throwIfAborted();
      const text = result.content.filter(item => item.type === 'text').map(item =>
        item.text.split('\nFull content written to ')[0]).join('\n');
      return { content: [{ type: 'text' as const, text }], details: { name: params.path, plugin: '@mammothb/pi-office@0.2.1' } };
    },
  });
  pi.registerTool({
    name: 'office_replace_text',
    label: 'Replace text in DOCX copy',
    description: 'Replace one exact substring within a single Word text run and save a new downloadable DOCX. Never overwrites an upload or existing output.',
    parameters: Type.Object({
      source: filename, output: filename,
      find: Type.String({ minLength: 1, maxLength: 2000 }),
      replacement: Type.String({ maxLength: 2000 }),
    }, { additionalProperties: false }),
    execute(_id, params, signal, _onUpdate, ctx) {
      const operation = writes.then(async () => {
        signal?.throwIfAborted();
        if (!isDocxName(params.output) || params.output.toLowerCase() === params.source.toLowerCase()) {
          throw docxError('OFFICE_OUTPUT_NAME_INVALID', 400);
        }
        const input = await docxDirectory(ctx.cwd, 'input');
        const output = await docxDirectory(ctx.cwd, 'output');
        if ((await readdir(input)).some(name => name.toLowerCase() === params.output.toLowerCase())) {
          throw docxError('OFFICE_OUTPUT_NAME_INVALID', 400);
        }
        const names = (await readdir(output)).filter(isDocxName);
        if (names.some(name => name.toLowerCase() === params.output.toLowerCase())) throw docxError('OFFICE_FILE_EXISTS', 409);
        if (names.length >= MAX_FILES_PER_KIND) throw docxError('OFFICE_FILE_COUNT_LIMIT', 413);
        const bytes = await replaceDocxText(await readDocxFile(input, params.source), params.find, params.replacement);
        signal?.throwIfAborted();
        await publishDocxFile(output, params.output, bytes);
        return {
          content: [{ type: 'text' as const, text: `Created downloadable DOCX: ${params.output}` }],
          details: { name: params.output, kind: 'output', format: 'docx' },
        };
      });
      writes = operation.catch(() => {});
      return operation;
    },
  });
}
