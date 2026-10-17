// Test-only network failure injection. This file is excluded from all client payloads.
const fs = require('node:fs');
const net = require('node:net');
const cp = require('node:child_process');
const path = require('node:path');
const guardKey = Symbol.for('workbuddy.offline-test');
function install(filename) {
  if (globalThis[guardKey]) return globalThis[guardKey];
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const log = event => fs.appendFileSync(config.log, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...event }) + '\n', {mode:0o600});
  const proxyPorts = new Set(config.proxyPorts || []);
  const allowHost = (host, port) => {
    host=String(host || 'localhost').replace(/^\[|\]$/g,'').toLowerCase();
    if (['localhost','127.0.0.1','::1'].includes(host)) return !proxyPorts.has(Number(port));
    if (net.isIP(host)===4) { const [a,b]=host.split('.').map(Number);return a===10||a===192&&b===168||a===172&&b>=16&&b<=31; }
    return config.hosts?.includes(host) || false;
  };
  const delayMs = Number.isInteger(config.delayMs) && config.delayMs >= 0 && config.delayMs <= 5000 ? config.delayMs : 0;
  const offline = () => Object.assign(new Error('Offline acceptance: external connection unavailable'), { code:'ENETUNREACH' });
  const originalConnect=net.Socket.prototype.connect;
  net.Socket.prototype.connect=function(...args){
    let o=Array.isArray(args[0])?args[0][0]:args[0];
    if (typeof o==='number'||typeof o==='string'&&/^\d+$/.test(o)) o={port:Number(o),host:typeof args[1]==='string'?args[1]:'localhost'};
    if (typeof o==='string'||o?.path&&!o?.port) return originalConnect.apply(this,args);
    if (o && !allowHost(o.host||o.hostname,o.port)) {log({event:'blocked-socket',port:Number(o.port)||0});if(delayMs)setTimeout(()=>this.destroy(offline()),delayMs);else queueMicrotask(()=>this.destroy(offline()));return this;}
    return originalConnect.apply(this,args);
  };
  const originalFetch=globalThis.fetch;
  if(originalFetch) globalThis.fetch=function(input,...rest){
    let u;try{u=new URL(typeof input==='string'||input instanceof URL?input:input.url);}catch{return originalFetch.call(this,input,...rest);}
    if(!allowHost(u.hostname,u.port|| (u.protocol==='https:'?443:80))) {log({event:'blocked-fetch'});return new Promise((_,reject)=>{
      const signal=rest[0]?.signal || input?.signal;
      const aborted=()=>{clearTimeout(timer);reject(signal.reason || new DOMException('Aborted','AbortError'));};
      const timer=setTimeout(()=>{signal?.removeEventListener('abort',aborted);reject(new TypeError('fetch failed',{cause:offline()}));},delayMs);
      if(signal?.aborted)aborted();else signal?.addEventListener('abort',aborted,{once:true});
    });}
    return originalFetch.call(this,input,...rest);
  };
  const nodeArgs=(file,args,options={})=>{
    const isNode=/^node(?:\.exe)?$/.test(path.basename(file)) || file===process.execPath&&(options.env || process.env).ELECTRON_RUN_AS_NODE==='1';
    return {args:isNode?['--require',__filename,...(args||[])]:args,node:isNode};
  };
  for(const method of ['spawn','spawnSync','execFile','execFileSync']) {
    const previous=cp[method];
    cp[method]=function(file,args,options,...rest){
      if(!Array.isArray(args))return previous.apply(this,arguments);
      const callback=typeof options==='function'?options:null;
      const opts=callback?{}:options||{},injected=nodeArgs(file,args,opts);
      const next=injected.node?{...opts,env:{...(opts.env||process.env),WB_OFFLINE_TEST_CONFIG:filename}}:opts;
      return previous.call(this,file,injected.args,next,...(callback?[callback,...rest]:rest));
    };
  }
  const fork=cp.fork;cp.fork=function(modulePath,args,options={}){
    if(!Array.isArray(args)){options=args||{};args=[];}
    return fork.call(this,modulePath,args,{...options,env:{...(options.env||process.env),WB_OFFLINE_TEST_CONFIG:filename},execArgv:['--require',__filename,...(options.execArgv||process.execArgv)]});
  };
  const state={allowHost,log};globalThis[guardKey]=state;log({event:'node-hook-installed'});return state;
}
module.exports={install};
if(process.env.WB_OFFLINE_TEST_CONFIG)install(process.env.WB_OFFLINE_TEST_CONFIG);
