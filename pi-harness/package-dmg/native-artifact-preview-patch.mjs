import { createHash } from 'node:crypto';

export const NATIVE_ARTIFACT_PREVIEW_EVENT = 'workbuddy-pi:files-changed';
export const NATIVE_ARTIFACT_PREVIEW_STATUS_EVENT = 'workbuddy-pi:preview-status';
export const NATIVE_ARTIFACT_PREVIEW_REASONS = Object.freeze(['mounted', 'event', 'matched', 'dirty-skipped', 'unknown-skipped',
  'stale-skipped', 'reloaded', 'read-failed', 'size-skipped', 'nonlocal-skipped', 'extension-skipped', 'session-skipped',
  'content-skipped', 'reader-skipped', 'probe-skipped', 'url-skipped', 'ref-skipped']);
export const NATIVE_ARTIFACT_PREVIEW_PINS = Object.freeze([
  { member: 'renderer/assets/markdown-editor-Dx1HrQJV.js', originalSHA256: 'd94c6e28c281550eefbc4064cfdd36310d6e5ea7cd1e3e1d08e211dcc93796e0', patchedSHA256: '3408b58489c58fee5fd94b8cbf332c05274a3da08825bb1f7f9cfd22488300fd', originalBytes: 10950 },
  { member: 'renderer/assets/markdown-preview-ChA1hFBZ.js', originalSHA256: '0ea32b3fbfe37f61ea73b3a88a6a69e6ad06025974a8799fb5a28cfda3aafb46', patchedSHA256: '46ef29fd72e362a9ce82283460c68f6bf5de7b06b02ead9ee2c32fdf6c6c2d34', originalBytes: 11218 },
  { member: 'renderer/assets/guest-bootstrap-DwaoB8vI.js', originalSHA256: '7383e2c29b4061a5126bf48b0f82db5f9e4af96a8022c3ad464c538a2db013cd', patchedSHA256: '964a4a5cac87335560a1c84a63ed29cb4a34dcb9248cd67c1a9ebb3b5f0f4d18', originalBytes: 11817 },
  { member: 'renderer/assets/use-markdown-document-BuWdW4BN.js', originalSHA256: 'b01c1e1f26b1b4cc8e1d8a8bd2e98cbd1be4dd40041082ce09009a361ed15114', patchedSHA256: 'ced873efabd849d3a83ce21f966deb14b85ff12407548f964c1de6db97f8fd57', originalBytes: 93007 },
  { member: 'renderer/assets/markdown-editor-core-yAIvMwoQ.js', originalSHA256: 'cb5f77ee3d151af813396b353c1bb497983aefd8172746f8c67c067b2212b95a', patchedSHA256: '3fa5d14ed2111dad4845d1aa504f1e4054073154e62eb376cd95f65d708668c1', originalBytes: 790023 },
].map(Object.freeze));

const sha256 = value => createHash('sha256').update(value).digest('hex');
const PROTOCOL_MEMBER = 'renderer/assets/request-tracker-D21R_8D-.js';
const PROTOCOL_SHA256 = '3240c18c0cb454f67b418fa10e8946a7f2b1f833e0c60519ca22e6c2728f8a59';
const CONTEXT_MEMBER = 'renderer/assets/MediaPreviewContext-Bm495Cqg.js';
const CONTEXT_SHA256 = '4f023ea2b84aa7187f7fc3f492c42c1aca598032b88953246333a9103caa2bac';
const ROUTE_MEMBER = 'renderer/assets/media-preview-B_oPj3-H.js';
const ROUTE_SHA256 = '988455e66763689aa0fba8cca8cd54e2f9d741a4c618fddbe42776d65c0754f4';

