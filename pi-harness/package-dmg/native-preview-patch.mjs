import { createHash } from 'node:crypto';

export const NATIVE_PREVIEW_MEMBER = 'renderer/assets/src-Di9nYFZF.js';
export const NATIVE_PREVIEW_ORIGINAL_SHA256 = 'eaaffbb0b914f4c3c5755dfc5b61ecaaa91fd26eeeee4d4bfc857e10ecf0db44';
export const NATIVE_PREVIEW_PATCHED_SHA256 = "00d386487d163abbfd370831f74132967d3b22330fd8bd0198b59a3eb65a26d1";
export const NATIVE_PREVIEW_EVENT = 'workbuddy-pi:files-changed';
const ORIGINAL_BYTES = 542036;
const FUNCTION_START = 350491;
const FUNCTION_END = 352043;
const ORIGINAL_FUNCTION_SHA256 = 'f299b18dc609ef0f3917d8884d4000c2a457a0263bd91dbc72a202f3c2010027';
const ORIGINAL_FUNCTION = "function useLoadFileContent(i){let{onReadFile:o,readFileWithFormat:s,sessionId:h,directLocalMediaUrl:_,probeLocalFileSize:j}=i,{setTabLoading:$,updateTabContent:_e,updateTabFile:ve,setTabOversized:ye}=useTabsContext(),Ee=(0,ar.useRef)(null),De=(0,ar.useRef)(0);return(0,ar.useEffect)(()=>{De.current+=1,Ee.current=null},[h]),{loadFileContent:(0,ar.useCallback)(async i=>{Ee.current=i,$(i);let h=De.current,isStale=()=>De.current!==h||Ee.current!==i,{contentType:Fe,extension:Ie,mimeContentType:Le}=Ln(i),ze=Jn(Fe,Ie);try{let h=await resolveLocalPreviewOversize({filePath:i,extension:Ie,contentType:Fe,probe:j});if(isStale())return;if(h){ye(i,h);return}if(_&&(Fe===`video`||Fe===`audio`)&&Vn(i)){isStale()||_e(i,Gn(i),`loaded`);return}if(ze===`text`){let h;if(s)h=await s(i,`text`);else if(o)h=await o(i);else return;isStale()||_e(i,h,`loaded`);return}if(!s){if(o){let s=await o(i);isStale()||_e(i,s,`loaded`)}return}let $=await s(i,`blob`);if(isStale())return;let Ee=$,De=null;if(Ee instanceof Blob?De=Ee:Ee instanceof Uint8Array?De=new Blob([Ee],{type:Le}):Ee instanceof ArrayBuffer&&(De=new Blob([new Uint8Array(Ee)],{type:Le})),!De){ve(i,null,`error`);return}let He=Qt(i,`file`),Ge=new File([De],He,{type:Le}),Ke=await Un(Ge,Fe);if(isStale())return;if(Ke?.actualType===`code`&&Ke.actualExtension){let o=await Ge.text();isStale()||_e(i,o,`loaded`,Ke.actualExtension)}else ve(i,Ge,`loaded`)}catch(o){console.error(`[useLoadFileContent] Failed to read file:`,i,o),isStale()||(ze===`text`?_e(i,null,`error`):ve(i,null,`error`))}},[_,o,s,j,$,ye,_e,ve])}}";
const READONLY_START = 394324;
const READONLY_END = 396066;
const READONLY_FUNCTION_SHA256 = '7e2486106e967c5be836753966fe30088e2251d73c0b3c9bb06cc229654d7a2e';
const sha256 = value => createHash('sha256').update(value).digest('hex');
function replaceOne(source, anchor, replacement) {
  const at = source.indexOf(anchor);
  if (at < 0 || source.indexOf(anchor, at + 1) !== -1) throw Error('Native preview function anchor differs');
  return source.slice(0, at) + replacement + source.slice(at + anchor.length);
}

// The only eligible route is the native FileViewer rendered Markdown branch,
// whose fallback and isolated guest both hard-code readOnly:true. No dirty flag
// is guessed: source mode, other formats and unknown states never enter it.
const OBSERVER = String.raw`
const wbPiPreviewState=(0,ar.useRef)(null);
wbPiPreviewState.current={tabs:wbPiNativeTabs.tabs,activeId:wbPiNativeTabs.activeTabId,sessionId:h,load:wbPiNativeLoad};
(0,ar.useEffect)(()=>{
  if(typeof window==='undefined'||typeof window.addEventListener!=='function')return;
  let disposed=false,timer=null,revision=0;
  const key=value=>{
    if(typeof value!=='string'||value.length>8192||value.includes('\0'))return;
    try{
      const path=filePathFromMaybeFileUrl(value);
      if(typeof path!=='string'||!path.startsWith('/'))return;
      return typeof navigator!=='undefined'&&/mac/i.test(navigator.platform||'')?path.normalize('NFD').toLowerCase():path;
    }catch{return;}
  };
  const readonly=tab=>Boolean(tab&&typeof tab.id==='string'&&tab.viewMode==='rendered'
    &&typeof tab.fileName==='string'&&tab.fileName.toLowerCase().endsWith('.md')
    &&typeof tab.filePath==='string'&&key(tab.filePath)?.endsWith('.md')
    &&typeof tab.content==='string'&&tab.content.length>0
    &&(tab.loadingState==='loaded'||tab.loadingState==='loading')
    &&tab.file==null&&tab.oversized==null);
  const active=state=>Array.isArray(state?.tabs)?state.tabs.find(tab=>tab.id===state.activeId):undefined;
  const changed=event=>{
    const detail=event?.detail,state=wbPiPreviewState.current,tab=active(state);
    if(!detail||!readonly(tab))return;
    const pathKey=key(tab.filePath);
    if(detail.invalidateAll!==true&&(!Array.isArray(detail.paths)||detail.paths.length>4096
      ||!detail.paths.some(path=>key(path)===pathKey)))return;
    const currentRevision=++revision,sessionId=state.sessionId,id=tab.id,path=tab.filePath,content=tab.content;
    if(timer!==null)clearTimeout(timer);
    timer=setTimeout(()=>{
      timer=null;
      const current=()=>{
        const state=wbPiPreviewState.current,tab=active(state);
        return !disposed&&revision===currentRevision&&state?.sessionId===sessionId
          &&state.activeId===id&&readonly(tab)&&tab.filePath===path&&tab.content===content;
      };
      if(!current())return;
      // Only the already-open tab's path is read. Event paths select a known
      // tab; they never become filesystem arguments. The native loader keeps
      // size probing, text/blob dispatch, stale requests and error handling.
      Promise.resolve(wbPiPreviewState.current.load(path,current)).catch(error=>{
        if(!disposed)console.warn('[WorkBuddy Pi preview] native reload failed',error);
      });
    },80);
  };
  window.addEventListener('workbuddy-pi:files-changed',changed);
  return()=>{disposed=true;revision++;if(timer!==null)clearTimeout(timer);window.removeEventListener('workbuddy-pi:files-changed',changed);};
},[]);
return{loadFileContent:wbPiNativeLoad};
`;

