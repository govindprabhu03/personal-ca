// The entry point on Vercel: one serverless function that serves the whole API (see cloud/handler.ts for how the database is kept).
// Needs three settings on the Vercel project: CA_API_TOKEN (what the phone sends), CA_DATA_KEY (encrypts the database at rest) and a Blob store
// connected to the project (adds BLOB_READ_WRITE_TOKEN). ANTHROPIC_API_KEY is optional (Ask your CA).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCloudHandler } from './cloud/handler';
import { blobStore } from './cloud/store';
import { createLogger } from './log';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
let handler: Handler | undefined;

function build(): Handler {
  const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set on this deployment`); return v; };
  if (need('CA_DATA_KEY').length < 24) throw new Error('CA_DATA_KEY is too short (use at least 24 random characters)');
  if (need('CA_API_TOKEN').length < 24) throw new Error('CA_API_TOKEN is too short (use at least 24 random characters)');
  need('BLOB_READ_WRITE_TOKEN');
  return createCloudHandler({ store: blobStore(), dataKey: need('CA_DATA_KEY'), token: need('CA_API_TOKEN'), log: createLogger(undefined, { consoleFrom: 'info' }), trustProxy: 1 });
}

export default async function main(req: IncomingMessage, res: ServerResponse) {
  try { handler ??= build(); } catch (e) { // a clear answer instead of a crash page
    console.error(`not configured: ${(e as Error).message}`);
    res.statusCode = 503; res.setHeader('content-type', 'application/json');
    return void res.end(JSON.stringify({ error: 'The server is not configured yet.', code: 'not_configured' }));
  }
  return handler(req, res);
}