// The actual MediaPreview MarkdownEditor owns this native ref. Source-file
// viewers use a different component, so this listener cannot edit their text.
const MEDIA_OBSERVER = String.raw`
let wbPiMediaState=(0,l.useRef)(null),wbPiMediaReload=(0,l.useRef)(null);
wbPiMediaState.current={url:d?.url,sessionId:d?.sessionId,id:d?.id,content:c,read:_,probe:N,local:T==='local',extension:P};
const wbPiArtifact=()=>/^pi-file-[a-f0-9]{24}$/.test(wbPiMediaState.current?.id||'');
(0,l.useEffect)(()=>{
  if(typeof window==='undefined'||typeof window.addEventListener!=='function')return;
  let disposed=false,timer=null,version=0;
  const status=reason=>{if(!disposed)try{window.dispatchEvent(new CustomEvent('workbuddy-pi:preview-status',{detail:{reason}}))}catch{}};
  const key=value=>{
    if(typeof value!=='string'||value.length>8192||value.includes('\0')||/^(https?:|data:|blob:|agent:)/i.test(value))return;
    try{const path=decodeFilePath(value);if(!path.startsWith('/'))return;
      return typeof navigator!=='undefined'&&/mac/i.test(navigator.platform||'')?path.normalize('NFD').toLowerCase():path;
    }catch{return;}
  };
  const sized=value=>Number.isSafeInteger(value)&&value>=0&&value<=1048576;
  const textSized=value=>typeof value==='string'&&value.length<=1048576&&new TextEncoder().encode(value).byteLength<=1048576;
  const bound=operation=>new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('preview-operation-timeout')),1500);
    Promise.resolve().then(operation).then(value=>{clearTimeout(timeout);resolve(value)},error=>{clearTimeout(timeout);reject(error)});
  });
  const guardReason=state=>{
    if(state?.local!==true)return 'nonlocal-skipped';
    if(!wbPiArtifact())return 'unknown-skipped';
    if(!/^(md|markdown)$/i.test(state.extension||''))return 'extension-skipped';
    if(typeof state.sessionId!=='string'||state.sessionId.length===0)return 'session-skipped';
    if(typeof state.content!=='string')return 'content-skipped';
    if(typeof state.read!=='function')return 'reader-skipped';
    if(typeof state.probe!=='function')return 'probe-skipped';
    if(!key(state.url))return 'url-skipped';
  };
  const changed=(event,nativeWatch=false)=>{
    status('event');
    const detail=event?.detail,state=wbPiMediaState.current;
    const reason=guardReason(state);if(reason){status(reason);return;}
    let files;
    if(!nativeWatch){
      if(!detail||!Array.isArray(detail.files)||detail.files.length>4096){status('unknown-skipped');return;}
      const pathKey=key(state.url);
      files=detail.files.filter(file=>file&&key(file.path)===pathKey);
      if(files.length===0)return;
    }
    status('matched');
    version++;
    if(timer!==null){clearTimeout(timer);timer=null;}
    if(files&&(files.length!==1||!sized(files[0].size))){status('size-skipped');return;}
    const ref=H.current,currentVersion=version,url=state.url,sessionId=state.sessionId,id=state.id,content=state.content,read=state.read,probe=state.probe,savedAt=W.current,pendingWrite=q.current;
    if(!ref||typeof ref.isDirty!=='function'||typeof ref.getContent!=='function'||typeof ref.updateContentIfClean!=='function'){
      status('ref-skipped');return;
    }
    const current=()=>{const latest=wbPiMediaState.current;return !disposed&&version===currentVersion&&H.current===ref&&!guardReason(latest)
      &&latest.url===url&&latest.sessionId===sessionId&&latest.id===id&&latest.content===content&&latest.read===read&&latest.probe===probe
      &&q.current===pendingWrite&&W.current===savedAt;};
    const stale=()=>{if(current())return false;status('stale-skipped');return true;};
    timer=setTimeout(()=>{timer=null;(async()=>{
      try{
        if(stale())return;
        const dirty=await bound(()=>ref.isDirty());if(stale())return;
        if(dirty!==false){status(dirty===true?'dirty-skipped':'unknown-skipped');return;}
        const expected=await bound(()=>ref.getContent());if(stale())return;
        if(!textSized(expected)){status(typeof expected==='string'?'size-skipped':'unknown-skipped');return;}
        const before=await bound(()=>oe(url,probe));if(stale())return;
        if(!sized(before)){status('size-skipped');return;}
        const next=await bound(()=>read(url,'text'));if(stale())return;
        if(!textSized(next)){status(typeof next==='string'?'size-skipped':'read-failed');return;}
        const after=await bound(()=>oe(url,probe));if(stale())return;
        if(!sized(after)){status('size-skipped');return;}
        if(before!==after){status('stale-skipped');return;}
        const actual=await bound(()=>ref.getContent());if(stale())return;
        if(actual!==expected){status('stale-skipped');return;}
        const finalDirty=await bound(()=>ref.isDirty());if(stale())return;
        if(finalDirty!==false){status(finalDirty===true?'dirty-skipped':'unknown-skipped');return;}
        if(next===pendingWrite){J.current=next;q.current=null;return;}
        if(Y(next)||pendingWrite!==null){status('stale-skipped');return;}
        if(next===expected){J.current=next;return;}
        // This ACK is produced after the native parser's final synchronous
        // clean/revision/content fence. There is no unguarded update fallback.
        const updated=await bound(()=>ref.updateContentIfClean(expected,next,Date.now()+1000));if(stale())return;
        if(updated!==true){status('stale-skipped');return;}
        J.current=next;q.current=null;status('reloaded');
      }catch{status('read-failed');}
    })();},80);
  };
  wbPiMediaReload.current=()=>changed(undefined,true);
  status('mounted');window.addEventListener('workbuddy-pi:files-changed',changed);
  return()=>{disposed=true;version++;wbPiMediaReload.current=null;if(timer!==null)clearTimeout(timer);window.removeEventListener('workbuddy-pi:files-changed',changed);};
},[]);
`;

