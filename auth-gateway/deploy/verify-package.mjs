import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8'));
if (manifest.kind !== 'workbuddy-auth-release' || manifest.schema !== 2 || !/^0\.(?:2|3)\.\d+-[a-f0-9]{12}$/.test(manifest.id)) throw new Error('Unsupported release manifest');
const files = [];
function walk(directory) {
  for (const name of fs.readdirSync(directory)) {
    const filename = path.join(directory, name), stat = fs.lstatSync(filename);
    if (stat.isDirectory()) walk(filename);
    else if (stat.isFile()) files.push(path.relative(root, filename));
    else throw new Error('Release contains a symlink or special file');
  }
}
walk(root);
const expected = Object.keys(manifest.files).sort(), actual = files.filter(name => name !== 'release-manifest.json').sort();
if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Release file inventory mismatch');
for (const name of expected) {
  if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('Invalid release path');
  if (createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex') !== manifest.files[name]) throw new Error('Release checksum mismatch: ' + name);
}
if (process.argv[2] === '--id') console.log(manifest.id);
else console.log(JSON.stringify({ release: manifest.id, files: expected.length, verified: true }));
