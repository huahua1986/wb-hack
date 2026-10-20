import { LEXIANG_PUBLIC_HOSTS, rewriteLexiangUrl, normalizeLexiangClient } from './lexiang-config.mjs';

export function installLexiangRouting({ appAsarPath, webOrigin, publicHosts }, rewrite) {
  const require = process.getBuiltinModule('module').createRequire(`${appAsarPath}/package.json`);
  const { app, shell, webContents } = require('electron');
  if (app.getAppPath() !== appAsarPath) throw new Error('Unexpected application');
  const key = Symbol.for('private.workbuddy.lexiang');
  globalThis[key]?.dispose?.();
  const tracked = new Map();
  let redirected = 0;
  const route = value => { const next = rewrite(value, webOrigin, publicHosts); if (next !== value) redirected++; return next; };
  const originalOpen = shell.openExternal;
  const open = function (url, ...args) { return originalOpen.call(this, route(url), ...args); };
  shell.openExternal = open;
  const attach = contents => {
    if (tracked.has(contents.id)) return;
    const originalLoad = contents.loadURL;
    const load = function (url, ...args) {
      const target = route(url);
      if (target === url) return originalLoad.call(this, url, ...args);
      // The old site's POST body, custom headers and referrer can contain credentials.
      // Re-authenticate at the private destination through the gateway instead.
      const options = args[0], safe = {};
      if (typeof options?.userAgent === 'string') safe.userAgent = options.userAgent;
      return originalLoad.call(this, target, safe);
    };
    contents.loadURL = load;
    const navigate = (event, value) => {
      const url = typeof value === 'string' ? value : value?.url;
      const target = route(url);
      if (target === url) return;
      event.preventDefault();
      void contents.loadURL(target).catch(() => console.warn('[private-lexiang] navigation failed'));
    };
    const destroy = () => tracked.delete(contents.id);
    contents.on('will-navigate', navigate);
    contents.on('will-redirect', navigate);
    contents.once('destroyed', destroy);
    tracked.set(contents.id, { contents, originalLoad, load, navigate, destroy });
  };
  const created = (_event, contents) => attach(contents);
  app.on('web-contents-created', created);
  webContents.getAllWebContents().forEach(attach);
  globalThis[key] = {
    snapshot: () => ({ installed: true, webOrigin, redirected }),
    dispose: () => {
      app.removeListener('web-contents-created', created);
      if (shell.openExternal === open) shell.openExternal = originalOpen;
      for (const { contents, originalLoad, load, navigate, destroy } of tracked.values()) {
        if (contents.isDestroyed()) continue;
        if (contents.loadURL === load) contents.loadURL = originalLoad;
        contents.removeListener('will-navigate', navigate);
        contents.removeListener('will-redirect', navigate);
        contents.removeListener('destroyed', destroy);
      }
      tracked.clear(); delete globalThis[key];
    },
  };
  return { installed: true, webOrigin };
}

export function lexiangRoutingScript(appAsarPath, value) {
  const config = normalizeLexiangClient(value);
  if (!config?.enabled) return '';
  // Embed the exact same rewriting function without external module dependencies.
  const rewrite = rewriteLexiangUrl.toString().replace('function rewriteLexiangUrl(value, webOrigin)', 'function rewriteLexiangUrl(value, webOrigin, LEXIANG_PUBLIC_HOSTS)');
  return `(${installLexiangRouting.toString()})(${JSON.stringify({ appAsarPath, webOrigin: config.webOrigin, publicHosts: LEXIANG_PUBLIC_HOSTS })}, ${rewrite})`;
}