// Parse into a separate *native* loader. It owns all temporary chunk state and
// cannot discard the visible editor's lazy loader on a rejected transaction.
const LOADER_METHOD = String.raw`
async loadIfClean(wbPiText,wbPiOptions,wbPiGuard,wbPiCommit){
  if(this.disposed||typeof wbPiGuard!=='function'||typeof wbPiCommit!=='function')return false;
  const wbPiGeneration=this.generation,wbPiEditor=this.editor,wbPiStage=new H(wbPiEditor);let wbPiDone=false;
  wbPiStage.applyLoad=(wbPiRecords,wbPiOnLoad)=>{
    if(this.disposed||this.generation!==wbPiGeneration||this.editor!==wbPiEditor||!wbPiGuard())return;
    // No await or message boundary exists between the guard and editor.load.
    wbPiEditor.load(wbPiRecords.records,wbPiRecords.rootId);
    const wbPiOldLoader=this.loader,wbPiOldUnsubscribe=this.unsubLoadMore;
    this.generation++;this.unsubLoadMore=null;
    for(const wbPiName of ['originalChunks','loadedChunkIndices','chunkToBlocks','blockToChunk','rootId','loader','onProgress'])this[wbPiName]=wbPiStage[wbPiName];
    wbPiStage.loader=null;wbPiDone=true;wbPiCommit();
    wbPiOldUnsubscribe?.();wbPiOldLoader?.dispose();wbPiOnLoad?.(wbPiRecords);
  };
  try{await wbPiStage.load(wbPiText,{...wbPiOptions,chunkMode:'full'});return wbPiDone;}finally{wbPiStage.dispose();}
}
`;

const SESSION_METHOD = String.raw`
updateContentIfClean(wbPiExpected,wbPiNext,wbPiDeadline){
  const wbPiSequence=this.wbPiConditionalSequence=(this.wbPiConditionalSequence??0)+1;
  const wbPiSized=value=>typeof value==='string'&&value.length<=1048576&&new TextEncoder().encode(value).byteLength<=1048576;
  if(!wbPiSized(wbPiExpected)||!wbPiSized(wbPiNext)||typeof this.adapter.loadIfClean!=='function'
    ||!Number.isSafeInteger(wbPiDeadline)||wbPiDeadline<=Date.now()||wbPiDeadline>Date.now()+2000)return Promise.resolve(false);
  const wbPiGeneration=this.generation,wbPiRevision=this.editRevision,wbPiContentVersion=this.wbPiContentVersion,wbPiSaveSequence=this.wbPiSaveSequence;
  const wbPiClean=()=>!this.disposed&&!this.closing&&!this.editor.isDestroyed&&!!this.editor.rootId
    &&this.generation===wbPiGeneration&&this.editRevision===wbPiRevision&&!this.isDirty()
    &&this.wbPiConditionalSequence===wbPiSequence&&this.wbPiContentVersion===wbPiContentVersion
    &&this.wbPiSaveSequence===wbPiSaveSequence&&Date.now()<=wbPiDeadline;
  return this.enqueue(async()=>{
    if(!wbPiClean())return false;
    const wbPiActual=await this.adapter.getValue();
    if(!wbPiClean()||wbPiActual!==wbPiExpected)return false;
    return this.adapter.loadIfClean(wbPiNext,()=>{if(!wbPiClean())return false;this.beforeLoad();return wbPiClean();},()=>{
      // This callback is synchronous with the native editor's final commit.
      this.generation++;this.editRevision=0;this.savedRevision=0;this.loadedContent=wbPiNext;this.lastWritten=void 0;this.cancelTimer();
      const wbPiFirst=!this.loadedOnce;this.loadedOnce=true;
      this.currentOptions.onContentLoaded?.({isFirstLoadForEditor:wbPiFirst});
    });
  });
}
`;

