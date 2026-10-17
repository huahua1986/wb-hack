// This runs only in the acceptance harness, before the original app entry resumes.
// It is not copied into client packages and never disables Chromium's sandbox.
function installOfflineFaults({ configPath, preload, appAsarPath }) {
  process.env.WB_OFFLINE_TEST_CONFIG = configPath;
  const require = process.getBuiltinModule('module').createRequire(`${appAsarPath}/package.json`);
  const state = require(preload).install(configPath);
  const electron = require('electron'), configured = new WeakSet();
  function matchesFilter(url, filter) {
    if (!filter?.urls) return true;
    const candidate = new URL(url);
    return filter.urls.some(pattern => {
      if (pattern === '<all_urls>') return true;
      const parts = /^(\*|[a-z]+):\/\/([^/]*)(\/.*)$/.exec(pattern);
      if (!parts) return true; // Preserve an application's own guard on unfamiliar patterns.
      if (parts[1] !== '*' && candidate.protocol !== parts[1] + ':') return false;
      const host = parts[2].toLowerCase();
      if (host !== '*' && !(host.startsWith('*.')
        ? candidate.hostname === host.slice(2) || candidate.hostname.endsWith(host.slice(1))
        : candidate.host === host || candidate.hostname === host)) return false;
      const expression = '^' + parts[3].split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
      return new RegExp(expression).test(candidate.pathname + candidate.search);
    });
  }
  const wire = session => {
    if (configured.has(session)) return;
    configured.add(session);
    const request = session.webRequest, register = request.onBeforeRequest.bind(request);
    let applicationListener, applicationFilter;
    const guarded = (details, callback) => {
      let url;
      try { url = new URL(details.url); } catch { return callback({}); }
      if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
        && !state.allowHost(url.hostname, url.port || (['https:', 'wss:'].includes(url.protocol) ? 443 : 80))) {
        state.log({ event: 'blocked-chromium' }); return callback({ cancel: true });
      }
      return applicationListener && matchesFilter(details.url, applicationFilter)
        ? applicationListener(details, callback) : callback({});
    };
    const allHttp = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };
    request.onBeforeRequest = (filter, listener) => {
      applicationFilter = typeof filter === 'function' ? undefined : filter;
      applicationListener = typeof filter === 'function' ? filter : listener;
      register(allHttp, guarded);
    };
    register(allHttp, guarded);
  };
  electron.app.on('session-created', wire);
  electron.app.on('web-contents-created', (_event, contents) => wire(contents.session));
  electron.app.whenReady().then(() => wire(electron.session.defaultSession));
  const fork = electron.utilityProcess?.fork;
  if (fork) electron.utilityProcess.fork = function(modulePath, args, options = {}) {
    return fork.call(this, modulePath, args, { ...options,
      env: { ...(options.env || process.env), WB_OFFLINE_TEST_CONFIG: configPath },
      execArgv: ['--require', preload, ...(options.execArgv || [])] });
  };
  return true;
}
export function offlineFaultScript(options) {
  return `(${installOfflineFaults.toString()})(${JSON.stringify(options)})`;
}
