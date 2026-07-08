// Static server for the tic-tac-toe frontend (Phase 0: localhost:4000).
// Deliberately sets no X-Frame-Options so the hub can embed it; the hub's CSP
// frame-src is what actually gates embedding.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT ?? 4000);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json', '.css': 'text/css' };

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let file = path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(publicDir) || !existsSync(file) || statSync(file).isDirectory()) {
    file = path.join(publicDir, 'index.html'); // SPA fallback
  }
  res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`tictactoe frontend on http://localhost:${PORT}`));