function replaceOne(source, anchor, replacement) {
  const start = source.indexOf(anchor);
  if (start < 0 || source.indexOf(anchor, start + 1) >= 0) throw Error('Native artifact preview anchor differs or is not unique');
  return source.slice(0, start) + replacement + source.slice(start + anchor.length);
}

/** Apply the same bounded replacements to exact native consumer slices. */
export function nativeArtifactPreviewSource(member, originalSource, edits) {
  let source = originalSource;
  const replace = (anchor, replacement) => {
    if (edits) {
      const index = originalSource.indexOf(anchor);
      if (index < 0 || originalSource.indexOf(anchor, index + 1) >= 0) throw Error('Native artifact preview original anchor differs');
      edits.push({ start: Buffer.byteLength(originalSource.slice(0, index)), end: Buffer.byteLength(originalSource.slice(0, index + anchor.length)),
        originalSHA256: sha256(anchor), replacementSHA256: sha256(replacement), replacementBytes: Buffer.byteLength(replacement) });
    }
    source = replaceOne(source, anchor, replacement);
  };
  if (member === NATIVE_ARTIFACT_PREVIEW_PINS[0].member) {
    // Native watch and updatedAt use the same performRead callback. Delegate
    // Pi artifacts before native read/update can bypass the conditional commit.
    replace('Q=(0,l.useRef)({});', 'Q=(0,l.useRef)({});' + MEDIA_OBSERVER);
    replace('performRead=async r=>{try{', 'performRead=async r=>{if(wbPiArtifact()){wbPiMediaReload.current?.();return}try{');
  } else if (member === NATIVE_ARTIFACT_PREVIEW_PINS[1].member) {
    replace('async requestSave(){', 'async requestUpdateContentIfClean(expected,content,deadline){let{requestId,promise}=this.tracker.createRequest(`updateContentIfClean`);return this.post({source:h,type:`updateContentIfClean`,requestId,expected,content,deadline}),promise}async requestSave(){');
    replace('updateContent:async e=>{A.current=e,u.updateContent(e)},', 'updateContent:async e=>{A.current=e,u.updateContent(e)},updateContentIfClean:async(expected,content,deadline)=>{const updated=await u.requestUpdateContentIfClean(expected,content,deadline);if(updated===true)A.current=content;return updated===true},');
  } else if (member === NATIVE_ARTIFACT_PREVIEW_PINS[2].member) {
    replace('onUpdateContent:async e=>{await n.current?.updateContent?.(e)},', 'onUpdateContent:async e=>{await n.current?.updateContent?.(e)},onUpdateContentIfClean:async(expected,content,deadline)=>typeof n.current?.updateContentIfClean===`function`?n.current.updateContentIfClean(expected,content,deadline):false,');
    replace('case`requestSave`:this.respond(', 'case`updateContentIfClean`:this.respond(e.requestId,()=>t.onUpdateContentIfClean(e.expected,e.content,e.deadline)).catch(noop);return;case`requestSave`:this.respond(');
  } else if (member === NATIVE_ARTIFACT_PREVIEW_PINS[3].member) {
    replace('createLoader(t,d){let f={sourceType:d.sourceType,', LOADER_METHOD + 'createLoader(t,d){let f={sourceType:d.sourceType,');
    const adapterAnchor = 'async getValue(){if(this.disposed)throw Error(`EditorLocalAdapter has been disposed`);';
    replace(adapterAnchor, String.raw`async loadIfClean(wbPiText,wbPiRoot,wbPiGuard,wbPiCommit){if(this.disposed)return false;return this.loadOrchestrator.loadIfClean(wbPiText,{sourceType:this.options.sourceType??'md',worker:{concurrency:this.options.worker?.concurrency??1,factory:this.options.worker?.factory,disable:this.options.worker?.disable??true},chunk:{firstChunkSize:this.options.chunk?.firstChunkSize??30720,chunkSize:this.options.chunk?.chunkSize??65536},chunkMode:'full',fullLoadThreshold:this.options.fullLoadThreshold??307200,rootId:wbPiRoot??this.options.rootId,enableAutoFallback:this.options.enableAutoFallback,registries:this.options.registries,onLoad:this.options.onLoad},()=>!this.disposed&&wbPiGuard(),()=>{this.autoExport?.reset();this.exportOrchestrator.resetCache();wbPiCommit();});}` + adapterAnchor);
    replace('getDiskBaseline(){return this.loadedContent}', SESSION_METHOD + 'getDiskBaseline(){return this.loadedContent}');
    replace('contentChanged(t,d){this.closing', 'contentChanged(t,d){if(d>0)this.wbPiContentVersion=(this.wbPiContentVersion??0)+1;this.closing');
    replace('save(t){let d=this.generation;', 'save(t){this.wbPiSaveSequence=(this.wbPiSaveSequence??0)+1;let d=this.generation;');
    replace('return p.load(A,f)},getValue:async()=>', 'return p.load(A,f)},loadIfClean:(wbPiText,wbPiGuard,wbPiCommit)=>{d.chunkSize=resolveMarkdownEditorChunkSize(wbPiText.length);let wbPiParsed=wbPiText.length>10240?windowLargeMarkdownTables(wbPiText):promoteLoosePipeTables(wbPiText);return p.loadIfClean(wbPiParsed,void 0,wbPiGuard,wbPiCommit)},getValue:async()=>');
    replace('updateContent:q,getContent:', 'updateContent:q,updateContentIfClean:(0,$.useCallback)(async(expected,next,deadline)=>P.current?.updateContentIfClean(expected,next,deadline)??false,[]),getContent:');
  } else if (member === NATIVE_ARTIFACT_PREVIEW_PINS[4].member) {
    replace('updateContent:he,getContent:ge,', 'updateContent:he,updateContentIfClean:wbPiAtomicUpdate,getContent:ge,');
    replace('getContent:ge,isDirty:_e,updateContent:he,', 'getContent:ge,isDirty:_e,updateContent:he,updateContentIfClean:wbPiAtomicUpdate,');
    replace('[ee.onSave,me,ge,_e,be,he,ve,xe,Se]', '[ee.onSave,me,ge,_e,be,he,wbPiAtomicUpdate,ve,xe,Se]');
  } else throw Error('Native artifact preview member is not allowed');
  return source;
}

