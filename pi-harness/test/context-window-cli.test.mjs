import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const {PiHarness}=process.env.PI_TEST_HARNESS_MODULE ? await import(pathToFileURL(process.env.PI_TEST_HARNESS_MODULE).href) : await import('../src/pi-harness.mjs');
const require=createRequire(import.meta.url);
const {startOfficialModelBridge}=require(process.env.PI_TEST_HARNESS_MODULE ? path.join(path.dirname(process.env.PI_TEST_HARNESS_MODULE),'official-model-bridge.cjs') : '../src/official-model-bridge.cjs');

test('real Pi uses the native 300k window across large tool results, while empty length stops surface without replay', {skip:!process.env.PI_TEST_COMMAND,timeout:45000},async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'wb-pi-window-041-')));
 const agentDir=path.join(root,'agent'),stateDir=path.join(root,'state'),bridgeDir=path.join(root,'bridge');
 fs.mkdirSync(agentDir,{mode:0o700});
 fs.writeFileSync(path.join(agentDir,'models.json'),JSON.stringify({providers:{}}));
 const settings=enabled=>fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({compaction:{enabled}}));settings(true);
 const files=['a','b','c'].map(n=>path.join(root,`synthetic-${n}.txt`));
 files.forEach(f=>fs.writeFileSync(f,'Q'.repeat(48000)+'\n'));
 const current={account:{uid:'synthetic-window-user',type:'ultimate'},auth:{accessToken:'synthetic-official-token'}};
 const product={endpoint:'https://www.workbuddy.cn',models:[{id:'hy4',supportsImages:false,supportsToolCall:true,contextWindow:{defaultLength:300000,supportedLengths:[300000,600000,960000]},maxInputTokens:960000,maxOutputTokens:64000},
   {id:'small',supportsToolCall:true,supportsImages:false,contextWindow:{defaultLength:64000,supportedLengths:[64000,128000]},maxInputTokens:128000,maxOutputTokens:8192}]};
 const requests=[],events=[];let phase='long',failure,harness;
 const bridge=await startOfficialModelBridge({bridgeDir,authenticationManager:{currentSessionSubject:{getValue:()=>current,subscribe:()=>({unsubscribe(){}})},waitForSessionRefresh:async()=>{},refreshSessionForAuthenticationFailure:async()=>{}},
  productManager:{waitConfiguration:async()=>product,getEndpoint:()=>product.endpoint},productEnvService:{getCurrent:async()=>''},
  restOperations:{async request(req){
   try{
    const body=req.data;requests.push({phase,maxTokens:body.max_tokens,toolResults:body.messages.filter(m=>m.role==='tool').length,toolTextChars:body.messages.filter(m=>m.role==='tool').reduce((n,m)=>n+(typeof m.content==='string'?m.content.length:0),0)});
    const count=requests.filter(r=>r.phase===phase).length;
    assert.ok(count <= (phase==='long'?2:1),'No hidden compaction/generation/tool replay is allowed');
    const frames=[];const frame=(delta,finish=null,usage)=>frames.push(`data: ${JSON.stringify({id:`synthetic-${phase}-${count}`,object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:finish}],...(usage?{usage}:{})})}\n\n`);
    if(phase==='long'&&count===1){
     frame({role:'assistant',tool_calls:files.map((f,index)=>({index,id:`fixture-read-${index}`,type:'function',function:{name:'read',arguments:JSON.stringify({path:f})}}))});
     frame({},'tool_calls',{prompt_tokens:2000,completion_tokens:100,total_tokens:2100});
    }else if(phase==='long'){
     assert.equal(body.max_tokens,64000);assert.equal(requests.at(-1).toolResults,3);assert.ok(requests.at(-1).toolTextChars>100000);
     frame({role:'assistant',content:'LONG_CONTEXT_041_OK'});frame({},'stop',{prompt_tokens:50000,completion_tokens:20,total_tokens:50020});
    }else if(phase==='selected'){
     assert.equal(body.max_tokens,64000);frame({role:'assistant',content:'WINDOW_960K_OK'});frame({},'stop',{prompt_tokens:50000,completion_tokens:20,total_tokens:50020});
    }else{frame({role:'assistant'});frame({},'length',{prompt_tokens:1000,completion_tokens:1,total_tokens:1001});}
    frames.push('data: [DONE]\n\n');return {status:200,data:Readable.from(frames)};
   }catch(e){failure=e;throw e;}
  }}});
 t.after(async()=>{await harness?.close();await bridge.close();fs.rmSync(root,{recursive:true,force:true});});
 const args=JSON.parse(process.env.PI_TEST_ARGS??'[]');
 const options={command:process.env.PI_TEST_COMMAND,args,cwd:root,stateDir,agentDir,officialOnly:true,officialBridgeDir:bridgeDir,provider:'workbuddy-official',model:'hy4',tools:['read'],requestTimeoutMs:10000,env:{HOME:root,PATH:process.env.PATH??'',TMPDIR:root,PI_OFFLINE:'1',PI_TELEMETRY:'0'}};
 const wait=async predicate=>{const end=Date.now()+15000;while(!predicate()){if(failure)throw failure;if(Date.now()>end)throw Error('Synthetic context fixture timed out');await new Promise(r=>setTimeout(r,10));}};
 harness=new PiHarness(options);harness.subscribe(e=>events.push(e));
 const thread=await harness.createThread();await harness.startTurn({threadId:thread.id,prompt:'Read the three synthetic local fixture files, then reply LONG_CONTEXT_041_OK.'});
 await wait(()=>harness.listThreads().find(t=>t.id===thread.id).turns[0].status!=='running');
 const first=harness.listThreads().find(t=>t.id===thread.id).turns[0];
 assert.equal(first.status,'completed');assert.equal(first.items.filter(i=>i.type==='tool').length,3);
 assert.ok(first.items.some(i=>i.text==='LONG_CONTEXT_041_OK'));assert.equal(requests.length,2);
 assert.equal((await harness.refreshOfficialModels())[0].contextWindow,300000);
 const session=path.join(stateDir,'sessions',`${thread.id}.jsonl`),originalBytes=fs.readFileSync(session);
 await harness.setContextWindow({threadId:thread.id,contextWindow:960000});
 const selectedStats=await harness.refreshContextUsage({threadId:thread.id});
 assert.equal(selectedStats.contextWindow,960000);assert.equal(requests.length,2);assert.deepEqual(fs.readFileSync(session),originalBytes);
 await harness.close();harness=new PiHarness(options);await harness.refreshOfficialModels();
 assert.equal(harness.listThreads().find(t=>t.id===thread.id).contextWindow,960000);
 const coldStats=await harness.refreshContextUsage({threadId:thread.id});assert.equal(coldStats.contextWindow,960000);assert.deepEqual(fs.readFileSync(session),originalBytes);assert.equal(requests.length,2);
 await harness.setModel({threadId:thread.id,model:'small'});assert.equal(harness.listThreads().find(t=>t.id===thread.id).contextWindow,64000);
 await assert.rejects(harness.setContextWindow({threadId:thread.id,contextWindow:960000}),{code:'INVALID_PARAMS'});
 await harness.setContextWindow({threadId:thread.id,contextWindow:128000});assert.equal(harness.listThreads().find(t=>t.id===thread.id).contextWindow,128000);
 const smallStats=await harness.refreshContextUsage({threadId:thread.id});assert.equal(smallStats.contextWindow,128000);assert.equal(requests.length,2);assert.deepEqual(fs.readFileSync(session),originalBytes);
 await harness.setModel({threadId:thread.id,model:'hy4'});assert.equal(harness.listThreads().find(t=>t.id===thread.id).contextWindow,960000);
 phase='selected';await harness.startTurn({threadId:thread.id,prompt:'Do not use tools, reply WINDOW_960K_OK.'});
 await wait(()=>harness.listThreads().find(t=>t.id===thread.id).turns[1].status!=='running');
 const continued=harness.listThreads().find(t=>t.id===thread.id);assert.equal(continued.turns[1].status,'completed');assert.ok(continued.turns[1].items.some(i=>i.text==='WINDOW_960K_OK'));
 const continuedStats=await harness.refreshContextUsage({threadId:thread.id});assert.equal(continuedStats.contextWindow,960000);assert.equal(requests.filter(r=>r.phase==='selected').length,1);
 await harness.close();phase='empty';settings(false);harness=new PiHarness(options);
 const second=await harness.createThread();await harness.startTurn({threadId:second.id,prompt:'Synthetic empty length response, do not use tools.'});
 await wait(()=>harness.listThreads().find(t=>t.id===second.id).turns[0].status!=='running');
 const failed=harness.listThreads().find(t=>t.id===second.id).turns[0];
 assert.equal(failed.status,'failed');assert.equal(failed.error.code,'PI_RESPONSE_TRUNCATED');
 assert.ok(failed.items.some(i=>i.origin==='host-diagnostic'));assert.equal(requests.filter(r=>r.phase==='empty').length,1);
 assert.equal(failed.items.filter(i=>i.type==='tool').length,0);
});
