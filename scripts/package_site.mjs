// Publish only the static website, never the surrounding robotics workspace.
import './verify_site.mjs';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(site, '_site');
if (existsSync(output)) throw new Error('_site already exists; choose a clean checkout for packaging.');
mkdirSync(output);
for (const name of ['index.html', 'static', '.nojekyll', 'THIRD_PARTY.md']) {
  cpSync(resolve(site, name), resolve(output, name), {recursive: true, errorOnExist: true, force: false});
}
console.log(`Packaged static site: ${output}`);