/** Build one pinned native function, also exposed for bounded consumer replay. */
export function nativePreviewFunctionSource() {
  if (sha256(Buffer.from(ORIGINAL_FUNCTION)) !== ORIGINAL_FUNCTION_SHA256) throw Error('Native preview function pin differs');
  let source = replaceOne(ORIGINAL_FUNCTION, 'function useLoadFileContent(i){let', 'function useLoadFileContent(i){const wbPiNativeTabs=useTabsContext();let');
  source = replaceOne(source, '}=useTabsContext(),Ee=', '}=wbPiNativeTabs,Ee=');
  source = replaceOne(source,
    'return(0,ar.useEffect)(()=>{De.current+=1,Ee.current=null},[h]),{loadFileContent:',
    '(0,ar.useEffect)(()=>{De.current+=1,Ee.current=null},[h]);const wbPiNativeLoad=');
  source = replaceOne(source,
    'async i=>{Ee.current=i,$(i);let h=De.current,isStale=()=>De.current!==h||Ee.current!==i,',
    'async(i,wbPiGuard)=>{if(typeof wbPiGuard===\'function\'&&!wbPiGuard())return;Ee.current=i,$(i);let h=De.current,isStale=()=>De.current!==h||Ee.current!==i||(typeof wbPiGuard===\'function\'&&!wbPiGuard()),');
  source = replaceOne(source, '},[_,o,s,j,$,ye,_e,ve])}}', '},[_,o,s,j,$,ye,_e,ve]);' + OBSERVER + '}');
  return source;
}

/** Only the exact 5.11.1 member is accepted; already-patched/drifted input fails. */
export function patchNativePreviewBytes(original) {
  if (!Buffer.isBuffer(original) || original.length !== ORIGINAL_BYTES || sha256(original) !== NATIVE_PREVIEW_ORIGINAL_SHA256) {
    throw Error('Native preview source is not the pinned original WorkBuddy 5.11.1 member (or is already patched)');
  }
  if (sha256(original.subarray(READONLY_START, READONLY_END)) !== READONLY_FUNCTION_SHA256) throw Error('Native readonly Markdown consumer differs');
  const anchor = Buffer.from(ORIGINAL_FUNCTION);
  if (original.indexOf(anchor) !== FUNCTION_START || original.indexOf(anchor, FUNCTION_START + 1) !== -1
    || FUNCTION_END - FUNCTION_START !== anchor.length) throw Error('Native preview replacement must have exactly one pinned function anchor');
  const replacement = Buffer.from(nativePreviewFunctionSource());
  const bytes = Buffer.concat([original.subarray(0, FUNCTION_START), replacement, original.subarray(FUNCTION_END)]);
  const patchedSHA256 = sha256(bytes);
  if (patchedSHA256 !== NATIVE_PREVIEW_PATCHED_SHA256) throw Error('Native preview patched digest differs');
  return { bytes, metadata: {
    id: 'pi-readonly-md-file-change-v1', member: NATIVE_PREVIEW_MEMBER, originalSHA256: NATIVE_PREVIEW_ORIGINAL_SHA256,
    patchedSHA256, originalBytes: original.length, patchedBytes: bytes.length,
    originalFunction: { start: FUNCTION_START, end: FUNCTION_END, sha256: ORIGINAL_FUNCTION_SHA256 },
    patchedFunction: { start: FUNCTION_START, end: FUNCTION_START + replacement.length, sha256: sha256(replacement) },
    event: NATIVE_PREVIEW_EVENT, supported: 'active-native-file-viewer-rendered-md-readonly-only',
    readsEventPaths: false, preservesNativeOversizeAndErrorFlow: true, sourceOrUnknownEditingStateSkipped: true,
    readonlyDependency: { member: NATIVE_PREVIEW_MEMBER, sha256: NATIVE_PREVIEW_ORIGINAL_SHA256, start: READONLY_START, end: READONLY_END, functionSHA256: READONLY_FUNCTION_SHA256 },
  } };
}

export function applyNativePreviewPatch(archive) {
  return { member: NATIVE_PREVIEW_MEMBER, ...patchNativePreviewBytes(archive.read(NATIVE_PREVIEW_MEMBER)) };
}

