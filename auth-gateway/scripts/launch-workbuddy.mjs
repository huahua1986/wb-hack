import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { clientEnvironment } from '../src/client-profile.mjs';

try {
  const { values } = parseArgs({ options: {
    'profile': { type: 'string' }, 'reuse-development-auth': { type: 'boolean', default: false },
    'replace-production-login': { type: 'boolean', default: false }, 'check': { type: 'boolean', default: false },
  } });
  if (!values.profile) throw new Error('Pass --profile <launch.json>');
  const profile = JSON.parse(fs.readFileSync(values.profile, 'utf8'));
  const env = clientEnvironment(profile);
  const shared = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    : process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
      : path.join(os.homedir(), '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  const authPath = path.join(shared, `workbuddy-desktop${profile.mode === 'development' ? '-dev' : ''}.info`);
  console.log(`Client mode: ${profile.mode}; auth namespace: ${path.basename(authPath)}`);
  console.log('The auth directory is shared at OS-user level; only config/task data use this profile.');
  if (profile.mode === 'production' && !values['replace-production-login']) throw new Error('Production mode replaces the shared WorkBuddy login; use an independent OS user or explicitly pass --replace-production-login');
  if (profile.mode === 'development' && (fs.existsSync(authPath) || fs.existsSync(`${authPath}.logged-out`)) && !values['reuse-development-auth']) {
    throw new Error('An existing development auth namespace is present. Use an independent OS user or --reuse-development-auth for your existing test account.');
  }
  if (values.check) { console.log('Preflight completed; WorkBuddy was not started.'); }
  else {
    if (!fs.existsSync(profile.executable)) throw new Error('Configured WorkBuddy executable does not exist');
    fs.mkdirSync(profile.configDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(profile.userDataDir, { recursive: true, mode: 0o700 });
    console.log('Close other WorkBuddy instances first; this startup configuration applies to a fresh process.');
    const child = spawn(profile.executable, [], { env, stdio: 'ignore', detached: true, shell: false });
    child.once('error', error => { console.error(`Could not launch (${error.code || 'process error'})`); process.exitCode = 1; });
    child.unref();
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
