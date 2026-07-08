// Minimal static file server for the Playwright harness (e.g. the evil origin).
// Usage: DIR=e2e/evil PORT=4666 node e2e/static-server.mjs
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const dir = path.resolve(process.env.DIR ?? '.');
const port = Number(process.env.PORT ?? 8080);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let file = path.join(dir, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) {
    file = path.join(dir, 'index.html');
  }
  res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`static server for ${dir} on http://localhost:${port}`));