export function patchNativeArtifactPreviewBytes(member, original) {
  const pin = NATIVE_ARTIFACT_PREVIEW_PINS.find(value => value.member === member);
  if (!pin || !Buffer.isBuffer(original) || original.length !== pin.originalBytes || sha256(original) !== pin.originalSHA256) {
    throw Error('Native artifact preview source is not the pinned original WorkBuddy 5.11.1 member (or is already patched)');
  }
  const edits = [];
  const bytes = Buffer.from(nativeArtifactPreviewSource(member, original.toString('utf8'), edits));
  const patchedSHA256 = sha256(bytes);
  if (patchedSHA256 !== pin.patchedSHA256) throw Error('Native artifact preview patched digest differs');
  return { member, bytes, metadata: {
    id: 'pi-media-md-atomic-file-change-v1', member, originalSHA256: pin.originalSHA256, patchedSHA256,
    originalBytes: original.length, patchedBytes: bytes.length, event: NATIVE_ARTIFACT_PREVIEW_EVENT,
    edits: edits.sort((a, b) => a.start - b.start),
    statusEvent: NATIVE_ARTIFACT_PREVIEW_STATUS_EVENT, maxTextBytes: 1048576,
    diagnosticReasons: NATIVE_ARTIFACT_PREVIEW_REASONS,
    nativeAtomicCompareAndLoad: true, nonatomicFallback: false, readsEventPaths: false,
    preservesOriginalUpdateContent: true, preservesGuestSourceAndOriginValidation: true,
    sourceOrUnknownEditingStateSkipped: true, knownEventSizeAndNativeProbeRequired: true, nativeWatchRequiresProbe: true,
    nativeWatchUsesAtomicCommitForPiArtifacts: true,
    readAllocationHardBound: false, sizeLimitKind: 'event-and-pre-post-native-probe-and-returned-utf8-content',
    guardAt: 'native-loader-final-synchronous-editor-load', stagedNativeFullParser: true,
    dependencies: [{ member: PROTOCOL_MEMBER, sha256: PROTOCOL_SHA256 }, { member: CONTEXT_MEMBER, sha256: CONTEXT_SHA256 }, { member: ROUTE_MEMBER, sha256: ROUTE_SHA256 }],
  } };
}

export function applyNativeArtifactPreviewPatch(archive) {
  for (const [member, digest] of [[PROTOCOL_MEMBER, PROTOCOL_SHA256], [CONTEXT_MEMBER, CONTEXT_SHA256], [ROUTE_MEMBER, ROUTE_SHA256]]) {
    const bytes = archive.read(member);
    if (!Buffer.isBuffer(bytes) || sha256(bytes) !== digest) throw Error('Native artifact preview dependency differs: ' + member);
  }
  return { patches: NATIVE_ARTIFACT_PREVIEW_PINS.map(pin => patchNativeArtifactPreviewBytes(pin.member, archive.read(pin.member))) };
}
