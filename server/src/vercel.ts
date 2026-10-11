// The entry point on Vercel: one serverless function that serves the whole API (see cloud/handler.ts for how the database is kept).
// Needs on the Vercel project: CA_DATA_KEY (master key: each user's data is encrypted under a key derived from it) and a private Blob store
// (BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID so the SDK uses the project's OIDC identity). Then EITHER SUPABASE_URL (many users sign in with
// email or Google; each gets their own file) OR CA_API_TOKEN (one owner with one shared token). ANTHROPIC_API_KEY is optional (Ask your CA).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerAuth } from './cloud/auth';
import { createCloudHandler, perUser, singleOwner } from './cloud/handler';
import { blobStore } from './cloud/store';
import { createLogger } from './log';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
let handler: Handler | undefined;

function build(): Handler {
  const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set on this deployment`); return v; };
  const masterKey = need('CA_DATA_KEY');
  if (masterKey.length < 24) throw new Error('CA_DATA_KEY is too short (use at least 24 random characters)');
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) throw new Error('no Blob store: connect one to the project (BLOB_READ_WRITE_TOKEN) or set BLOB_STORE_ID');
  const log = createLogger(undefined, { consoleFrom: 'info' });
  const supabase = process.env.SUPABASE_URL;
  if (supabase) { // many users: each signs in (email or Google) and gets their own encrypted file
    return createCloudHandler({ ...perUser({ authenticate: bearerAuth(supabase), storeFor: (userId) => blobStore(`personalca/users/${userId}`), masterKey }), log, trustProxy: 1 });
  }
  const token = need('CA_API_TOKEN'); // one owner, one shared access token
  if (token.length < 24) throw new Error('CA_API_TOKEN is too short (use at least 24 random characters)');
  return createCloudHandler({ ...singleOwner({ store: blobStore(), dataKey: masterKey, token }), log, trustProxy: 1 });
}

export default async function main(req: IncomingMessage, res: ServerResponse) {
  try { handler ??= build(); } catch (e) { // a clear answer instead of a crash page
    console.error(`not configured: ${(e as Error).message}`);
    res.statusCode = 503; res.setHeader('content-type', 'application/json');
    return void res.end(JSON.stringify({ error: 'The server is not configured yet.', code: 'not_configured' }));
  }
  return handler(req, res);
}
