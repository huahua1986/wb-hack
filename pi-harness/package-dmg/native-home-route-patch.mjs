import { createHash } from 'node:crypto';

export const NATIVE_HOME_ROUTE_PIN = Object.freeze({
  member: 'renderer/assets/home-creation-preview-visibility-DflqWg3c.js',
  originalSHA256: '89012bf6fac7f709ee6875a8e98b3859c99a72387cd9ff43eca73fa1cf717e8b',
  patchedSHA256: '954b7bb93ad4e39b5e5cf5c97a4f5eef2ea978ff753a1eebb9f1f68b033fcf62',
});

const ROUTE_HELPERS = `
function getPiHomeConversations(wb){
  return globalThis.__workbuddyPi?.homeConversations?.(wb);
}
function requirePiHomeConversations(wb){
  const conversations=getPiHomeConversations(wb);
  if(!conversations)throw Error('Pi 执行引擎尚未就绪，请稍后重试。');
  return conversations;
}
async function waitForPiHomeConversations(wb){
  const deadline=Date.now()+10000;
  while(!getPiHomeConversations(wb)&&globalThis.__workbuddyPi?.status!=='failed'&&Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  requirePiHomeConversations(wb);
}
`;

function replaceOnce(source, before, after) {
  const start = source.indexOf(before);
  if (start < 0 || source.indexOf(before, start + before.length) >= 0) throw Error('Unrecognized or ambiguous WorkBuddy home route');
  return source.slice(0, start) + after + source.slice(start + before.length);
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function applyNativeHomeRoutePatch(archive) {
  const pin = NATIVE_HOME_ROUTE_PIN, original = archive.read(pin.member);
  if (hash(original) !== pin.originalSHA256) throw Error('WorkBuddy home route source differs from its audited pin');
  let source = original.toString('utf8');
  source = replaceOnce(source, 'function useCreateHomeTask(', ROUTE_HELPERS + 'function useCreateHomeTask(');
  source = replaceOnce(source, 'try{if(!y&&l.current)return await l.current.resume();',
    'try{if(!y)await waitForPiHomeConversations(n.wb);if(!y&&l.current)return await l.current.resume();');
  source = replaceOnce(source, 'if(!isHomeTaskPrewarmEnabled()||s.current||!claimHomeTaskPrewarm())',
    'if(!getPiHomeConversations(n.wb)||!isHomeTaskPrewarmEnabled()||s.current||!claimHomeTaskPrewarm())');
  source = replaceOnce(source, 'let e=await n.wb.conversations.create({...R,title:A||void 0,tags:{...R.tags??{},...Ci}})',
    'let e=await requirePiHomeConversations(n.wb).create({...R,title:A||void 0,tags:{...R.tags??{},...Ci}})');
  source = replaceOnce(source, 'let V=B.reuse?B.reuse.created:await n.wb.conversations.create(R);',
    'const wbPiConversations=requirePiHomeConversations(n.wb);if(B.reuse&&!globalThis.__workbuddyPi.conversationIds.includes(B.reuse.conversationId))B.reuse=void 0;let V=B.reuse?B.reuse.created:await wbPiConversations.create(R);');
  const bytes = Buffer.from(source);
  if (hash(bytes) !== pin.patchedSHA256) throw Error('WorkBuddy home route patch differs from its audited pin: ' + hash(bytes));
  return { member: pin.member, bytes, metadata: { ...pin, originalBytes: original.length, id: 'pi-home-task-route' } };
}
