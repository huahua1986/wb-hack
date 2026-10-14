import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { brandingScripts, installRuntimeBranding, parseInspectorEndpoint } from '../src/runtime-branding.mjs';
import vm from 'node:vm';

function renderer() {
  const sidebar = { nodes: [{ data: 'WorkBuddy' }] };
  const welcome = { nodes: [{ data: 'WorkBuddy, ' }, { data: '我帮你' }] };
  const untouchedTag = { data: '企业模板标签' };
  const observers = [];
  const context = {
    window: {}, NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() { this.active = true; } disconnect() { this.active = false; }
    },
    document: {
      documentElement: {},
      querySelectorAll: selector => selector === '.logo-workbuddy-title' ? [sidebar] : [welcome],
      createTreeWalker: element => { let index = 0; return { nextNode: () => element.nodes[index++] }; },
    },
  };
  return { context, sidebar, welcome, untouchedTag, observers };
}

test('branding preserves existing text nodes and neighbouring tags across React updates', () => {
  const r = renderer(), first = r.sidebar.nodes[0];
  const { rendererScript } = brandingScripts({ appAsarPath: '/test/app.asar', productName: '企业AI工作台', welcomeTitle: '企业AI工作台，我帮你' });
  const result = vm.runInNewContext(rendererScript, r.context);
  assert.equal(result.sidebar, 1); assert.equal(result.welcome, 1);
  assert.equal(r.sidebar.nodes[0], first);
  assert.equal(first.data, '企业AI工作台');
  assert.equal(r.welcome.nodes.map(n => n.data).join(''), '企业AI工作台，我帮你');
  assert.equal(r.untouchedTag.data, '企业模板标签');
  first.data = 'WorkBuddy'; r.welcome.nodes[0].data = 'WorkBuddy, ';
  r.observers[0].callback();
  assert.equal(first.data, '企业AI工作台');
  vm.runInNewContext(rendererScript, r.context);
  assert.equal(r.observers[0].active, false); assert.equal(r.observers[1].active, true);
});

test('display names are data and inspector endpoints remain on literal loopback', async () => {
  const name = '企业 "${notCode}" <script>name</script>';
  const r = renderer(); vm.runInNewContext(brandingScripts({ appAsarPath: '/test/app.asar', productName: name }).rendererScript, r.context);
  assert.equal(r.sidebar.nodes[0].data, name);
  assert.equal(parseInspectorEndpoint('Debugger listening on ws://127.0.0.1:1234/uuid-test\n'), 'ws://127.0.0.1:1234/uuid-test');
  assert.equal(parseInspectorEndpoint('Debugger listening on ws://remote.example:1234/id\n'), undefined);
  assert.equal(parseInspectorEndpoint('Debugger listening on ws://127.0.0.1:1234/id?secret=x\n'), undefined);
  await assert.rejects(installRuntimeBranding('ws://remote.example:1234/id', {}), /本机/);
});

test('real Inspector bootstrap runs before entry, reapplies on navigation, and closes its listener', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-branding-inspector-'));
  const appAsarPath = path.join(root, 'app.asar');
  const report = path.join(root, 'report.json');
  fs.mkdirSync(path.join(root, 'node_modules', 'electron'), { recursive: true });
  fs.mkdirSync(appAsarPath);
  fs.writeFileSync(path.join(root, 'node_modules', 'electron', 'index.js'), `
    const {EventEmitter}=require('node:events'); const vm=require('node:vm');
    const app=new EventEmitter(); app.getAppPath=()=>${JSON.stringify(appAsarPath)};
    let serial=0; const all=[];
    function make(url){const c=new EventEmitter();c.id=++serial;c.getURL=()=>url;c.isDestroyed=()=>false;c.isLoadingMainFrame=()=>false;c.evaluations=0;
      c.sidebar={data:'WorkBuddy'};c.welcome={data:'WorkBuddy, 我帮你'};c.context={window:{},NodeFilter:{SHOW_TEXT:4},MutationObserver:class{observe(){}disconnect(){}},document:{documentElement:{},querySelectorAll:s=>[{nodes:[s==='.logo-workbuddy-title'?c.sidebar:c.welcome]}],createTreeWalker:e=>{let i=0;return{nextNode:()=>e.nodes[i++]}}}};
      c.executeJavaScript=async s=>{c.evaluations++;return vm.runInNewContext(s,c.context)};all.push(c);app.emit('web-contents-created',{},c);return c;}
    module.exports={app,webContents:{getAllWebContents:()=>all},make};
  `);
  const entry = path.join(root, 'entry.cjs');
  fs.writeFileSync(entry, `const fs=require('node:fs');const e=require('electron');
    const c=e.make(${JSON.stringify('file://' + appAsarPath + '/renderer/index.html?seed=private-fixture')});
    const guest=e.make('file:///unrelated/editor.html');
    setTimeout(()=>{c.sidebar.data='WorkBuddy';c.welcome.data='WorkBuddy, 我帮你';c.emit('did-finish-load');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(report + '.tmp')},JSON.stringify({sidebar:c.sidebar.data,welcome:c.welcome.data,evaluations:c.evaluations,guestEvaluations:guest.evaluations}));fs.renameSync(${JSON.stringify(report + '.tmp')},${JSON.stringify(report)})},20)},30);
    setInterval(()=>{},1000);
  `);
  const child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', entry], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  let output = '';
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Inspector fixture startup timeout')), 10000);
    child.stderr.on('data', data => { output = (output + data.toString()).slice(-16384); const url = parseInspectorEndpoint(output); if(url){clearTimeout(timer);resolve(url);} });
    child.once('error', reject);
  });
  const result = await installRuntimeBranding(endpoint, { appAsarPath, productName: '企业AI工作台', welcomeTitle: '企业AI工作台，我帮你' });
  assert.equal(result.inspectorClosed, true);
  for(let i=0;i<50&&!fs.existsSync(report);i++) await delay(20);
  const data = JSON.parse(fs.readFileSync(report));
  assert.equal(data.sidebar, '企业AI工作台'); assert.equal(data.welcome, '企业AI工作台，我帮你');
  assert.ok(data.evaluations >= 2); assert.equal(data.guestEvaluations, 0);
});
