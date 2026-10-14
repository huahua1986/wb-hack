import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureLocalGateway, launchDesktopWorkbench } from '../src/desktop-launcher.mjs';
import { AuthStore } from '../src/store.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-desktop-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const config=path.join(root,'workbuddy-launcher.json'),appPath=path.join(root,'WorkBuddy.app');
  const settings={gateway:'https://auth.example.test',appPath,productName:'企业AI工作台',welcomeTitle:'企业AI工作台，我帮你',mode:'development'};
  fs.writeFileSync(config,JSON.stringify(settings));return{root,config,settings};
}

test('Dock reopening requires the same live branded process, not a reused PID or other launch source',async t=>{
  const f=fixture(t),dir=path.join(f.root,'auth-gateway','client-profiles','double-click');fs.mkdirSync(dir,{recursive:true});
  const owner={pid:4441,processFingerprint:'start-A',executable:path.join(f.settings.appPath,'Contents','MacOS','Electron'),gateway:f.settings.gateway,mode:f.settings.mode,runtimeBranding:{productName:f.settings.productName,welcomeTitle:f.settings.welcomeTitle,inspectorClosed:true}};
  fs.writeFileSync(path.join(dir,'last-launch.json'),JSON.stringify(owner));
  const options={findProcesses:()=>[4441,4442],fingerprint:()=> 'start-A',ensureGateway:()=>{throw Error('No extra gateway startup');},start:()=>{throw Error('No extra WorkBuddy startup');}};
  assert.equal((await launchDesktopWorkbench(f.config,options)).status,'running');
  await assert.rejects(launchDesktopWorkbench(f.config,{...options,fingerprint:()=> 'start-B'}),/其他入口/);
  owner.runtimeBranding.inspectorClosed=false;fs.writeFileSync(path.join(dir,'last-launch.json'),JSON.stringify(owner));
  await assert.rejects(launchDesktopWorkbench(f.config,options),/其他入口/);
});

test('cold desktop launch waits for gateway readiness before invoking the existing branded launcher',async t=>{
  const f=fixture(t),order=[];
  const result=await launchDesktopWorkbench(f.config,{findProcesses:()=>[],ensureGateway:async()=>{order.push('gateway');return{started:true};},prepare:()=>{order.push('prepare');return{};},start:async()=>{order.push('branded-start');return{pid:5555};}});
  assert.deepEqual(order,['gateway','prepare','branded-start']);assert.equal(result.pid,5555);assert.equal(result.gatewayStarted,true);
});

test('remote gateways are not started locally; an unrelated localhost service is never replaced',async t=>{
  const f=fixture(t);let spawned=false;
  const dependencies={request:async()=>({ok:true,json:async()=>({data:{service:'unrelated',status:'ok'}})}),spawnProcess:()=>{spawned=true;}};
  assert.equal((await ensureLocalGateway(f.settings,f.root,dependencies)).managed,false);
  await assert.rejects(ensureLocalGateway({...f.settings,gateway:'http://127.0.0.1:8787'},f.root,dependencies),/其他服务/);assert.equal(spawned,false);
  await assert.rejects(ensureLocalGateway({...f.settings,gateway:'http://127.0.0.1:8787'},f.root,{...dependencies,request:async()=>{throw Object.assign(new Error('refused'),{cause:{code:'ECONNREFUSED'}});}}),/账号库和密钥/);assert.equal(spawned,false);
});

test('cold localhost backend boot reuses the existing account database and is reused on second launch',async t=>{
  const f=fixture(t),dataDir=path.join(f.root,'auth-gateway','data');
  const config={dataDir,publicUrl:'http://127.0.0.1:8787',accessTtlSeconds:3600,refreshTtlSeconds:1209600,loginTtlSeconds:300};
  const store=new AuthStore(config);store.close();
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const settings={...f.settings,gateway:`http://127.0.0.1:${port}`};
  const first=await ensureLocalGateway(settings,f.root);assert.equal(first.started,true);
  t.after(async()=>{try{process.kill(first.pid,'SIGTERM');}catch{}for(let i=0;i<30;i++){try{process.kill(first.pid,0);}catch{return;}await delay(100);}});
  const second=await ensureLocalGateway(settings,f.root);assert.equal(second.started,false);
  assert.ok(fs.existsSync(path.join(dataDir,'delivery.key')));assert.ok(fs.existsSync(path.join(dataDir,'gateway.sqlite')));
});
