import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { prepareClientProfile } from '../src/client-profile.mjs';

try {
  process.umask(0o077);
  const { values } = parseArgs({ options: {
    'app': { type: 'string' }, 'product': { type: 'string' }, 'executable': { type: 'string' },
    'gateway': { type: 'string' }, 'profile': { type: 'string' }, 'mode': { type: 'string', default: 'development' },
  } });
  if (!values.gateway || !values.profile || (!values.app && (!values.product || !values.executable))) {
    throw new Error('Usage: npm run client:prepare -- --app <WorkBuddy.app> --gateway <origin> --profile <new-directory> [--mode development|production]; other platforms: --product <bundled-product.json> --executable <WorkBuddy-executable>');
  }
  const productPath = values.product || path.join(values.app, 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'product.json');
  const executable = values.executable || path.join(values.app, 'Contents', 'MacOS', 'Electron');
  if (!fs.existsSync(executable)) throw new Error('WorkBuddy executable does not exist; pass --executable explicitly');
  const baseProduct = JSON.parse(fs.readFileSync(productPath, 'utf8'));
  const profilePath = prepareClientProfile({ baseProduct, executable, gateway: values.gateway, profileDir: values.profile, mode: values.mode });
  console.log(`Prepared ${profilePath}`);
  console.log('No application was launched or modified. Model configuration can be added through WorkBuddy settings after login.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
