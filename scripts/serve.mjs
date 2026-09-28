// Private local preview, with byte ranges for MP4 seeking. No dependencies.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 8767);
const projectPrefix = '/' + (process.env.PROJECT_PATH || 'anonymous-preview').replace(/^\/+|\/+$/g, '');
const mime = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8'};

createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  try {
    let name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    // Exercise both root and GitHub project-site URL layouts in local QA.
    if (name.startsWith(projectPrefix + '/')) name = name.slice(projectPrefix.length);
    if (name === '/') name = '/index.html';
    if (!(name === '/index.html' || name === '/THIRD_PARTY.md' || name.startsWith('/static/'))) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const path = resolve(root, `.${name}`);
    if (!path.startsWith(root + sep)) throw new Error('Invalid path');
    if (name.startsWith('/static/') && !path.startsWith(resolve(root, 'static') + sep)) throw new Error('Invalid static path');
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error('Not a file');
    const headers = {'Content-Type': mime[extname(path)] || 'application/octet-stream',
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff'};
    let start = 0, end = stat.size - 1, status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match) { res.writeHead(416, {'Content-Range': `bytes */${stat.size}`}); res.end(); return; }
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Math.min(end, Number(match[2])) : end;
      } else {
        start = Math.max(0, stat.size - Number(match[2]));
      }
      if (start > end || start >= stat.size) { res.writeHead(416, {'Content-Range': `bytes */${stat.size}`}); res.end(); return; }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') res.end();
    else { const stream = createReadStream(path, {start, end}); stream.pipe(res); res.on('close', () => stream.destroy()); }
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`EgoCPT preview: http://127.0.0.1:${port}/`));
