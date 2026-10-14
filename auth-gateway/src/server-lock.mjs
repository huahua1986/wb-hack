import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function serverRunning(dataDir) {
  const filename = path.join(dataDir, 'server.lock');
  if (!fs.existsSync(filename)) return false;
  if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('Invalid server lock');
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (value.kind !== 'workbuddy-auth-server' || !Number.isInteger(value.pid) || value.pid < 1) throw new Error('Invalid server lock; inspect it before maintenance');
  try { process.kill(value.pid, 0); return true; }
  catch (error) { if (error.code !== 'ESRCH') throw new Error('Cannot prove the server is stopped'); return false; }
}

export function acquireServerLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filename = path.join(dataDir, 'server.lock'), nonce = randomUUID();
  if (fs.existsSync(filename)) {
    if (serverRunning(dataDir)) throw new Error('An authentication server already owns this data directory');
    fs.unlinkSync(filename);
  }
  fs.writeFileSync(filename, JSON.stringify({ kind: 'workbuddy-auth-server', pid: process.pid, nonce }), { mode: 0o600, flag: 'wx' });
  return () => {
    if (fs.existsSync(filename) && JSON.parse(fs.readFileSync(filename, 'utf8')).nonce === nonce) fs.unlinkSync(filename);
  };
}
