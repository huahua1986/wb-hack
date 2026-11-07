import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callNativeStdio } from '../src/native-stdio.cjs';

function fixture(t, extra = '') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-stdio-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'mcp.cjs');
  fs.writeFileSync(file, `const rl=require('node:readline').createInterface({input:process.stdin});
require('node:fs').writeFileSync('pid',String(process.pid));
rl.on('line',line=>{const x=JSON.parse(line);const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:x.id,result})+'\\n');
if(x.method==='initialize'){reply({protocolVersion:'2024-11-05',capabilities:{tools:{}}});return;}
if(x.method==='tools/call'){${extra || "reply({content:[{type:'text',text:JSON.stringify({name:x.params.name,args:x.params.arguments,hasEnv:process.env.MCP_FIXTURE==='inherited-private-fixture'})}]});"}}
});`);
  return { root, options: { command: process.execPath, args: [file], env: { MCP_FIXTURE: 'inherited-private-fixture' }, cwd: root,
    toolName: 'lookup', arguments: { query: '中文' }, timeoutMs: 5_000 } };
}
function stopped(root) {
  const pid = Number(fs.readFileSync(path.join(root, 'pid')));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}
test('approved stdio call initializes a local MCP, transfers private env only to server, and closes the owned process', async t => {
  const { root, options } = fixture(t), result = await callNativeStdio(options);
  assert.deepEqual(JSON.parse(result.content[0].text), { name: 'lookup', args: { query: '中文' }, hasEnv: true });
  stopped(root);
});
test('stdio cancellation terminates a waiting tool without retrying it', async t => {
  const { root, options } = fixture(t, "require('node:fs').appendFileSync('calls','one\\n');"), abort = new AbortController();
  const pending = callNativeStdio({ ...options, signal: abort.signal });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(root, 'calls')); i++) await new Promise(resolve => setTimeout(resolve, 10));
  abort.abort(); await assert.rejects(pending, { code: 'NATIVE_MCP_CANCELLED', mayHaveExecuted: true });
  assert.equal(fs.readFileSync(path.join(root, 'calls'), 'utf8'), 'one\n'); stopped(root);
});
test('stdio malformed output and timeout fail with bounded cleanup', async t => {
  for (const [source, code, timeoutMs] of [["process.stdout.write('not-json\\n');", 'NATIVE_MCP_STDIO_PROTOCOL', 5_000], ['', 'NATIVE_MCP_TIMEOUT', 100]]) {
    const { root, options } = fixture(t, source || ';');
    await assert.rejects(callNativeStdio({ ...options, timeoutMs }), { code }); stopped(root);
  }
});
test('stdio input rejects invalid argv/env and a prior cancellation before creating any process', async t => {
  const { root, options } = fixture(t);
  await assert.rejects(callNativeStdio({ ...options, args: [null] }), { code: 'NATIVE_MCP_STDIO_CONFIG_INVALID' });
  await assert.rejects(callNativeStdio({ ...options, env: { bad: null } }), { code: 'NATIVE_MCP_STDIO_CONFIG_INVALID' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(callNativeStdio({ ...options, signal: abort.signal }), { code: 'NATIVE_MCP_CANCELLED' });
  assert.equal(fs.existsSync(path.join(root, 'pid')), false);
});
