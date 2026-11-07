import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PiHarness } from './pi-harness.mjs';
import { PiHostRuntime } from './host-runtime.mjs';
import { readPiConfig } from './config.mjs';
import { WorkBuddyCdpController } from './electron-controller.mjs';
import { buildRendererSource, readWorkBuddyRendererIdentity, SUPPORTED_WORKBUDDY_VERSIONS } from './renderer/source.js';
import { NativeBridgeClient } from './native-bridge.mjs';

export class ElectronDebuggerClient {
  constructor(contents) {
    this.contents = contents; this.events = new EventEmitter(); this.isClosed = false;
    this.onMessage = (_event, method, params) => this.events.emit(method, params);
    this.onDetach = () => { this.isClosed = true; this.events.emit('close'); };
    if (contents.debugger.isAttached()) throw Error('WorkBuddy renderer debugger is already in use');
    contents.debugger.attach('1.3');
    contents.debugger.on('message', this.onMessage); contents.debugger.on('detach', this.onDetach);
  }
  on(name, fn) { this.events.on(name, fn); return () => this.events.off(name, fn); }
  request(method, params = {}, { timeoutMs = 15000 } = {}) {
    if (this.isClosed || this.contents.isDestroyed()) return Promise.reject(Error('WorkBuddy renderer is closed'));
    let timer;
    return Promise.race([this.contents.debugger.sendCommand(method, params), new Promise((_r, reject) => { timer = setTimeout(() => reject(Error('Renderer protocol timeout')), timeoutMs); timer.unref?.(); })]).finally(() => clearTimeout(timer));
  }
  close() { if (!this.isClosed && !this.contents.isDestroyed()) this.contents.debugger.detach(); this.contents.debugger.removeListener('message', this.onMessage); this.contents.debugger.removeListener('detach', this.onDetach); this.isClosed = true; this.events.removeAllListeners(); }
}

