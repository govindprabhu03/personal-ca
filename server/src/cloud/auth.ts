// Who is calling the hosted server, and which encrypted file is theirs.
import { createHash, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface Principal { userId: string; email?: string }
/** Why a sign-in was refused: safe to show (it names a rule, never a secret), and it makes a misconfiguration obvious instead of a bare 401. */
export interface Denied { denied: string }
export type Authenticate = (req: IncomingMessage) => Promise<Principal | Denied | null>;

const reasonFor = (e: unknown): string => {
  const { code, claim } = e as { code?: string; claim?: string };
  if (code === 'ERR_JWT_EXPIRED') return 'the sign-in token has expired';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') return `the token's "${claim ?? 'claim'}" is not what this server expects`;
  if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' || code === 'ERR_JWKS_NO_MATCHING_KEY') return 'the token was not signed by the sign-in service this server trusts';
  if (code === 'ERR_JOSE_ALG_NOT_ALLOWED') return 'the token uses a signing algorithm this server does not accept';
  if (code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JWKS_INVALID') return `could not fetch the public keys of the sign-in service`;
  return 'the token could not be read';
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sign-in tokens issued by Supabase Auth (email + password, Google). They are signed with a private key only Supabase holds; their public
 * keys are published at <project>/auth/v1/.well-known/jwks.json, so this server verifies them without sharing any secret.
 * A token is accepted only if it is genuinely signed, unexpired, issued by THIS project, and meant for signed-in users.
 */
export function bearerAuth(projectUrl: string, keys?: JWTVerifyGetKey): Authenticate {
  const issuer = `${projectUrl.replace(/\/+$/, '')}/auth/v1`;
  const jwks = keys ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cooldownDuration: 30_000 });
  return async (req) => {
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) return { denied: 'no sign-in token was sent' };
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated', algorithms: ['ES256', 'RS256'] });
      // user ids are UUIDs: checking the shape also guarantees the id is safe to use inside a storage path
      if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) return { denied: 'the token does not name a valid user' };
      return { userId: payload.sub.toLowerCase(), email: typeof payload.email === 'string' ? payload.email : undefined };
    } catch (e) { return { denied: reasonFor(e) }; }
  };
}

/** Single-owner mode: one shared access token (as the home-PC server does), everything belongs to one "owner". */
export function tokenAuth(token: string): Authenticate {
  const want = createHash('sha256').update(token).digest();
  return async (req) => {
    const got = createHash('sha256').update(String(req.headers['x-api-key'] ?? '')).digest();
    return timingSafeEqual(got, want) ? { userId: 'owner' } : null;
  };
}

/** One encryption key per user, derived from the master key: another user's copy of a file cannot be opened with the wrong key. */
export const keyFor = (master: string, userId: string): string =>
  Buffer.from(hkdfSync('sha256', master, 'personalca-v1', `user:${userId}`, 32)).toString('base64');
