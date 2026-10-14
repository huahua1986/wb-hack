import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AuthStore } from '../src/store.mjs';
import { CatalogStore } from '../src/catalog-store.mjs';
import { readConfig } from '../src/config.mjs';
import { adminContext } from '../src/admin-context.mjs';

const marker = 'workbuddy-private-content-demo';
const pluginSchema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const mcpSchema = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

function write(root, filename, content) {
  const target = path.join(root, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
}

export function seedPrivateContent(config, { version = '1.0.0' } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Demo version must have three numeric components');
  const store = new AuthStore(config), catalog = new CatalogStore(config, { db: store.db, key: store.key });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-private-demo-'));
  fs.chmodSync(stage, 0o700);
  const specs = [
    { kind: 'expert', id: 'private-qa-expert', name: '私有测试专家', description: '来自自建内容后端的测试专家，版本 ' + version,
      metadata: { public: true, fixture: marker, pluginName: 'private-qa-expert', agentName: 'private-qa-expert', expertType: 'agent', categoryName: '私有内容' } },
    { kind: 'skill', id: 'private-checklist', name: '私有测试技能', description: '自建后端分发的本地核验清单，版本 ' + version,
      metadata: { public: true, fixture: marker, categoryName: '私有内容', featured: true } },
    { kind: 'connector', id: 'private-echo', name: '私有 Echo', description: '本地 stdio 测试连接器，版本 ' + version,
      metadata: { public: true, fixture: marker, categoryName: '私有内容' } },
  ];
  const published = [];
  try {
    for (const spec of specs) {
      const existing = catalog.get(spec.kind, spec.id, { includeDisabled: true });
      if (existing && existing.metadata.fixture !== marker) throw new Error('Demo id already belongs to other content');
      if (catalog.get(spec.kind, spec.id, { version, includeDisabled: true })) { published.push({ kind: spec.kind, id: spec.id, version, existing: true }); continue; }
      const root = path.join(stage, spec.id);
      const skill = ['---', 'name: private-checklist', 'description: 自建内容后端的安装和更新核验清单', '---', '', '# 私有核验清单', '', '内容版本：' + version, '', '仅核对本地文件、版本和请求来源；不发送邮件、删除文件或访问第三方服务。', '输出安装版本和核验结果。', ''].join('\n');
      if (spec.kind === 'skill') write(root, 'SKILL.md', skill);
      else if (spec.kind === 'expert') {
        write(root, '.codebuddy-plugin/plugin.json', JSON.stringify({ name: spec.id, version, description: spec.description, expertType: 'agent', agentName: spec.id, agents: ['./agents/private-qa-expert.md'], skills: ['./skills/private-checklist'] }, null, 2) + '\n');
        write(root, 'agents/private-qa-expert.md', ['---', 'name: private-qa-expert', 'description: 自有测试专家，安装版本 ' + version, '---', '', '# 私有测试专家', '', '包版本：' + version, '', '帮助核对本地内容包版本和任务要求。仅在用户要求时使用本地工具；不主动发起外部网络请求。', ''].join('\n'));
        write(root, 'skills/private-checklist/SKILL.md', skill);
      } else {
        write(root, 'plugin.json', JSON.stringify({ $schema: pluginSchema, name: spec.id, version, description: spec.description,
          extensions: { 'ai.workbuddy': { schemaVersion: '1.0.0', display: { name: spec.name, description: spec.description } } } }, null, 2) + '\n');
        write(root, 'mcp.json', JSON.stringify({ $schema: mcpSchema, mcpServers: { echo: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/scripts/echo.mjs'] } } }, null, 2) + '\n');
        const echo = [
          "import readline from 'node:readline';",
          "const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
          "const version = " + JSON.stringify(version) + ";",
          "input.on('line', line => {",
          "  let req; try { req = JSON.parse(line); } catch { return; }",
          "  if (req.id === undefined) return;",
          "  let result;",
          "  if (req.method === 'initialize') result = { protocolVersion: req.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'private-echo', version } };",
          "  else if (req.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo a message locally; version ' + version, inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false } }] };",
          "  else if (req.method === 'tools/call' && req.params?.name === 'echo') result = { content: [{ type: 'text', text: 'private-echo@' + version + ': ' + String(req.params?.arguments?.message || '') }] };",
          "  else if (req.method === 'resources/list') result = { resources: [] };",
          "  else if (req.method === 'prompts/list') result = { prompts: [] };",
          "  else if (req.method === 'ping') result = {};",
          "  else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } }) + '\\n'); return; }",
          "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');",
          "});",
          "",
        ].join('\n');
        write(root, 'scripts/echo.mjs', echo);
      }
      const record = catalog.publish({ ...spec, version, categoryId: 'private-content', tags: ['私有测试'], sourceDir: root });
      store.audit('catalog_demo_published', null, null, adminContext());
      published.push({ kind: record.kind, id: record.id, version: record.version, sha256: record.sha256, size: record.size });
    }
    return published;
  } finally { store.close(); fs.rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.umask(0o077);
    const { values } = parseArgs({ options: { version: { type: 'string', default: '1.0.0' }, 'data-dir': { type: 'string' } } });
    const config = readConfig({ ...process.env, ...(values['data-dir'] ? { GATEWAY_DATA_DIR: values['data-dir'] } : {}) });
    console.log(JSON.stringify({ published: seedPrivateContent(config, { version: values.version }) }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
