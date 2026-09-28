// No dependencies. Runs locally and before every GitHub Pages deployment.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(site, 'index.html'), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
assert.equal(ids.length, new Set(ids).size, 'Duplicate HTML IDs');
let checked = 0;
const assets = new Set(['static/css/BULMA-LICENSE.txt']);
for (const [, raw] of html.matchAll(/\b(?:src|href|poster|data-src)="([^"]+)"/g)) {
  if (/^https?:\/\//.test(raw)) {
    assert(['nerfies.github.io', 'creativecommons.org'].includes(new URL(raw).hostname), `Review external URL before publishing anonymously: ${raw}`);
    continue;
  }
  if (raw.startsWith('#')) {
    assert(ids.includes(raw.slice(1)), `Missing fragment target: ${raw}`);
  } else {
    assert(!raw.startsWith('/'), `Root-relative URL breaks project Pages deployment: ${raw}`);
    const path = resolve(site, decodeURIComponent(raw.split('#')[0]));
    assert(path.startsWith(site + sep), `Reference leaves website: ${raw}`);
    assert(existsSync(path), `Missing local asset: ${raw}`);
    assert(statSync(path).size > 0, `Empty local asset: ${raw}`);
    if (raw.startsWith('static/')) assets.add(raw);
  }
  checked++;
}
assert(!/gtag\(|googletagmanager|google-analytics|G-PYVRSFMDRL/.test(html), 'Upstream analytics must not be shipped');
assert(/<div class="publication-authors">\s*<span class="author-block">Anonymous Authors<\/span>\s*<\/div>/.test(html), 'Use anonymous author attribution');
assert(!/institution-logos|publication-affiliations/.test(html), 'Remove identifying header content');
assert(html.includes('author = {{Anonymous Authors}}'), 'Citation must be anonymous');
assert(html.includes('<meta name="robots" content="noindex, nofollow">'), 'Keep the review copy out of search indexes');
assert(!/google-site-verification|rel="canonical"|property="og:url"/.test(html), 'Remove original-site ownership and identity links');
assert(!html.toLowerCase().includes('.pdf'), 'Paper download links are withheld during double-blind review');
assert(html.includes('https://nerfies.github.io/'), 'Keep the template attribution');
assert(html.includes('creativecommons.org/licenses/by-sa/4.0'), 'Keep template license');
let bytes = 0, files = 0;
function scan(folder) {
  for (const name of readdirSync(folder)) {
    const file = join(folder, name), stat = lstatSync(file);
    assert(!stat.isSymbolicLink(), `Public asset cannot be a symlink: ${file}`);
    if (stat.isDirectory()) scan(file);
    else {
      assert(assets.has(file.slice(site.length + 1)), `Unreferenced public asset: ${file}`);
      assert(!name.toLowerCase().endsWith('.pdf'), `Review manuscript/PDF cannot be published: ${file}`);
      assert(stat.size < 95 * 1024 * 1024, `Asset too large for regular GitHub files: ${file}`);
      assert(!/\.(npz|pt|pth|ckpt|pem|key|env|log)$/.test(name), `Unexpected experiment/secret file: ${file}`);
      bytes += stat.size; files++;
    }
  }
}
scan(join(site, 'static'));
assert(bytes < 250 * 1024 * 1024, 'Keep the website payload small');
console.log(JSON.stringify({passed: true, local_links_checked: checked, static_files: files, static_bytes: bytes}, null, 2));
