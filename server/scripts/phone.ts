// One command to run the API for a REAL phone:   npm run phone
//   - listens on your network (never without a token: this is your money data)
//   - makes a private access token the first time and remembers it (server/data/.phone-token)
//   - writes the SAME token into mobile/.env so the app and the server agree
//   - prints what to do next
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

const dataDir = path.join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });
const tokenFile = path.join(dataDir, '.phone-token');
let token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
if (!token) { token = randomBytes(18).toString('base64url'); writeFileSync(tokenFile, token); }

// keep anything else already in mobile/.env, replace only our line
const envFile = path.join(__dirname, '..', '..', 'mobile', '.env');
const keep = existsSync(envFile) ? readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('EXPO_PUBLIC_API_TOKEN=')) : [];
writeFileSync(envFile, [...keep, `EXPO_PUBLIC_API_TOKEN=${token}`].join('\n') + '\n');

const port = process.env.PORT ?? '8787';
const lan = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
console.log('\n📱 Personal CA, phone mode');
console.log(`   Token written to mobile/.env (EXPO_PUBLIC_API_TOKEN). Server listens on all networks, port ${port}.`);
console.log(`   Reachable from your phone at: ${lan.map((a) => `http://${a}:${port}`).join('  or  ') || '(no network found: connect to Wi-Fi)'}`);
console.log('   Next, in a SECOND terminal:  cd mobile  &&  npx expo start -c   then scan the QR code with Expo Go.');
console.log('   (Phone and PC must be on the same Wi-Fi. Press Ctrl+C here to stop the server.)\n');

process.env.HOST = '0.0.0.0';
process.env.CA_API_TOKEN = token;
void import('../src/index');
