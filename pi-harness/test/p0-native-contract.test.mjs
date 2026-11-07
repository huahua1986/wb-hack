// Native consumers are replayed as inert functions with explicit host constants. No app or account is accessed.
import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import vm from'node:vm';import{createHash}from'node:crypto';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/p0-native-592.source.json', import.meta.url)));
function context() {
  const c = vm.createContext({
    console, URL, performance, Set, Map, WeakMap, Date, decodeURIComponent,
    // Diagnostics and native host dependencies are inert test doubles.
    mZ: { windowStartAt: 0, calls: 0, hits: 0 }, b9t: new WeakMap(), x9t: [],
    pZ: 'native-resource', il: () => {}, scheduleChangeArtifactsDiagFlush: () => {}, dl: value => value,
    isMcpAppOrArdotRawArtifact: () => false, isWbAppGenieMarkerRecord: () => false, _he: () => false,
    h8t: { artifacts: [], changes: [], files: [] },
    rejectedReason: result => result.status === 'rejected' ? String(result.reason) : undefined,
  });
  for (const slice of fixture.slices) {
    if (slice.kind === 'constant-assignment') vm.runInContext(slice.source, c);
  }
  for (const slice of fixture.slices) {
    if (slice.kind === 'FunctionDeclaration' && slice.name !== 'useConversationRewind') {
      vm.runInContext(slice.source, c);
    }
  }
  return c;
}
const plain=x=>JSON.parse(JSON.stringify(x));
test('native fixture pins WorkBuddy 5.9.2 members and verifies every UTF-8 slice hash', () => {
  assert.equal(fixture.workbuddyVersion, '5.9.2');
  assert.equal(fixture.artifactSHA256, '0b79c0358c129749bc3355f52bbae13f115577ab37c082a76dfdc54f66fd3f79');
  assert.equal(fixture.slices.length, 73);
  const members = {
    'renderer/assets/contexts-Qs-ojFS9.js': '3e6df25ee2c417f9c791ab3e0ca8c7bad50987c5b294c12a7d6000fc618f71ac',
    'main/conversations.js': 'ccdf4ac294ccdb60ff79bdf44056227ad60b2c6f0fe8e8a51a3d03cee9142726',
    'cli/dist/codebuddy-lite-wb.mjs': '29a2e96949fd85143f85c9fa31ae036657a15c351e847c7944b53a218c850a4d',
  };
  for (const slice of fixture.slices) {
    assert.equal(slice.memberSHA256, members[slice.member]);
    assert.equal(slice.range.encoding, 'UTF-8');
    assert.equal(Buffer.byteLength(slice.source), slice.range.end - slice.range.start);
    assert.equal(createHash('sha256').update(slice.source).digest('hex'), slice.sha256);
  }
});
test('native artifact projector accepts filePath/absolute uri and preserves request identity',()=>{const c=context();for(const[ext,type]of [['docx','document'],['xlsx','spreadsheet'],['pptx','presentation'],['pdf','document'],['txt','code']]){const raw={id:'a-'+ext,conversationId:'native-thread',requestId:'native-r1',type:'file',kind:'media',uri:'/workspace/report.'+ext,filePath:'/workspace/report.'+ext,title:'report.'+ext,createdAt:1,updatedAt:2};const v=c.toConversationArtifactItem(raw,'native-thread');assert.equal(v.type,'media-artifact');assert.equal(v.contentType,type);assert.equal(v.url,raw.uri);assert.equal(v.requestId,'native-r1');}});
test('native manifest consumer renders exact hunks, counts and lazy detail references',()=>{const c=context(),h={oldStart:1,oldLines:1,newStart:1,newLines:1,lines:['-old','+new']},m=[{id:'m1',conversationId:'native-thread',requestId:'native-r1',createdAt:1,detailRef:'detail1',files:[{filePath:'/workspace/a.txt',action:'modify',additions:1,deletions:1,hunks:[h],content:'new'}]}];const v=c.toLegacyConversationChangeArtifacts(m,'native-thread')[0];assert.equal(v.fileChangeInfo.changeType,'modified');assert.match(v.fileChangeInfo.diff,/@@ -1,1 \+1,1 @@\n-old\n\+new/);assert.equal(v.changeDetailRef,'detail1');assert.equal(v.changeRequestId,'native-r1');const m2=[{...m[0],id:'m2',detailRef:'detail2',files:[{filePath:'/workspace/a.txt',action:'create',additions:1,deletions:0,detailStatus:'diff-omitted-size'}]}];const v2=c.toLegacyConversationChangeArtifacts(m2,'native-thread')[0];assert.equal(v2.fileChangeInfo.changeType,'created');assert.equal(v2.fileChangeInfo.diff,undefined);assert.equal(v2.changeDetailStatus,'diff-omitted-size');});
test('native change projection memoizes array identity and removes delete actions',()=>{const c=context(),m=[{id:'m',createdAt:1,files:[{filePath:'/workspace/a.txt',action:'create',additions:1,deletions:0}]}];const first=c.toLegacyConversationChangeArtifacts(m,'t');assert.equal(first.length,1);m.push({id:'delete',createdAt:2,files:[{filePath:'/workspace/a.txt',action:'delete',additions:0,deletions:1}]});assert.equal(c.toLegacyConversationChangeArtifacts(m,'t'),first);assert.equal(c.toLegacyConversationChangeArtifacts([...m],'t').length,0);});
test('file tree source contract is directory/file and native projection adds dir/load flags',()=>{const c=context();const ctx={expandedPaths:new Set(['/workspace']),lookupPrevious:()=>undefined,maxInlineChildren:100};const v=c.toLegacyConversationFileTreeWithContext([{path:'/workspace',name:'workspace',type:'directory',children:[{path:'/workspace/a.txt',name:'a.txt',type:'file'}]}],ctx);assert.equal(v[0].type,'dir');assert.equal(v[0].isLoaded,true);assert.equal(v[0].children[0].type,'file');});
test('checkpoint preview must match artifacts by local path and restoreInfo by prior request',()=>{const c=context(),changes=[{path:'/workspace/a.txt',operation:'write'},{path:'/workspace/new.txt',operation:'delete'}],artifacts=[{id:'a',title:'a.txt',filePath:'/workspace/a.txt'},{id:'b',title:'new.txt',uri:'/workspace/new.txt'}],messages=[{requestId:'r0',messageType:'assistant',finishTime:1000},{requestId:'r1',messageType:'assistant',finishTime:2000}];const items=c.mapPreviewToItems(changes,artifacts,messages,[],[{path:'/workspace/a.txt',versionRequestId:'r1',restorePoint:'exact'}]);assert.equal(items.length,2);assert.equal(items[0].status,'restore-exact');assert.equal(items[1].status,'delete');assert.equal(c.mapPreviewToItems(changes,[],messages).length,0);assert.equal(c.resolveRewindVariantDetailed({available:true,diff:{changes},unavailable:[]},items).variant,'artifacts');});
test('checkpoint unavailable and resend decisions remain explicit',()=>{const c=context();assert.equal(c.shouldRollbackFilesOnResend({available:false}),false);assert.equal(c.shouldRollbackFilesOnResend({available:true,forkPoint:{found:false},diff:{changes:[{}]}}),false);assert.equal(c.shouldRollbackFilesOnResend({available:true,diff:{changes:[{}]}}),true);assert.equal(c.resolveEditVariantDetailed({available:false},[]).degradedReason,'preview-unavailable');});
test('configuration thought_level state distinguishes disabled/enabled from named effort',()=>{const c=context();assert.equal(c.applyServerThoughtLevelChoice({id:'hy4',isThinking:true,reasoningEffort:'high'},'disabled').isThinking,false);assert.equal(c.applyServerThoughtLevelChoice({id:'hy4',isThinking:false},'enabled').isThinking,true);assert.equal(c.applyServerThoughtLevelChoice({id:'hy4'},'low').reasoningEffort,'low');});
test('resource loader uses manifests, falls back to changes, and accepts arrays',async()=>{const c=context();const seen=[];const v=await c.loadConversationResources(async()=>({info:{transport:'local'},artifacts:async()=>{seen.push('artifacts');return[{id:'a'}]},files:async()=>{seen.push('files');return[{path:'/workspace/a.txt',name:'a.txt',type:'file'}]},changeManifests:async()=>{seen.push('manifests');throw Error('no manifests')},changes:async()=>{seen.push('changes');return[{id:'m'}]}}));assert.deepEqual(plain(v.artifacts),[{id:'a'}]);assert.deepEqual(plain(v.changes),[{id:'m'}]);assert.equal(v.files[0].path,'/workspace/a.txt');assert.deepEqual(seen.sort(),['artifacts','changes','files','manifests']);});

