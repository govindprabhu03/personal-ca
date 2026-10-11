// Where a hosted server keeps its database when the host has no persistent disk (Vercel Functions): ONE encrypted blob in an object store.
// Every save says which version it is replacing, so two instances can never silently overwrite each other.
import { BlobNotFoundError, BlobPreconditionFailedError, get, head, put } from '@vercel/blob';

/** Someone else saved first. The caller discards its work and the client retries. */
export class ConflictError extends Error {}

export type Loaded = { data: Buffer; version: string } | { unchanged: true } | null;
export interface Store {
  /** The stored bytes and their version; `{unchanged}` when `since` is still current (so nothing is downloaded); null when nothing was ever saved. */
  load(since?: string | null): Promise<Loaded>;
  /** Replace the stored bytes only if the version is still `expected` (null: it must not exist yet). Throws ConflictError otherwise. Returns the new version. */
  save(data: Buffer, expected: string | null): Promise<string>;
  /** A spare copy kept under a slot name (the handler uses weekday names, so a week of copies exists with nothing to prune). */
  archive?(slot: string, data: Buffer): Promise<void>;
}

/** Vercel Blob, private access. Needs BLOB_READ_WRITE_TOKEN (Vercel adds it when the store is connected to the project). */
export function blobStore(prefix = 'personalca'): Store {
  const main = `${prefix}/db.bin`;
  // An explicit token wins: left to itself the SDK prefers the project's OIDC identity whenever BLOB_STORE_ID is also set.
  const auth = () => (process.env.BLOB_READ_WRITE_TOKEN ? { token: process.env.BLOB_READ_WRITE_TOKEN } : {});
  // The version is ALWAYS the ETag that head() reports (the form ifMatch is documented to take), never one read from a download.
  const etag = async (): Promise<string | null> => {
    try { return (await head(main, auth())).etag; } catch (e) { if (e instanceof BlobNotFoundError) return null; throw e; }
  };
  return {
    async load(since) {
      const version = await etag();
      if (version === null) return null;
      if (version === since) return { unchanged: true };
      const r = await get(main, { ...auth(), access: 'private', useCache: false });
      if (!r || r.statusCode !== 200) return null;
      // (if the blob changed between the two calls we hold a newer body under an older version: the next save then conflicts and the client retries, which is safe)
      return { data: Buffer.from(await new Response(r.stream).arrayBuffer()), version };
    },
    async save(data, expected) {
      let r: Awaited<ReturnType<typeof put>>;
      try {
        r = await put(main, data, { ...auth(), access: 'private', contentType: 'application/octet-stream', addRandomSuffix: false, allowOverwrite: expected !== null, ...(expected ? { ifMatch: expected } : {}) });
      } catch (e) {
        if (e instanceof BlobPreconditionFailedError || (expected === null && /already exists/i.test(String((e as Error)?.message)))) {
          throw new ConflictError(`expected version ${expected}, the store has ${await etag().catch(() => '?')}`);
        }
        throw e;
      }
      return r.etag; // (saves one round trip; the next request's head() reports the same form, or just reloads once if it ever differs)
    },
    async archive(slot, data) {
      await put(`${prefix}/backup-${slot}.bin`, data, { ...auth(), access: 'private', contentType: 'application/octet-stream', addRandomSuffix: false, allowOverwrite: true });
    },
  };
}

/** An in-process store with the same contract, for tests (and a way to inject failures). */
export function memoryStore() {
  let cur: { data: Buffer; version: string } | null = null, n = 0;
  const s = {
    saves: 0, loads: 0, failSaves: 0, beforeSave: undefined as undefined | (() => Promise<void>), archives: new Map<string, Buffer>(),
    peek: () => cur,
    async load(since?: string | null): Promise<Loaded> {
      s.loads++;
      if (!cur) return null;
      return since === cur.version ? { unchanged: true } : { data: cur.data, version: cur.version };
    },
    async save(data: Buffer, expected: string | null) {
      await s.beforeSave?.(); // lets a test make another instance save in the gap between this request's load and its save
      if ((cur?.version ?? null) !== expected) throw new ConflictError('the stored data changed under us');
      if (s.failSaves > 0) { s.failSaves--; throw new Error('storage unavailable'); }
      cur = { data, version: String(++n) }; s.saves++;
      return cur.version;
    },
    async archive(slot: string, data: Buffer) { s.archives.set(slot, data); },
  };
  return s;
}
