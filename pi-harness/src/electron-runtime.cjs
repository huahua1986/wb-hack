const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');

exports.install = function install(options) {
  const electron = createRequire(options.appAsarPath + '/package.json')('electron');
  if (electron.app.getAppPath() !== options.appAsarPath) throw Error('Unexpected Pi host application');
  const key = Symbol.for('private.workbuddy.pi-host');
  if (globalThis[key]) throw Error('Pi host is already installed');
  const state = { installed: true, pending: true }; globalThis[key] = state;
  import(pathToFileURL(path.join(__dirname, 'electron-host.mjs')).href).then(module => {
    state.host = module.createPiElectronHost({ ...options, electron }); state.pending = false;
  }).catch(() => {
    state.failed = true; state.pending = false;
    try { const config = JSON.parse(fs.readFileSync(options.configFile)); fs.writeFileSync(path.join(config.stateDir, 'bridge-status.json'), JSON.stringify({ phase: 'failed', error: 'Pi runtime could not initialize', at: new Date().toISOString() }), { mode: 0o600 }); } catch {}
  });
  return { installed: true };
};
