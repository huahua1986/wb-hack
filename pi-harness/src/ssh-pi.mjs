import { lstatSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const REMOTE_LAUNCHER = '/usr/local/libexec/workbuddy-pi-rpc';
const REMOTE_OFFICE_LAUNCHER = '/usr/local/libexec/workbuddy-pi-office-rpc';
export const SSH_PI_THREAD_ID = /^pi-thread-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function normalizeSshPi(value, base) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['host', 'port', 'user', 'identityFile', 'knownHostsFile'].includes(key))) {
    throw Error('Invalid Pi SSH configuration');
  }
  const { host, user, port = 22 } = value;
  const hostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
  if (typeof host !== 'string' || host.length > 253 || !(isIP(host) || hostname.test(host))
    || typeof user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/i.test(user)
    || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid Pi SSH destination');

  const configuration = { host, user, port };
  for (const field of ['identityFile', 'knownHostsFile']) {
    const input = value[field];
    // OpenSSH also interpolates percent tokens and environment variables in paths.
    if (typeof input !== 'string' || !input.trim() || /[\x00-\x1f\x7f"%$\\]/.test(input)) {
      throw Error(`Invalid Pi SSH ${field}`);
    }
    const filename = resolve(base, input.replace(/^~\//, homedir() + '/'));
    if (/[\x00-\x1f\x7f"%$\\]/.test(filename)) throw Error(`Invalid Pi SSH ${field}`);
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 1024 * 1024
      || (stat.mode & (field === 'identityFile' ? 0o077 : 0o022))) {
      throw Error(`Pi SSH ${field} must be a protected regular file`);
    }
    configuration[field] = filename;
  }
  return configuration;
}

export function sshPiCommand(config, threadId, { office = false } = {}) {
  if (!SSH_PI_THREAD_ID.test(threadId)) throw Error('Invalid remote Pi thread ID');
  return {
    command: '/usr/bin/ssh',
    args: [
      '-F', '/dev/null', '-T', '-p', String(config.port), '-l', config.user, '-i', config.identityFile,
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519',
      '-o', `UserKnownHostsFile="${config.knownHostsFile}"`, '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'UpdateHostKeys=no', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
      '--', config.host, office ? REMOTE_OFFICE_LAUNCHER : REMOTE_LAUNCHER, threadId,
    ],
  };
}
