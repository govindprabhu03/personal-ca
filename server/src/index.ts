import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './app';
import { openDb } from './db';

const file = process.env.CA_DB ?? path.join(__dirname, '..', 'data', 'ca.db');
if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1'; // loopback by default: your money data stays on this machine
const token = process.env.CA_API_TOKEN;
if (host !== '127.0.0.1' && host !== 'localhost' && !token) {
  console.error('Refusing to listen on the network without CA_API_TOKEN set (this is your money data).');
  process.exit(1);
}

createApp(openDb(file), { token }).listen(port, host, () => console.log(`Personal CA API on http://${host}:${port}  (db: ${file})`));
