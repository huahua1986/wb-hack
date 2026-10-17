import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { brandingScripts, installRuntimeBranding, parseInspectorEndpoint, coalescePrivateNotifications } from '../src/runtime-branding.mjs';
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
    setTimeout(()=>{c.sidebar.data='WorkBuddy';c.welcome.data='WorkBuddy, 我帮你';c.emit('did-finish-load');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(report + '.tmp')},JSON.stringify({sidebar:c.sidebar.data,welcome:c.welcome.data,evaluations:c.evaluations,guestEvaluations:guest.evaluations,beforeResumeProbe:globalThis.beforeResumeProbe===true}));fs.renameSync(${JSON.stringify(report + '.tmp')},${JSON.stringify(report)})},20)},30);
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
  const result = await installRuntimeBranding(endpoint, { appAsarPath, productName: '企业AI工作台', welcomeTitle: '企业AI工作台，我帮你' }, { beforeResume: evaluate => evaluate('globalThis.beforeResumeProbe=true; true') });
  assert.equal(result.inspectorClosed, true);
  for(let i=0;i<50&&!fs.existsSync(report);i++) await delay(20);
  const data = JSON.parse(fs.readFileSync(report));
  assert.equal(data.sidebar, '企业AI工作台'); assert.equal(data.welcome, '企业AI工作台，我帮你'); assert.equal(data.beforeResumeProbe, true);
  assert.ok(data.evaluations >= 2); assert.equal(data.guestEvaluations, 0);
});


test('repeated skill/plugin notifications keep latest state while model and auth events pass immediately',async()=>{
  const sent=[];const contents={send:(...args)=>sent.push(args),isDestroyed:()=>false};const original=contents.send;
  const coalescer=coalescePrivateNotifications(contents,{intervalMs:25});
  for(let version=1;version<=80;version++)contents.send('wb:event',{event:'skill:versionChanged',payload:{version}});
  for(let n=0;n<5;n++){contents.send('chat:delta',{text:'fixture'});contents.send('auth:logout',{n});}
  assert.equal(sent.filter(([c])=>c==='chat:delta').length,5);assert.equal(sent.filter(([c])=>c==='auth:logout').length,5);
  await delay(40);const versions=sent.filter(([c])=>c==='wb:event').map(([,e])=>e.payload.version);
  assert.deepEqual(versions,[1,80]);assert.equal(coalescer.snapshot().coalesced,79);
  contents.send('wb:event',{event:'skill:versionChanged',payload:{version:81}});coalescer.dispose();await delay(35);
  assert.equal(contents.send,original);assert.equal(sent.filter(([c])=>c==='wb:event').length,2);
});


test('a delayed metadata event never crosses a navigation into an unrelated page',async()=>{
  const sent=[];let eligible=true;const c={send:(...args)=>sent.push(args),isDestroyed:()=>false};
  const gate=coalescePrivateNotifications(c,{intervalMs:25,eligible:()=>eligible});
  c.send('wb:event',{event:'skill:versionChanged',payload:{version:1}});
  c.send('wb:event',{event:'skill:versionChanged',payload:{version:2}});eligible=false;
  await delay(40);assert.equal(sent.length,1);gate.dispose();
});


test('a renderer destroyed during deferred delivery cannot crash the main process',async()=>{
  let destroyed=false,calls=0;const c={send(){if(++calls>1){destroyed=true;throw new Error('Object destroyed');}},isDestroyed:()=>destroyed};
  const gate=coalescePrivateNotifications(c,{intervalMs:25});c.send('plugin:changed',{});c.send('plugin:changed',{});
  await delay(40);assert.equal(gate.snapshot().deliveryFailures,1);gate.dispose();
});
