import { createHash } from 'node:crypto';

// The original auth guest blocks later form navigations. Submit within the same document.
const submitScript = `document.addEventListener('submit', async event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const data = new FormData(form);
  if (event.submitter?.name) data.set(event.submitter.name, event.submitter.value);
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(button => button.disabled = true);
  try {
    const response = await fetch(form.getAttribute('action'), { method: 'POST', credentials: 'same-origin', redirect: 'error', body: new URLSearchParams(data) });
    const text = await response.text();
    if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('授权请求失败，请返回 WorkBuddy 重新连接');
    const page = new DOMParser().parseFromString(text, 'text/html');
    document.title = page.title;
    document.body.replaceChildren(...page.body.childNodes);
  } catch {
    let alert = document.getElementById('authorization-error');
    if (!alert) { alert = document.createElement('p'); alert.id = 'authorization-error'; alert.setAttribute('role', 'alert'); form.append(alert); }
    alert.textContent = '授权请求失败，请返回 WorkBuddy 重新连接';
  } finally { buttons.forEach(button => button.disabled = false); }
});`;
export const lexiangScriptCsp = "'sha256-" + createHash('sha256').update(submitScript).digest('base64') + "'";

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const wrap = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="stylesheet" href="/login/style.css"></head><body><main><section class="card"><div class="brand">乐享独立账号授权</div>${body}</section></main><script>${submitScript}</script></body></html>`;
export function lexiangLoginPage({ state, csrf, workbuddyName, error = '' }) {
  return wrap('登录乐享', `<h1>登录乐享</h1><p>WorkBuddy 已登录为 <strong>${escape(workbuddyName)}</strong>。请使用独立的乐享账号登录，两个系统的密码分别管理。</p>${error ? `<div class="error" role="alert">${escape(error)}</div>` : ''}<form method="post" action="/private/lexiang/authorize?state=${escape(state)}&amp;step=login"><input type="hidden" name="state" value="${escape(state)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="action" value="login"><label for="username">乐享账号</label><input id="username" name="username" autocomplete="username" maxlength="64" required autofocus><label for="password">乐享密码</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required><button type="submit">登录乐享</button></form><p class="hint">此页面不会创建或修改 WorkBuddy 的登录会话。</p>`);
}
export function lexiangConsentPage({ state, csrf, workbuddyName, memberName }) {
  return wrap('授权绑定乐享', `<h1>授权绑定乐享</h1><p>乐享账号：<strong>${escape(memberName)}</strong><br>WorkBuddy 账号：<strong>${escape(workbuddyName)}</strong></p><p>允许该 WorkBuddy 账号以此乐享身份访问有权限的知识库、搜索和预览文档。授权会保存，重启后无需重复登录；可在乐享菜单中解除绑定。</p><form method="post" action="/private/lexiang/authorize?state=${escape(state)}&amp;step=consent"><input type="hidden" name="state" value="${escape(state)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><button name="action" value="approve" type="submit">确认授权绑定</button><button name="action" value="deny" type="submit">取消授权</button></form>`);
}
export const lexiangAuthorizationComplete = () => wrap('乐享授权完成', '<h1>乐享授权完成</h1><div class="success">✓</div><p>请返回 WorkBuddy，客户端将自动加载独立账号有权限的知识库。</p>');
export const lexiangAuthorizationExpired = () => wrap('乐享授权已失效', '<h1>乐享授权已失效</h1><p>请返回 WorkBuddy，在乐享知识库中重新发起连接。无需退出 WorkBuddy。</p>');
