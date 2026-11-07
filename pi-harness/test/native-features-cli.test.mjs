import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

import { PiRpcClient } from '../src/pi-rpc.mjs';
const { prepareTurnInput } = await import(process.env.PI_TEST_TURN_INPUT_MODULE || '../src/turn-input.mjs');
const { resolveNativeContext } = await import(process.env.PI_TEST_NATIVE_CONTEXT_MODULE || '../src/native-context.mjs');
import { zip, docx, xlsx, pptx } from './helpers/document-fixtures.mjs';
import { writeExpertFixture } from './helpers/expert-fixtures.mjs';
import { NATIVE_CALL, NATIVE_READY, NATIVE_TITLE } from '../src/native-feature-extension.mjs';
import { APPROVAL_PROTOCOL, APPROVAL_READY, APPROVAL_TITLE } from '../package-dmg/approval-extension.mjs';
import { createNativeInputReplay } from './fixtures/native-input-592.replay.mjs';

// A complete synthetic 1x1 PNG, with correct chunk CRCs. No user image is read.
function fixturePng() {
  function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  }
  function chunk(name, data) {
    const type = Buffer.from(name);
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

function textContent(value) {
  return typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part.text ?? '').join('') : '';
}

// Explicit opt-in: runs real Pi RPC with a private HOME/agent directory and a
// fake loopback provider. All model output, approvals and MCP results are fixtures.
test('actual Pi loads native scene and complete long paste with Expert/skill, image and documents without expanding its synthetic MCP grant', {
  skip: !process.env.PI_TEST_COMMAND,
  timeout: 30_000,
}, async t => {
  const officialExtension = process.env.PI_TEST_EXTENSION
    ?? fileURLToPath(new URL('../src/official-provider-extension.ts', import.meta.url));
  const nativeExtension = process.env.PI_TEST_NATIVE_EXTENSION ?? fileURLToPath(new URL('../src/native-feature-extension.mjs', import.meta.url));
  const approvalExtension = process.env.PI_TEST_APPROVAL_EXTENSION ?? fileURLToPath(new URL('../package-dmg/approval-extension.mjs', import.meta.url));
  for (const path of [officialExtension, nativeExtension, approvalExtension]) {
    assert.ok(isAbsolute(path));
    const stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
  }
  const extraArgs = JSON.parse(process.env.PI_TEST_ARGS ?? '[]');
  assert.ok(Array.isArray(extraArgs) && extraArgs.every(value => typeof value === 'string'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-pi-native-cli-')));
  const agentDir = join(root, 'agent');
  const bridgeDir = join(root, 'bridge');
  const temporaryDir = join(root, 'tmp');
  for (const path of [agentDir, bridgeDir, temporaryDir]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: {} }), { mode: 0o600 });
  const ticket = 'fake-loopback-native-fixture-no-official-credentials';
  const ids = { threadId: `pi-thread-${randomUUID()}`, turnId: `pi-turn-${randomUUID()}` };
  const requestContextFile = join(root, 'request-context.json');
  writeFileSync(requestContextFile, JSON.stringify(ids), { mode: 0o600 });
  const toolName = `wb_mcp_${createHash('sha256').update('native-cli-fixture-tool').digest('hex').slice(0, 24)}`;
  const toolCallId = 'fixture_native_mcp_call_1';
  const toolArguments = { query: 'NATIVE_FIXTURE_QUERY' };
  const resultMarker = 'NATIVE_LOCAL_MCP_FIXTURE_中文_OK';
  const finalMarker = 'NATIVE_CLI_FIXTURE_COMPLETE';
  const expertMarker = 'NATIVE_SELECTED_EXPERT_FINANCIAL_FIXTURE';
  const skillMarker = 'NATIVE_SELECTED_SKILL_RECONCILIATION_FIXTURE';
  const expertSkillBody = 'NATIVE_PACKAGE_SKILL_BODY_MUST_NOT_BE_EAGERLY_INLINED';
  const expertPackage = writeExpertFixture(join(root, 'synthetic-expert-config'), { body: expertMarker, skillBody: expertSkillBody });
  const selectedSkillPath = join(root, 'selected-skill/SKILL.md');
  mkdirSync(join(root, 'selected-skill'), { mode: 0o700 });
  writeFileSync(selectedSkillPath, skillMarker, { mode: 0o600 });
  const resolvedContext = await resolveNativeContext({ expert: expertPackage.selection,
    skills: [{ id: 'synthetic-selected-skill', name: 'Synthetic selected skill', filePath: selectedSkillPath }] },
  { expertConfigDir: expertPackage.configDir });
  assert.equal(resolvedContext.expert.prompt, expertMarker);
  assert.equal(resolvedContext.expert.package.skills[0].catalogOnly, true);
  const nativeContextFile = join(root, 'native-context.json');
  const nativeContext = instructions => ({ version: 1, ...ids, instructions, tools: [{
    name: toolName, label: 'Fixture selected MCP', description: 'Read a local synthetic MCP result after explicit fixture approval.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  }] });
  writeFileSync(nativeContextFile, JSON.stringify(nativeContext('STALE_STARTUP_CONTEXT_MUST_NOT_REACH_MODEL')), { mode: 0o600 });
  const imagePath = join(root, 'selected-fixture.png');
  const png = fixturePng();
  writeFileSync(imagePath, png, { mode: 0o600 });
  const documents = [['report.docx', zip(docx())], ['report.xlsx', zip(xlsx())], ['report.pptx', zip(pptx())]];
  if (process.platform === 'darwin') {
    for (const name of ['text', 'scan']) documents.push([`${name}.pdf`, readFileSync(new URL(`./fixtures/documents/${name}.pdf`, import.meta.url))]);
  }
  const documentBlocks = documents.map(([name, bytes]) => {
    const path = join(root, name); writeFileSync(path, bytes, { mode: 0o600 });
    return { type: 'resource_link', uri: pathToFileURL(path).href, mimeType: 'application/octet-stream' };
  });
  const nativeInput = createNativeInputReplay();
  const longBody = 'NATIVE_LONG_FIRST|' + '文'.repeat(3001) + '|NATIVE_LONG_LAST';
  const longPaste = nativeInput.paste({ text: longBody });
  const prefix = 'Use the selected synthetic native fixture MCP once, then finish. Do not contact any real business system. PASTE_BEFORE|';
  const suffix = '|PASTE_AFTER';
  const prepared = await prepareTurnInput({ cwd: root,
    promptContentBlocks: nativeInput.homeBlocks([{ type: 'text', text: prefix }, ...longPaste.blocks, { type: 'text', text: suffix },
      { type: 'image', uri: pathToFileURL(imagePath).href, mimeType: 'image/png',
        _meta: { blockStatus: 'completed', filename: 'selected-fixture.png', filePath: imagePath, size: png.length } }, ...documentBlocks]) });
  assert.equal(prepared.images.length, 1);
  assert.deepEqual(prepared.scenes, [{ id: '122844', name: '企业微信' }]);
  assert.equal(prepared.attachments.length, documentBlocks.length + 1, 'A native scene or long paste is not a file attachment');
  assert.ok(prepared.message.startsWith(prefix + longBody + suffix));
  const records = [];
  const requests = [];
  const chronology = [];
  const pendingResponses = new Set();
  let failure;
  let client;
  let closing = false;
  let approvalCount = 0;
  let inputCount = 0;
  let approvedToolCall;
  let approvalConsumed = false;
  const models = [{ id: 'hy4-native-fixture', name: 'Private native fixture', api: 'openai-completions',
    contextWindow: 32768, maxTokens: 512, reasoning: false, input: ['text', 'image'], supportsToolCall: true }];
  const server = createServer((req, res) => {
    void (async () => {
      assert.equal(req.headers.authorization, `Bearer ${ticket}`);
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: models }));
        return;
      }
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.method, 'POST');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, 'hy4-native-fixture');
      assert.equal(req.headers['x-workbuddy-pi-thread-id'], ids.threadId);
      assert.equal(req.headers['x-workbuddy-pi-turn-id'], ids.turnId);
      requests.push(body);
      chronology.push(`model-${requests.length}`);
      assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), ['read', toolName].sort());
      const system = body.messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => textContent(message.content)).join('\n');
      assert.ok(system.includes(expertMarker));
      assert.ok(system.includes(skillMarker));
      assert.ok(system.includes(expertPackage.skillPath), 'Installed Expert resource path must reach the actual model request');
      assert.ok(system.includes('Read this synthetic resource only if the task requires it.'), 'Installed Expert resource description must reach the actual model request');
      assert.ok(system.includes('不授予新工具权限'));
      assert.ok(!JSON.stringify(body).includes(expertSkillBody), 'Package skill bodies must remain progressive resources');
      assert.ok(!system.includes('STALE_STARTUP_CONTEXT_MUST_NOT_REACH_MODEL'));
      if (requests.length === 1) {
        const user = body.messages.find(message => message.role === 'user');
        const image = user?.content?.find(part => part.type === 'image_url');
        assert.ok(image?.image_url?.url?.startsWith('data:image/png;base64,'), 'Prepared image must reach the real Pi model payload');
        assert.deepEqual(Buffer.from(image.image_url.url.split(',', 2)[1], 'base64'), png);
        const prompt = textContent(user.content);
        assert.ok(prompt.includes(JSON.stringify({ id: '122844', name: '企业微信' })), 'The selected scene must reach Pi as user context');
        assert.ok(prompt.includes('不改变已授权工具'));
        assert.ok(prompt.includes(longBody), 'The entire native long-paste body must reach the fake model, not merely its preview');
        assert.ok(prompt.indexOf('PASTE_BEFORE|') < prompt.indexOf('NATIVE_LONG_FIRST|'));
        assert.ok(prompt.indexOf('|NATIVE_LONG_LAST') < prompt.indexOf('|PASTE_AFTER'));
        assert.ok(!prompt.includes('scene://')); assert.ok(!prompt.includes('longtext://')); assert.ok(!prompt.includes('<svg'));
        for (const marker of ['DOCX-TABLE-OK', 'XLSX-OK', 'PPTX-FIRST', ...(process.platform === 'darwin' ? ['PDF-TEXT-OK', 'SCAN-REPORT-2026'] : [])]) {
          assert.ok(prompt.includes(marker), `Extracted document marker ${marker} must reach the actual Pi model payload`);
        }
        assert.equal(approvalCount, 0);
        assert.equal(inputCount, 0);
      } else {
        assert.equal(requests.length, 2, 'Fixture needs exactly one model tool round trip');
        assert.equal(approvalCount, 1);
        assert.equal(inputCount, 1);
        assert.equal(approvalConsumed, true);
        const result = body.messages.find(message => message.role === 'tool' && message.tool_call_id === toolCallId);
        assert.ok(textContent(result?.content).includes(resultMarker), 'Native result must return to the real Pi model loop');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const frame = value => res.write(`data: ${JSON.stringify({ id: `fixture-native-response-${requests.length}`,
        object: 'chat.completion.chunk', created: 1, model: body.model, ...value })}\n\n`);
      frame({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      if (requests.length === 1) {
        frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: toolCallId, type: 'function',
          function: { name: toolName, arguments: JSON.stringify(toolArguments) } }] }, finish_reason: null }] });
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
      } else {
        frame({ choices: [{ index: 0, delta: { content: finalMarker }, finish_reason: null }] });
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33 } });
      }
      res.end('data: [DONE]\n\n');
    })().catch(error => {
      failure ??= error;
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  t.after(async () => {
    closing = true;
    await client?.close();
    await Promise.allSettled([...pendingResponses]);
    if (server.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  writeFileSync(join(bridgeDir, 'locator.json'), JSON.stringify({ version: 1, port: server.address().port,
    pid: process.pid, ticket, expiresAt: Date.now() + 600_000 }), { mode: 0o600 });
  client = new PiRpcClient({ command: process.env.PI_TEST_COMMAND,
    args: [...extraArgs, '--mode', 'rpc', '--provider', 'workbuddy-official', '--model', 'hy4-native-fixture', '--thinking', 'off',
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-mcp', '--no-context-files', '--offline',
      '--tools', `read,${toolName}`, '--extension', officialExtension, '--extension', nativeExtension, '--extension', approvalExtension,
      '--session', join(root, 'session.jsonl')],
    cwd: root, env: { HOME: root, PATH: process.env.PATH, TMPDIR: temporaryDir, XDG_CONFIG_HOME: join(root, 'xdg'),
      PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0',
      WORKBUDDY_PI_OFFICIAL_BRIDGE_DIR: bridgeDir, WORKBUDDY_PI_REQUEST_CONTEXT_FILE: requestContextFile,
      WORKBUDDY_PI_NATIVE_CONTEXT_FILE: nativeContextFile, WORKBUDDY_PI_APPROVAL_TIMEOUT_MS: '5000' }, timeoutMs: 10_000,
  });
  const respond = response => {
    const pending = client.sendExtensionUiResponse(response).catch(error => { if (!closing) failure ??= error; });
    pendingResponses.add(pending);
    void pending.finally(() => pendingResponses.delete(pending));
  };
  client.on('failure', error => { if (!closing) failure ??= error; });
  client.on('event', record => {
    records.push(record);
    if (record.type !== 'extension_ui_request') return;
    try {
      if (record.method === 'confirm') {
        assert.equal(record.title, APPROVAL_TITLE);
        const approval = JSON.parse(record.message);
        assert.equal(approval.protocol, APPROVAL_PROTOCOL);
        assert.equal(approval.toolName, toolName);
        assert.equal(approval.toolCallId, toolCallId);
        assert.deepEqual(approval.input, toolArguments);
        assert.equal(approvalCount, 0, 'Only one exact fixture approval may be granted');
        approvalCount++;
        approvedToolCall = approval.toolCallId;
        chronology.push('approval');
        respond({ id: record.id, confirmed: true });
      } else if (record.method === 'input') {
        assert.equal(record.title, NATIVE_TITLE);
        const call = JSON.parse(record.placeholder);
        assert.deepEqual(call, { protocol: NATIVE_CALL, toolCallId, name: toolName, arguments: toolArguments, ...ids });
        assert.equal(record.timeout, 120_000);
        assert.equal(approvedToolCall, call.toolCallId);
        assert.equal(approvalCount, 1);
        assert.equal(inputCount, 0);
        assert.equal(approvalConsumed, false);
        inputCount++;
        approvalConsumed = true;
        chronology.push('native-input');
        respond({ id: record.id, value: JSON.stringify({ ok: true, result: { content: [{ type: 'text', text: resultMarker }], isError: false } }) });
      }
    } catch (error) {
      failure ??= error;
      if (record.method === 'confirm') respond({ id: record.id, confirmed: false });
    }
  });
  const waitFor = async predicate => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (failure) throw failure;
      if (Date.now() > deadline) throw Error('Native fixture Pi RPC event timed out');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (failure) throw failure;
  };
  const state = await client.getState();
  assert.equal(state.model.provider, 'workbuddy-official');
  assert.equal(state.model.id, 'hy4-native-fixture');
  for (const ready of [NATIVE_READY, APPROVAL_READY, 'workbuddy-official-provider-ready-v1']) {
    assert.ok(records.some(record => record.type === 'extension_ui_request' && record.method === 'notify' && record.message === ready), ready);
  }
  writeFileSync(nativeContextFile, JSON.stringify(nativeContext(resolvedContext.message)), { mode: 0o600 });
  assert.equal((await client.prompt(prepared.message, { images: prepared.images })).disposition, 'started');
  await waitFor(() => records.some(record => record.type === 'agent_settled'));
  const final = records.filter(record => record.type === 'message_end' && record.message?.role === 'assistant').at(-1)?.message;
  assert.equal(final?.stopReason, 'stop');
  assert.equal(textContent(final?.content), finalMarker);
  const executed = records.find(record => record.type === 'tool_execution_end' && record.toolCallId === toolCallId);
  assert.ok(executed && executed.isError !== true);
  assert.ok(textContent(executed.result?.content).includes(resultMarker));
  assert.deepEqual(chronology, ['model-1', 'approval', 'native-input', 'model-2']);
  assert.equal(requests.length, 2);
  assert.equal(approvalCount, 1);
  assert.equal(inputCount, 1);
  assert.equal(approvalConsumed, true);
});
