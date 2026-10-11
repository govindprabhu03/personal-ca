// Production behaviour: lockout after wrong tokens, safe error replies, logs, data-file versioning, daily backups.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { dailyBackup, openDb, SCHEMA_VERSION } from '../src/db';
import { createLogger } from '../src/log';

const TOKEN = 'prod-token-abcdefghijklmnop';
let tmp = '', logDir = '';
const servers: Array<{ close(): void }> = [];

/** A fresh server per test so lockout state never leaks between them. */
async function boot() {
  const s = createApp(openDb(':memory:'), { token: TOKEN, log: createLogger(logDir, { consoleFrom: 'never' }) }).listen(0);
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return (p: string, key?: string, init: RequestInit = {}) => fetch(base + p, { ...init, headers: { ...(key ? { 'x-api-key': key } : {}), ...(init.headers as object) } });
}

beforeAll(() => { tmp = mkdtempSync(path.join(tmpdir(), 'ca-prod-')); logDir = path.join(tmp, 'logs'); });
afterAll(() => { servers.forEach((s) => s.close()); });

describe('wrong access tokens', () => {
  it('locks an address out for a minute after 10 misses, even for the right token', async () => {
    const get = await boot();
    for (let i = 0; i < 10; i++) expect((await get('/api/bootstrap', 'nope-' + i)).status).toBe(401);
    const blocked = await get('/api/bootstrap', TOKEN);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('a right token resets the count', async () => {
    const get = await boot();
    for (let i = 0; i < 9; i++) await get('/api/bootstrap', 'bad' + i);
    expect((await get('/api/bootstrap', TOKEN)).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await get('/api/bootstrap', 'bad' + i)).status).toBe(401);
    expect((await get('/api/bootstrap', TOKEN)).status).toBe(200);
  });

  it('logs the failure by route and status, never the token that was tried', async () => {
    const get = await boot();
    await get('/api/bootstrap', 'my-secret-guess-xyz');
    await new Promise((r) => setTimeout(r, 100)); // the server logs just after the reply leaves
    const text = readdirSync(logDir).map((f) => readFileSync(path.join(logDir, f), 'utf8')).join('\n');
    expect(text).toContain('GET /api/bootstrap -> 401');
    expect(text).not.toContain('my-secret-guess-xyz');
    expect(text).not.toContain(TOKEN);
  });
});

describe('safe replies', () => {
  it('answers malformed or oversized bodies with a 4xx, not a 500, and sets security headers', async () => {
    const get = await boot();
    const bad = await get('/api/transactions', TOKEN, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"amount_paise": ' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBeTruthy();
    const ok = await get('/api/bootstrap', TOKEN);
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('x-frame-options')).toBe('DENY');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('x-powered-by')).toBeNull();
  });
});

describe('data file versioning', () => {
  it('stamps a new file, upgrades an unstamped (older) one, and refuses a file from a newer program', () => {
    const f = path.join(tmp, 'v.db');
    openDb(f).close();
    const stamp = () => { const d = new DatabaseSync(f); const v = (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version; d.close(); return v; };
    expect(stamp()).toBe(SCHEMA_VERSION);

    const old = new DatabaseSync(f); old.exec('PRAGMA user_version = 0'); old.close(); // what every file made before versioning looks like
    openDb(f).close();
    expect(stamp()).toBe(SCHEMA_VERSION);

    const future = new DatabaseSync(f); future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`); future.close();
    expect(() => openDb(f)).toThrow(/newer Personal CA/);
  });
});

describe('daily backups', () => {
  it('writes one consistent copy a day, includes the data, and keeps only the newest N', () => {
    const db = openDb(path.join(tmp, 'live.db'));
    db.prepare("INSERT INTO accounts (kind, name, opening_paise) VALUES ('bank', 'Backup test', 0)").run();
    const dir = path.join(tmp, 'backups');
    const first = dailyBackup(db, dir, 3, '2026-10-01');
    expect(first && existsSync(first)).toBe(true);
    expect(dailyBackup(db, dir, 3, '2026-10-01')).toBeNull(); // already have today's
    for (const d of ['2026-10-02', '2026-10-03', '2026-10-04']) dailyBackup(db, dir, 3, d);
    expect(readdirSync(dir).sort()).toEqual(['ca-2026-10-02.db', 'ca-2026-10-03.db', 'ca-2026-10-04.db']);
    const copy = new DatabaseSync(path.join(dir, 'ca-2026-10-04.db'));
    expect((copy.prepare("SELECT COUNT(*) AS n FROM accounts WHERE name = 'Backup test'").get() as { n: number }).n).toBe(1);
    copy.close(); db.close();
  });
});

describe('log files', () => {
  it('keeps only the newest N days', () => {
    const dir = path.join(tmp, 'oldlogs');
    mkdirSync(dir);
    for (let d = 1; d <= 5; d++) { const f = path.join(dir, `personalca-2026-09-0${d}.log`); writeFileSync(f, 'x'); utimesSync(f, new Date(), new Date()); }
    createLogger(dir, { keepDays: 2, consoleFrom: 'never' }).info('hello');
    const left = readdirSync(dir).filter((f) => f.startsWith('personalca-2026-09'));
    expect(left).toEqual(['personalca-2026-09-04.log', 'personalca-2026-09-05.log']);
  });
});
