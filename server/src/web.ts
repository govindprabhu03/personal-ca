// Serves the web version of the app (the Expo web export) from the same server, so the Windows .exe is ONE self-contained program.
// The files come from inside the .exe (Node single-executable assets) or, for development, from a folder on disk.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Express, Request } from 'express';

export interface AssetSource { get(file: string): Buffer | undefined }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
};

/** Files from a folder on disk. Paths can't escape the folder. */
export function diskAssets(dir: string): AssetSource {
  const root = path.resolve(dir);
  return {
    get(file) {
      const f = path.resolve(root, '.' + path.posix.normalize('/' + file)); // normalising from "/" swallows any ../
      if (!f.startsWith(root + path.sep) || !existsSync(f) || !statSync(f).isFile()) return undefined;
      return readFileSync(f);
    },
  };
}

/** Files baked into this program when it runs as a Node single-executable. Null when it is not one. */
export function seaAssets(): AssetSource | null {
  try {
    const sea = require('node:sea');
    if (!sea.isSea()) return null;
    return { get: (file) => { try { return Buffer.from(sea.getAsset(`web/${file}`)); } catch { return undefined; } } };
  } catch { return null; }
}

const isLoopback = (q: Request) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(q.socket.remoteAddress ?? '');

/**
 * GET anything that isn't /api -> a file of the web app (unknown extension-less paths get index.html, so the app can own its screens).
 * The access token is written into index.html ONLY when the page is opened on this PC itself, so the PC's own browser just works
 * while a phone or anyone else on the network gets the app but no key.
 */
export function mountWeb(app: Express, assets: AssetSource, token?: string) {
  app.use((q, r, n) => {
    if ((q.method !== 'GET' && q.method !== 'HEAD') || q.path.startsWith('/api')) return n();
    let name: string;
    try { name = decodeURIComponent(q.path).replace(/^\/+/, '') || 'index.html'; } catch { return void r.status(400).end(); }
    let file = assets.get(name);
    if (!file) {
      if (path.extname(name)) return void r.status(404).type('text').send('Not found');
      name = 'index.html'; file = assets.get(name);
      if (!file) return n();
    }
    if (name === 'index.html') {
      let html = file.toString('utf8');
      if (token && isLoopback(q)) html = html.replace('</head>', `<script>window.__CA_TOKEN__=${JSON.stringify(token)}</script></head>`);
      return void r.type('html').set('Cache-Control', 'no-store').send(html);
    }
    r.type(MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream').set('Cache-Control', 'public, max-age=3600').send(file);
  });
}
