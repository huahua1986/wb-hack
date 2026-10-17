import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {execFile} from 'node:child_process';import {fileURLToPath} from 'node:url';import {promisify} from 'node:util';
const run=promisify(execFile),preload=fileURLToPath(new URL('../../scripts/offline-validation/preload.cjs',import.meta.url));
async function fixture(t,proxy=false){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-offline-fault-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let hits=0;const server=http.createServer((_req,res)=>{hits++;res.end('private fixture');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const config=path.join(root,'config.json');fs.writeFileSync(config,JSON.stringify({log:path.join(root,'events.jsonl'),proxyPorts:proxy?[server.address().port]:[],hosts:[]}));
  return{root,config,url:`http://127.0.0.1:${server.address().port}`,hits:()=>hits};
}
test('offline fault injection fails external requests but preserves local traffic and propagates to sanitized Node children',async t=>{
  const f=await fixture(t),probe=path.join(f.root,'probe.cjs');
  fs.writeFileSync(probe,`const cp=require('node:child_process');(async()=>{const local=await fetch(process.argv[2]);let outside;try{await fetch('https://198.51.100.1/');outside='unexpected';}catch(e){outside=e.cause?.code;}const child=cp.spawnSync(process.execPath,['-e',"console.log(JSON.stringify({hook:!!globalThis[Symbol.for('workbuddy.offline-test')],leaked:!!process.env.WB_TEST_UNUSED_SECRET}))"],{env:{},encoding:'utf8'});console.log(JSON.stringify({local:local.status,outside,child:JSON.parse(child.stdout)}));})()`);
  const result=await run(process.execPath,['--require',preload,probe,f.url],{env:{...process.env,WB_OFFLINE_TEST_CONFIG:f.config,WB_TEST_UNUSED_SECRET:'fixture-only'},timeout:5000});
  const value=JSON.parse(result.stdout.trim());assert.equal(value.local,200);assert.equal(value.outside,'ENETUNREACH');assert.equal(value.child.hook,true);assert.equal(value.child.leaked,false);assert.equal(f.hits(),1);
});
test('a local system proxy cannot give a test process external access and ordinary processes keep their own behavior',async t=>{
  const f=await fixture(t,true);const expression=`fetch(${JSON.stringify(f.url)}).then(r=>console.log(r.status)).catch(e=>console.log(e.cause?.code))`;
  const isolated=await run(process.execPath,['--require',preload,'-e',expression],{env:{...process.env,WB_OFFLINE_TEST_CONFIG:f.config},timeout:5000});
  assert.equal(isolated.stdout.trim(),'ENETUNREACH');assert.equal(f.hits(),0);
  const normal=await run(process.execPath,['-e',expression],{timeout:5000});assert.equal(normal.stdout.trim(),'200');assert.equal(f.hits(),1);
});

test('delayed external failure honors caller cancellation while local requests remain immediate',async t=>{
  const f=await fixture(t);const config=JSON.parse(fs.readFileSync(f.config));config.delayMs=1500;fs.writeFileSync(f.config,JSON.stringify(config));
  const expression=`(async()=>{const started=Date.now();let error;try{await fetch('https://198.51.100.1/',{signal:AbortSignal.timeout(40)})}catch(e){error=e.name}const local=await fetch(${JSON.stringify(f.url)});console.log(JSON.stringify({error,local:local.status,elapsed:Date.now()-started}))})()`;
  const result=await run(process.execPath,['--require',preload,'-e',expression],{env:{...process.env,WB_OFFLINE_TEST_CONFIG:f.config},timeout:3000});
  const value=JSON.parse(result.stdout.trim());assert.equal(value.error,'TimeoutError');assert.equal(value.local,200);assert.ok(value.elapsed<700);
});
