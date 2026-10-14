import { parseArgs } from 'node:util';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { AuthStore } from '../src/store.mjs';
import { readConfig } from '../src/config.mjs';
import { hashPassword } from '../src/credentials.mjs';
import { adminContext } from '../src/admin-context.mjs';

export async function readPassword({ stdin = process.stdin, stdout = process.stderr } = {}) {
  if (!stdin.isTTY) {
    const chunks = []; let size = 0;
    for await (const chunk of stdin) {
      size += chunk.length; if (size > 1026) throw new Error('Password input is too long'); chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  return new Promise((resolve, reject) => {
    let value = '';
    const decoder = new StringDecoder('utf8');
    stdout.write('Password (hidden): '); stdin.setRawMode(true); stdin.resume();
    const finish = (error) => {
      stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); stdout.write('\n');
      error ? reject(error) : resolve(value);
    };
    const onData = chunk => {
      for (const character of decoder.write(chunk)) {
        if (character === '\u0003') return finish(new Error('Canceled'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = [...value].slice(0, -1).join('');
        else if (character >= ' ') value += character;
        if (Buffer.byteLength(value) > 1024) return finish(new Error('Password input is too long'));
      }
    };
    stdin.on('data', onData);
  });
}

async function run() {
  process.umask(0o077);
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    'display-name': { type: 'string' }, 'data-dir': { type: 'string' },
  } });
  const [command, username] = positionals;
  if (!['add', 'set-password', 'disable', 'enable', 'set-display-name', 'unlock', 'list'].includes(command) || positionals.length !== (command === 'list' ? 1 : 2)) {
    throw new Error('Usage: npm run user -- add|set-password|disable|enable|set-display-name|unlock <username> [--display-name <name>] [--data-dir <path>], or list');
  }
  const config = readConfig({ ...process.env, ...(values['data-dir'] ? { GATEWAY_DATA_DIR: values['data-dir'] } : {}) });
  const store = new AuthStore(config);
  try {
    if (command === 'list') {
      for (const user of store.listUsers()) console.log(JSON.stringify({ username: user.username, displayName: user.nickname, disabled: !!user.disabled }));
      return;
    }
    const context = adminContext();
    if (command === 'disable' || command === 'enable') store.updateUser(username, undefined, command === 'disable', context);
    else if (command === 'set-display-name') store.setDisplayName(username, values['display-name'], context);
    else if (command === 'unlock') store.unlockUser(username, context);
    else {
      const password = await readPassword();
      if (process.stdin.isTTY) {
        const confirmation = await readPassword();
        if (password !== confirmation) throw new Error('Passwords do not match');
      }
      const hash = await hashPassword(password);
      if (command === 'add') store.addUser(username, values['display-name'] || username, hash, context);
      else store.updateUser(username, hash, undefined, context);
    }
    console.log(`${command}: completed`);
  } finally { store.close(); }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