export function createPiElectronHost({ electron, appAsarPath, configFile, exclusive = false, nativeUi = false }) {
  const config = readPiConfig(configFile), lockFile = path.join(config.stateDir, 'host.lock');
  const lockId = randomBytes(16).toString('hex');
  if (fs.existsSync(lockFile)) {
    const old = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (old.kind !== 'workbuddy-pi-host' || !Number.isInteger(old.pid)) throw Error('Invalid Pi Host lock');
    let alive = true; try { process.kill(old.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw Error('Pi Host state is already in use');
    fs.unlinkSync(lockFile);
  }
  fs.writeFileSync(lockFile, JSON.stringify({ kind: 'workbuddy-pi-host', pid: process.pid, nonce: lockId }), { mode: 0o600, flag: 'wx' });
  const release = () => { try { if (JSON.parse(fs.readFileSync(lockFile)).nonce === lockId) fs.unlinkSync(lockFile); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
  let adapter, runtime;
  try { adapter = new PiHarness({ ...config, ...(nativeUi && config.officialOnly
    ? { nativeServices: new NativeBridgeClient(config.officialBridgeDir), expertConfigDir: process.env.WORKBUDDY_CONFIG_DIR } : {}) }); runtime = new PiHostRuntime(adapter, config); }
  catch (e) { release(); throw e; }
  const controllers = new Map(), pending = new Set(), loginMonitors = new Set(); let disposed = false;
  const statusFile = path.join(config.stateDir, 'bridge-status.json');
  const status = (phase, extra = {}) => fs.writeFileSync(statusFile, JSON.stringify({ phase, pid: process.pid, at: new Date().toISOString(), ...extra }), { mode: 0o600 });
  const eligible = contents => {
    try {
      const url = new URL(contents.getURL());
      // WorkBuddy 5.11.1 loads independent windows from the same HTML entry.
      const windowApp = url.searchParams.get('windowAppId') ?? url.searchParams.get('windowKind') ?? 'main';
      return url.protocol === 'file:' && !url.host && windowApp === 'main'
        && decodeURIComponent(url.pathname) === appAsarPath + '/renderer/index.html';
    } catch { return false; }
  };
  async function attach(contents) {
    if (disposed || contents.isDestroyed() || !eligible(contents) || controllers.has(contents.id) || pending.has(contents.id)) return;
    pending.add(contents.id); let client, controller;
    try {
      const identity = await contents.executeJavaScript(`(${readWorkBuddyRendererIdentity})()`);
      if ((identity.name && identity.name !== 'workbuddy') || (identity.desktop && identity.desktop !== 'true') || (identity.version && !SUPPORTED_WORKBUDDY_VERSIONS.includes(identity.version))) throw Error('Unsupported Pi renderer identity');
      const nonce = randomBytes(8).toString('hex'), bindingName = '__workbuddyPi_' + nonce;
      client = new ElectronDebuggerClient(contents);
      controller = new WorkBuddyCdpController(client, { bindingName, globalName: '__workbuddyPi', rendererSource: buildRendererSource({ bindingName, globalName: '__workbuddyPi', rootId: 'workbuddy-pi-controls', version: 'pi-0.4.2', requiredAppVersion: identity.version, exclusive, nativeUi, officialModels: config.officialOnly === true }),
        requestHandler: ({ method, params }) => { if (!eligible(contents)) throw Error('Untrusted Pi renderer'); return runtime.dispatch(method, params); },
        subscribe: fn => runtime.subscribe(fn), logger: () => {},
      });
      await controller.install(); controllers.set(contents.id, { controller, client });
      contents.once('destroyed', () => { controllers.delete(contents.id); client.close(); });
      status('renderer-loading', { webContentsId: contents.id, identity });
      if (exclusive) {
        let phase;
        const monitor = setInterval(async () => {
          if (disposed || contents.isDestroyed() || client.isClosed) { clearInterval(monitor); loginMonitors.delete(monitor); return; }
          if (!eligible(contents)) return;
          try {
            const current = await client.request('Runtime.evaluate', { expression: '({status:globalThis.__workbuddyPi?.status,waitReason:globalThis.__workbuddyPi?.waitReason})', returnByValue: true }, { timeoutMs: 2000 });
            const value = current.result?.value;
            if (value?.status === 'ready') { clearInterval(monitor); loginMonitors.delete(monitor); status('ready', { webContentsId: contents.id, transport: 'webContents.debugger', debugTcpPort: false, exclusive: true, nativeUi, officialModels: config.officialOnly === true }); }
            else if (value?.status === 'failed') { clearInterval(monitor); loginMonitors.delete(monitor); status('failed', { error: 'Pi native conversation contract did not initialize' }); }
            else {
              const next = value?.waitReason === 'official-models' ? 'waiting-official-models' : 'waiting-official-login';
              if (phase !== next) { phase = next; status(phase, { webContentsId: contents.id }); }
            }
          } catch { /* Main document reload can briefly replace its execution context. */ }
        }, 1000);
        monitor.unref?.(); loginMonitors.add(monitor);
        return;
      }
      const ready = await client.request('Runtime.evaluate', { expression: 'globalThis.__workbuddyPi.ready.then(()=>({status:globalThis.__workbuddyPi.status,error:globalThis.__workbuddyPi.error}))', awaitPromise: true, returnByValue: true }, { timeoutMs: exclusive ? 30 * 60 * 1000 : 125000 });
      if (ready.exceptionDetails || ready.result?.value?.status !== 'ready') throw Error('Pi native conversation contract did not initialize');
      status('ready', { webContentsId: contents.id, transport: 'webContents.debugger', debugTcpPort: false });
    } catch (error) {
      try { await controller?.dispose(); } catch {} try { client?.close(); } catch {}
      const known = ['Unsupported Pi renderer identity', 'Pi native conversation contract did not initialize', 'WorkBuddy renderer debugger is already in use'];
      status('failed', { error: known.includes(error.message) ? error.message : 'Pi renderer bridge failed' });
    } finally { pending.delete(contents.id); }
  }
  const created = (_event, contents) => {
    const load = () => { void attach(contents); };
    contents.on('did-finish-load', load); if (!contents.isLoadingMainFrame()) load();
  };
  electron.app.on('web-contents-created', created); electron.webContents.getAllWebContents().forEach(c => created(null, c));
  const close = async () => {
    if (disposed) return; disposed = true; electron.app.removeListener('web-contents-created', created);
    for (const timer of loginMonitors) clearInterval(timer); loginMonitors.clear();
    for (const { controller, client } of controllers.values()) { await controller.dispose({ preserveUiState: true }).catch(() => {}); client.close(); }
    controllers.clear(); try { await runtime.close(); } finally { release(); } status('closed');
  };
  let quitting = false;
  electron.app.on('before-quit', event => {
    if (quitting) return; quitting = true; event.preventDefault();
    void close().catch(() => status('cleanup-failed')).finally(() => electron.app.quit());
  }); status('installed');
  return { close, snapshot: () => ({ installed: !disposed, attached: controllers.size }) };
}
