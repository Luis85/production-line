                                                                 
import { lstat, readFile } from 'node:fs/promises';
import { json } from './server.js';
const contentTypes                         = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2' };
/** Serve only the flat, generated asset directory; never fall back to application HTML. */
export async function serveWebviewAsset(request                 , response                , root     )                   {
  const raw = request.url ?? '/';
  if (!raw.startsWith('/assets/')) return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') { json(response, 405, { error: 'Read-only webview assets' }); return true; }
  const match = /^\/assets\/([a-zA-Z0-9_.-]+\.(js|css|svg|png|woff2))$/.exec(raw);
  if (!match) { json(response, 404, { error: 'Asset not found' }); return true; }
  try {
    const file = new URL('assets/' + match[1], root), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw Error('Invalid asset');
    const body = request.method === 'HEAD' ? undefined : await readFile(file);
    response.writeHead(200, { 'content-type': contentTypes[match[2]], 'content-length': info.size,
      'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
    response.end(body);
  } catch { json(response, 404, { error: 'Asset not found' }); }
  return true;
}
