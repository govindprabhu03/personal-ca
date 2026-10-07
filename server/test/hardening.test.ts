// What protects a server that listens on your network, and the web app it serves.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { openDb } from '../src/db';
import { diskAssets } from '../src/web';

const TOKEN = 'test-token-123';
let server: ReturnType<ReturnType<typeof createApp>['listen']>, port = 0, tmp = '';

/** fetch() won't let us forge a Host header (browsers can't either, but a rebinding attacker's domain makes them send a foreign one). */
const raw = (p: string, headers: Record<string, string> = {}, method = 'GET') => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
  });
  req.on('error', reject); req.end();
});

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'ca-web-'));
  const site = path.join(tmp, 'site');
  mkdirSync(path.join(site, '_expo'), { recursive: true });
  writeFileSync(path.join(site, 'index.html'), '<html><head><title>CA</title></head><body>app</body></html>');
  writeFileSync(path.join(site, '_expo', 'app.js'), 'console.log("app")');
  writeFileSync(path.join(site, 'sql.wasm'), Buffer.from([0, 97, 115, 109]));
  writeFileSync(path.join(tmp, 'secret.txt'), 'TOP SECRET'); // sits OUTSIDE the site folder
  server = createApp(openDb(':memory:'), { token: TOKEN, web: diskAssets(site) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => { server.close(); });

describe('who may talk to the server', () => {
  it('answers normal requests from this PC', async () => {
    expect((await raw('/api/health')).status).toBe(200);
    expect((await raw('/api/health', { Host: `localhost:${port}` })).status).toBe(200);
  });
  it('refuses a foreign Host header (DNS rebinding), even with the right token', async () => {
    const r = await raw('/api/bootstrap', { Host: 'evil.example.com', 'x-api-key': TOKEN });
    expect(r.status).toBe(421);
    expect(r.body).not.toContain('accounts');
  });
  it('refuses to let other websites read answers (CORS), but allows this PC and apps without an Origin', async () => {
    const evil = await raw('/api/health', { Origin: 'http://evil.example.com' });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const own = await raw('/api/health', { Origin: 'http://localhost:8094' });
    expect(own.headers['access-control-allow-origin']).toBe('http://localhost:8094');
    expect((await raw('/api/health')).status).toBe(200); // a phone app sends no Origin
  });
  it('needs the token for the API, including the pairing details', async () => {
    expect((await raw('/api/pairing')).status).toBe(401);
    const ok = JSON.parse((await raw('/api/pairing', { 'x-api-key': TOKEN })).body);
    expect(ok.token).toBe(TOKEN);
    expect(Array.isArray(ok.urls)).toBe(true);
    expect(ok.urls.every((u: string) => u.endsWith(`:${port}`))).toBe(true);
  });
});

describe('serving the web app', () => {
  it('serves index.html with the token injected for the PC itself (loopback)', async () => {
    const r = await raw('/');
    expect([r.status, r.headers['content-type']]).toEqual([200, 'text/html; charset=utf-8']);
    expect(r.body).toContain(`window.__CA_TOKEN__=${JSON.stringify(TOKEN)}`);
    expect(r.body.indexOf('__CA_TOKEN__')).toBeLessThan(r.body.indexOf('</head>')); // before the app's own scripts run
    expect(r.headers['cache-control']).toBe('no-store');
  });
  it('serves files with the right content type (wasm must be application/wasm)', async () => {
    expect((await raw('/_expo/app.js')).headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect((await raw('/sql.wasm')).headers['content-type']).toBe('application/wasm');
  });
  it('gives extension-less unknown paths the app, 404s missing files, and leaves /api alone', async () => {
    expect((await raw('/some/screen')).body).toContain('<title>CA</title>');
    expect((await raw('/missing.png')).status).toBe(404);
    expect((await raw('/api/health')).headers['content-type']).toContain('application/json');
    expect((await raw('/api/nope', { 'x-api-key': TOKEN })).status).toBe(404);
  });
  it('cannot be tricked into serving files outside the web folder', async () => {
    for (const evil of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/_expo/..%2f..%2fsecret.txt']) {
      const r = await raw(evil);
      expect(r.body).not.toContain('TOP SECRET');
    }
  });
});

describe('without a token (plain local development) nothing is injected', () => {
  it('serves the page unchanged', async () => {
    const s = createApp(openDb(':memory:'), { web: diskAssets(path.join(tmp, 'site')) }).listen(0);
    await new Promise((r) => s.once('listening', r));
    const p = (s.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${p}/`);
    expect(await res.text()).not.toContain('__CA_TOKEN__');
    s.close();
  });
});
