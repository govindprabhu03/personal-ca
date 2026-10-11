// Accounts on the hosted server: sign-in tokens are verified like Supabase's (ES256, issuer, audience, expiry), and every user gets their own
// encrypted file under their own key. Tokens here are minted with a throwaway key pair; the server is given its public half.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearerAuth, keyFor } from '../src/cloud/auth';
import { createCloudHandler, perUser } from '../src/cloud/handler';
import { memoryStore } from '../src/cloud/store';
import { decrypt } from '../src/engine/crypto';

const PROJECT = 'https://abcdefghij.supabase.co', ISS = `${PROJECT}/auth/v1`, MASTER = 'master-data-key-abcdefghijklmnop';
const ALICE = '11111111-1111-4111-8111-111111111111', BOB = '22222222-2222-4222-8222-222222222222';
let priv: CryptoKey, otherPriv: CryptoKey, jwks: ReturnType<typeof createLocalJWKSet>;
const servers: http.Server[] = [];

beforeAll(async () => {
  const a = await generateKeyPair('ES256'), b = await generateKeyPair('ES256');
  priv = a.privateKey as CryptoKey; otherPriv = b.privateKey as CryptoKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(a.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] });
});
afterAll(() => { servers.forEach((s) => s.close()); });

const sign = (sub: string, o: { key?: CryptoKey; iss?: string; aud?: string; exp?: string | number; kid?: string } = {}) =>
  new SignJWT({ role: 'authenticated', email: `${sub.slice(0, 4)}@example.com` }).setProtectedHeader({ alg: 'ES256', kid: o.kid ?? 'k1' })
    .setSubject(sub).setIssuer(o.iss ?? ISS).setAudience(o.aud ?? 'authenticated').setIssuedAt().setExpirationTime(o.exp ?? '1h').sign(o.key ?? priv);