const compactFixture = JSON.parse(fs.readFileSync(new URL('./fixtures/p0-native-592-compact.source.json', import.meta.url)));
function compactContext() {
  const c = vm.createContext({
    splitInternalSendOptions: options => options ?? {},
    normalizeUserPromptBlocks: blocks => [...blocks],
  });
  for (const slice of compactFixture.slices) {
    if (['FunctionDeclaration', 'AssignmentExpression'].includes(slice.kind)) vm.runInContext(slice.source, c);
  }
  return c;
}
test('native compact fixture pins exact matcher and input-dispatch method ranges', () => {
  assert.equal(compactFixture.artifactSHA256, fixture.artifactSHA256);
  assert.equal(compactFixture.slices.length, 9);
  for (const slice of compactFixture.slices) {
    assert.equal(slice.memberSHA256, '3e6df25ee2c417f9c791ab3e0ca8c7bad50987c5b294c12a7d6000fc618f71ac');
    assert.equal(Buffer.byteLength(slice.source), slice.range.end - slice.range.start);
    assert.equal(createHash('sha256').update(slice.source).digest('hex'), slice.sha256);
  }
});
test('native lifecycle matcher recognizes exact aliases and command:// blocks before ordinary prompts', () => {
  const c = compactContext();
  for (const value of ['/compact', ' /COMPACT ', '/总结']) {
    assert.equal(c.matchLifecycleSlashCommand([{ type: 'text', text: value }]), 'compact');
  }
  assert.equal(c.matchLifecycleSlashCommand([{ type: 'resource_link', uri: 'command://compact' }]), 'compact');
  assert.equal(c.matchLifecycleSlashCommand([{ type: 'text', text: '/compact extra' }]), undefined);
  assert.equal(c.matchLifecycleSlashCommand([{ type: 'text', text: '/clear' }, { type: 'text', text: 'extra' }]), undefined);
  assert.equal(c.matchLifecycleSlashCommand([{ type: 'text', text: '/清空' }]), 'clear');
  assert.equal(c.matchLifecycleSlashCommand([{ type: 'text', text: 'extra' }, { type: 'resource_link', uri: 'command://compact' }]), 'compact');
});
test('native InputCapability compact branch calls lifecycle callback without reaching ordinary conversation send', async () => {
  const c = compactContext();
  const method = compactFixture.slices.find(slice => slice.name === 'runSendPrompt').source;
  const Input = vm.runInContext(`(class { ${method} })`, c);
  const input = new Input(); let compactions = 0;
  input.runLifecycleCompact = async () => { compactions++; };
  input.getConversation = () => { throw new Error('Matched lifecycle command must not create a model turn'); };
  const value = await input.runSendPrompt({ blocks: [{ type: 'text', text: '/compact' }] });
  assert.equal(value.ok, true); assert.equal(compactions, 1);
  input.runLifecycleCompact = async () => { throw new Error('synthetic compact failure'); };
  const failed = await input.runSendPrompt({ blocks: [{ type: 'resource_link', uri: 'command://compact' }] });
  assert.equal(failed.ok, false); assert.equal(failed.error.code, 'conversation-compact-error');
  const stale = await input.runSendPrompt({ blocks: [{ type: 'text', text: '/compact' }] }, { isCurrent: () => false });
  assert.equal(stale.ok, false); assert.equal(compactions, 1);
});
test('native public UI facade exposes lifecycle methods but no direct compact flag', () => {
  const c = compactContext();
  const method = compactFixture.slices.find(slice => slice.name === 'getUiApi').source;
  const Controller = vm.runInContext(`(class { ${method} })`, c);
  const facade = new Controller().getUiApi();
  assert.deepEqual(Object.keys(facade.lifecycle), ['clear', 'rename', 'listUserPrompts', 'ensureRequestLoaded', 'listInputHistory']);
  assert.equal(facade.lifecycle.compact, undefined);
  assert.equal(typeof facade.input.sendPrompt, 'function');
});
test('native branch-result parser requires all truncation identity fields', () => {
  const c = compactContext();
  assert.equal(c.readResendResult({ removedRequestIds: ['r2'] }), undefined);
  const result = { branchChanged: true, truncatedFromRequestId: 'r2', removedRequestIds: ['r2', 'r3'] };
  assert.deepEqual(plain(c.readResendResult(result)), result);
  assert.equal(c.readResendResult({ ...result, branchChanged: false }), undefined);
  assert.equal(c.readResendResult({ ...result, removedRequestIds: [1] }), undefined);
});
