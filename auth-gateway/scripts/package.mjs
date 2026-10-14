import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { output: { type: 'string' } } });
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = [
  ...['config', 'credentials', 'client-ip', 'admin-context', 'store', 'gateway', 'compatibility', 'html', 'main', 'server-lock', 'backup', 'catalog-store', 'package-archive', 'content-http', 'content-protocol', 'connector-catalog'].map(name => 'src/' + name + '.mjs'),
  ...['user', 'session', 'audit', 'backup', 'restore', 'health', 'catalog', 'seed-private-content'].map(name => 'scripts/' + name + '.mjs'),
  ...fs.readdirSync(path.join(root, 'deploy')).filter(name => /\.(sh|mjs|md|example)$/.test(name)).map(name => 'deploy/' + name),
  ...['helpers.mjs', 'gateway.test.mjs', 'user-cli.test.mjs', 'backend-security.test.mjs', 'backup.test.mjs', 'catalog-store.test.mjs', 'content-http.test.mjs'].map(name => 'test/' + name),
  'README.md', '.env.example',
];
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auth-package-')), bundle = path.join(stage, 'workbuddy-auth');
fs.mkdirSync(bundle);
try {
  for (const name of files) {
    const source = path.join(root, name);
    if (!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw new Error('Packaging requires regular source files');
    fs.mkdirSync(path.dirname(path.join(bundle, name)), { recursive: true });
    fs.copyFileSync(source, path.join(bundle, name));
    fs.chmodSync(path.join(bundle, name), name.endsWith('.sh') ? 0o755 : 0o644);
  }
  pkg.scripts = { start: 'node src/main.mjs', test: 'node --test test/*.test.mjs', user: 'node scripts/user.mjs', session: 'node scripts/session.mjs', audit: 'node scripts/audit.mjs', catalog: 'node scripts/catalog.mjs', 'content:seed': 'node scripts/seed-private-content.mjs', backup: 'node scripts/backup.mjs', restore: 'node scripts/restore.mjs', health: 'node scripts/health.mjs' };
  fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const inventory = {};
  for (const name of [...files, 'package.json'].sort()) inventory[name] = createHash('sha256').update(fs.readFileSync(path.join(bundle, name))).digest('hex');
  const id = pkg.version + '-' + createHash('sha256').update(JSON.stringify(inventory)).digest('hex').slice(0, 12);
  fs.writeFileSync(path.join(bundle, 'release-manifest.json'), JSON.stringify({ kind: 'workbuddy-auth-release', id, schema: 2, files: inventory }, null, 2) + '\n');
  const output = path.resolve(values.output || path.join(root, 'dist', 'workbuddy-auth-' + id + '.tar.gz'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const fd = fs.openSync(output, 'wx', 0o600);
  let archived = false;
  try {
    const result = spawnSync('tar', ['--no-xattrs', '-czf', '-', '-C', stage, 'workbuddy-auth'], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', fd, 'pipe'] });
    if (result.status !== 0) throw new Error('Could not create deployment archive');
    archived = true;
  } finally { fs.closeSync(fd); if (!archived) fs.unlinkSync(output); }
  const sha256 = createHash('sha256').update(fs.readFileSync(output)).digest('hex');
  fs.writeFileSync(output + '.sha256', sha256 + '  ' + path.basename(output) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ release: id, archive: output, sha256, files: Object.keys(inventory).length }));
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
