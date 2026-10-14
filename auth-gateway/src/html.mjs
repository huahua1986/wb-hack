function escape(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

const style = `
*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#182433;font:15px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{min-height:100svh;display:grid;place-items:center;padding:32px 20px}.card{width:min(100%,420px);background:white;border:1px solid #dce3eb;border-radius:16px;padding:32px;box-shadow:0 12px 36px #152c4a0a}
.brand{font-size:12px;letter-spacing:.12em;color:#547086;font-weight:650}.mark{display:inline-grid;place-items:center;background:#183f61;color:white;width:32px;height:32px;border-radius:9px;margin-right:10px;letter-spacing:0}
h1{font-size:26px;line-height:1.3;margin:22px 0 10px}p{color:#5d6c7c;margin:0 0 24px}label{display:block;font-size:14px;font-weight:600;margin:18px 0 7px}input{width:100%;border:1px solid #b9c6d3;border-radius:8px;padding:12px;font:inherit;background:#fff;color:inherit}
input:focus{outline:3px solid #bdddf6;border-color:#235f90}button{width:100%;padding:12px;background:#184b74;border:0;border-radius:8px;color:white;font:600 15px system-ui;margin-top:24px;cursor:pointer}button:hover{background:#123b5d}button:focus-visible{outline:3px solid #76b6e7;outline-offset:3px}
.error{background:#fff0f0;color:#a02727;border:1px solid #f1c9c9;border-radius:8px;padding:10px 12px;margin:16px 0}.hint{font-size:13px;margin:18px 0 0}.success{font-size:40px;color:#1a7955;margin-bottom:12px}@media(max-width:450px){.card{padding:25px}}
`;

function page(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><link rel="stylesheet" href="/login/style.css"></head><body><main><section class="card"><div class="brand"><span class="mark" aria-hidden="true">W</span>WORKBUDDY 本地登录</div>${body}</section></main></body></html>`;
}

export const loginCss = style;
export function loginPage(state, csrf, error = '') {
  return page('登录 WorkBuddy', `<h1>登录 WorkBuddy</h1><p>使用管理员为你创建的账号。完成后返回桌面客户端继续工作。</p>${error ? `<div class="error" role="alert">${escape(error)}</div>` : ''}<form method="post" action="/login"><input type="hidden" name="state" value="${escape(state)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><label for="username">账号</label><input id="username" name="username" autocomplete="username" maxlength="64" required autofocus><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required><button type="submit">登录并返回客户端</button></form><p class="hint">此登录链接有效期为 5 分钟。</p>`);
}

export function completePage() {
  return page('登录完成', '<h1>登录完成</h1><div class="success" aria-hidden="true">✓</div><p>返回 WorkBuddy，客户端会自动完成登录。之后可以在模型设置中配置并选择你的自定义模型。</p>');
}

export function expiredPage() {
  return page('登录链接已失效', '<h1>登录链接已失效</h1><p>请返回 WorkBuddy，重新发起登录。</p>');
}
