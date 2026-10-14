import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AuthStore } from '../src/store.mjs';
import { verifyPassword } from '../src/credentials.mjs';

test('account CLI creates, lists, changes password and disables without exposing passwords', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-user-cli-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const filename = fileURLToPath(new URL('../scripts/user.mjs', import.meta.url));
  const password = 'only-for-user-cli-fixture', replacement = 'only-for-user-cli-replacement';
  const run = (args, input = '', entry = filename) => {
    const result = spawnSync(process.execPath, [entry, ...args], { input, encoding: 'utf8', env: { ...process.env, GATEWAY_DATA_DIR: dataDir } });
    assert.equal(result.status, 0);
    assert.ok(!result.stdout.includes(password) && !result.stderr.includes(password));
    assert.ok(!result.stdout.includes(replacement) && !result.stderr.includes(replacement));
    return result.stdout;
  };
  run(['add', 'cli-user', '--display-name', 'CLI fixture'], `${password}\n`);
  assert.equal(JSON.parse(run(['list']).trim()).username, 'cli-user');
  const current = path.join(dataDir, 'current-user.mjs'); fs.symlinkSync(filename, current);
  assert.equal(JSON.parse(run(['list'], '', current).trim()).username, 'cli-user');
  run(['set-password', 'cli-user'], `${replacement}\n`);
  const config = { dataDir, publicUrl: 'http://127.0.0.1:8787', accessTtlSeconds: 3600, refreshTtlSeconds: 86400, loginTtlSeconds: 300 };
  let store = new AuthStore(config);
  try {
    assert.equal(await verifyPassword(password, store.getUser('cli-user').password_hash), false);
    assert.equal(await verifyPassword(replacement, store.getUser('cli-user').password_hash), true);
  } finally { store.close(); }
  run(['disable', 'cli-user']);
  assert.equal(JSON.parse(run(['list']).trim()).disabled, true);
});