/** One hosted-server instance with one storage file per user. */
async function host() {
  const stores = new Map<string, ReturnType<typeof memoryStore>>();
  const storeFor = (u: string) => stores.get(u) ?? (stores.set(u, memoryStore()), stores.get(u)!);
  const s = http.createServer(createCloudHandler({ ...perUser({ authenticate: bearerAuth(PROJECT, jwks), storeFor, masterKey: MASTER }), today: () => '2026-03-10' })).listen(0);
  servers.push(s); await new Promise((r) => s.once('listening', r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const call = (path: string, token?: string, json?: unknown) => fetch(base + path, {
    method: json === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const add = (t: string, merchant: string) => call('/api/transactions', t, { amount_paise: 1000, merchant_raw: merchant, occurred_at: '2026-03-09T10:00:00' });
  const txs = async (t: string) => ((await (await call('/api/transactions?month=2026-03', t)).json()) as Array<{ merchant_raw: string }>).map((x) => x.merchant_raw);
  return { call, add, txs, stores };
}

describe('every user gets their own data', () => {
  it('two people signed in at once never see each other, and each has a different identity', async () => {
    const h = await host(); const [a, b] = [await sign(ALICE), await sign(BOB)];
    expect((await h.add(a, 'Alice Only')).status).toBe(201);
    expect(await h.txs(b)).toEqual([]);                      // Bob sees nothing of Alice's
    expect((await h.add(b, 'Bob Only')).status).toBe(201);
    expect(await h.txs(a)).toEqual(['Alice Only']);
    expect(await h.txs(b)).toEqual(['Bob Only']);
    const ida = (await (await h.call('/api/identity', a)).json()) as { id: string };
    const idb = (await (await h.call('/api/identity', b)).json()) as { id: string };
    expect(ida.id).not.toBe(idb.id);
    expect([...h.stores.keys()].sort()).toEqual([ALICE, BOB]); // two separate files
  });

  it('their files are encrypted under different keys: one user\'s key cannot open another\'s file', async () => {
    const h = await host(); const [a, b] = [await sign(ALICE), await sign(BOB)];
    await h.add(a, 'Secret Alice Biryani'); await h.add(b, 'Secret Bob Dosa');
    const aliceFile = h.stores.get(ALICE)!.peek()!.data.toString('utf8');
    expect(aliceFile).not.toContain('Biryani');
    expect(() => decrypt(aliceFile, keyFor(MASTER, ALICE))).not.toThrow();
    expect(() => decrypt(aliceFile, keyFor(MASTER, BOB))).toThrow();          // Bob's key
    expect(() => decrypt(aliceFile, MASTER)).toThrow();                       // even the master key itself does not open it directly
  });

  it('a returning user finds their data after a cold start, on a fresh instance', async () => {
    const h1 = await host(); const a = await sign(ALICE);
    await h1.add(a, 'Persisted');
    // a new instance over the SAME storage (a cold start): copy the stores across
    const s2 = http.createServer(createCloudHandler({ ...perUser({ authenticate: bearerAuth(PROJECT, jwks), storeFor: (u) => h1.stores.get(u)!, masterKey: MASTER }), today: () => '2026-03-10' })).listen(0);
    servers.push(s2); await new Promise((r) => s2.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${(s2.address() as AddressInfo).port}/api/transactions?month=2026-03`, { headers: { authorization: `Bearer ${a}` } });
    expect(((await res.json()) as Array<{ merchant_raw: string }>).map((x) => x.merchant_raw)).toEqual(['Persisted']);
  });
});

describe('only genuine sign-in tokens are accepted', () => {
  it('rejects a missing, malformed, expired, forged, mis-issued or mis-addressed token', async () => {
    const h = await host();
    const bad: Array<[string, string | undefined]> = [
      ['no token', undefined],
      ['garbage', 'not-a-jwt'],
      ['expired', await sign(ALICE, { exp: Math.floor(Date.now() / 1000) - 60 })],
      ['signed by someone else\'s key', await sign(ALICE, { key: otherPriv })],
      ['another project\'s issuer', await sign(ALICE, { iss: 'https://evil.supabase.co/auth/v1' })],
      ['wrong audience (an anonymous-role token)', await sign(ALICE, { aud: 'anon' })],
      ['unknown key id', await sign(ALICE, { kid: 'other' })],
      ['a subject that is not a user id (path tricks)', await sign('../../etc/passwd')],
    ];
    for (const [why, token] of bad) expect([why, (await h.call('/api/bootstrap', token)).status]).toEqual([why, 401]);
    // a good token still works, and nothing was created for any of the rejected ones
    expect((await h.call('/api/bootstrap', await sign(ALICE))).status).toBe(200);
    expect([...h.stores.keys()]).toEqual([ALICE]);
  });

  it('rejects a token whose payload was edited after signing', async () => {
    const h = await host(); const [head, , sig] = (await sign(ALICE)).split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: BOB, iss: ISS, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    expect((await h.call('/api/bootstrap', `${head}.${forgedPayload}.${sig}`)).status).toBe(401);
    expect(h.stores.has(BOB)).toBe(false);
  });

  it('says WHY it refused (a rule, never a secret), so a misconfiguration is obvious', async () => {
    const h = await host();
    const reason = async (token?: string) => ((await (await h.call('/api/bootstrap', token)).json()) as { detail?: string }).detail;
    expect(await reason()).toContain('no sign-in token');
    expect(await reason(await sign(ALICE, { exp: Math.floor(Date.now() / 1000) - 60 }))).toContain('expired');
    expect(await reason(await sign(ALICE, { aud: 'anon' }))).toContain('"aud"');
    expect(await reason(await sign(ALICE, { iss: 'https://evil.supabase.co/auth/v1' }))).toContain('"iss"');
    expect(await reason(await sign(ALICE, { key: otherPriv }))).toContain('not signed by');
    expect(await reason('not-a-jwt')).toContain('could not be read');
  });

  it('locks a client out after repeated bad tokens (even a good one), but health stays open', async () => {
    const h = await host();
    for (let i = 0; i < 10; i++) expect((await h.call('/api/bootstrap', 'bad-' + i)).status).toBe(401);
    expect((await h.call('/api/bootstrap', await sign(ALICE))).status).toBe(429);
    expect((await h.call('/api/health')).status).toBe(200);
  });
});
