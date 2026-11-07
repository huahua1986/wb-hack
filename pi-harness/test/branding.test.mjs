import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import branding from '../src/branding.cjs';

test('branding preserves React text nodes and restores names after a remount without an observer loop', () => {
  const sidebar=[{data:'WorkBuddy'}], welcome=[{data:'WorkBuddy'},{data:'，我帮你'}], observers=[];
  let title='WorkBuddy', titleWrites=0;
  const document={documentElement:{},get title(){return title},set title(value){title=value;titleWrites++;},
    querySelectorAll: selector=>selector.startsWith('.logo')?[sidebar]:[welcome],
    createTreeWalker: nodes=>{let i=0;return {nextNode:()=>nodes[i++]};}};
  const context={document,NodeFilter:{SHOW_TEXT:4},MutationObserver:class{
    constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}
  }};
  const run=()=>vm.runInNewContext(`(${branding.applyBranding.toString()})(${JSON.stringify(branding.DISPLAY_NAME)})`,context);
  run(); assert.equal(sidebar[0].data,'金融buddy');assert.equal(welcome.map(x=>x.data).join(''),'金融buddy，我帮你');
  const originalNode=sidebar[0];observers[0].callback();assert.equal(titleWrites,1);
  sidebar[0].data='WorkBuddy';observers[0].callback();assert.equal(sidebar[0],originalNode);assert.equal(sidebar[0].data,'金融buddy');
  run();assert.equal(observers[0].disconnected,true);assert.equal(titleWrites,1);
});

test('native branding applies only to the exact packaged renderer and reapplies after reload', async () => {
  const app=new EventEmitter(),contents=new EventEmitter(),titles=[],scripts=[];
  const appAsarPath='/bundle/金融buddy.app/Contents/Resources/app.asar';
  let url='https://www.workbuddy.cn/login',name;
  app.getAppPath=()=>appAsarPath;app.setName=value=>{name=value;};
  contents.getURL=()=>url;contents.isDestroyed=()=>false;contents.isLoadingMainFrame=()=>false;
  contents.executeJavaScript=async script=>{scripts.push(script);};
  branding.installBranding({app,appAsarPath,webContents:{getAllWebContents:()=>[contents]},BrowserWindow:{fromWebContents:()=>({setTitle:t=>titles.push(t)})}});
  assert.equal(name,'金融buddy');assert.equal(scripts.length,0);
  url='file://'+encodeURI(appAsarPath+'/renderer/index.html')+'?fixture=1';contents.emit('dom-ready');
  assert.equal(scripts.length,1);assert.equal(titles.at(-1),'金融buddy');
  contents.emit('did-finish-load');assert.equal(scripts.length,2);
  let prevented=false;contents.emit('page-title-updated',{preventDefault(){prevented=true;}});assert.equal(prevented,true);
  url='https://www.workbuddy.cn/account';contents.emit('did-finish-load');assert.equal(scripts.length,2);
  const elsewhere={...app,getAppPath:()=>'/other'};
  assert.throws(()=>branding.installBranding({app:elsewhere,appAsarPath}),/Unexpected/);
});

test('application menu labels change without altering menu actions or unrelated menus', () => {
  const app=new EventEmitter(),action=()=>{},sent=[];
  app.getAppPath=()=>'/app.asar';app.setName=()=>{};
  const Menu={setApplicationMenu: menu=>sent.push(menu)};
  branding.installBranding({app,appAsarPath:'/app.asar',webContents:{getAllWebContents:()=>[]},Menu});
  const menu={items:[{label:'WorkBuddy',submenu:{items:[{label:'关于 WorkBuddy',click:action},{label:'退出 WorkBuddy',role:'quit'}]}},{label:'编辑'}]};
  Menu.setApplicationMenu(menu);
  assert.equal(menu.items[0].label,'金融buddy');
  assert.equal(menu.items[0].submenu.items[0].label,'关于 金融buddy');
  assert.equal(menu.items[0].submenu.items[0].click,action);
  assert.equal(menu.items[0].submenu.items[1].role,'quit');
  assert.equal(menu.items[1].label,'编辑');
  Menu.setApplicationMenu(null);assert.equal(sent.at(-1),null);
});
