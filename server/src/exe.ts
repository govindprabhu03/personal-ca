// The entry point of PersonalCA.exe (a Node single-executable): the API server AND the web version of the app in one program.
//   - your data lives in %APPDATA%\PersonalCA (override with PERSONALCA_HOME): ca.db + token.txt
//   - listens on your network so the phone app can sync, but every API call needs the token (never open)
//   - opens the app in your browser; closing this window stops the server
//   Options:  --local-only (this PC only, no phone)   --no-browser
import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { createApp } from './app';
import { openDb } from './db';
import { diskAssets, seaAssets } from './web';

function pauseThenExit(code: number) {
  console.log('\nPress Enter to close this window.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(code));
}
const open = (url: string) => exec(process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);

try {
  const args = process.argv.slice(2);
  const home = process.env.PERSONALCA_HOME ?? path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'PersonalCA');
  mkdirSync(home, { recursive: true });
  const tokenFile = path.join(home, 'token.txt');
  let token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
  if (!token) { token = randomBytes(18).toString('base64url'); writeFileSync(tokenFile, token); }

  const port = Number(process.env.PORT ?? 8787);
  const localOnly = args.includes('--local-only');
  const web = seaAssets() ?? (process.env.PERSONALCA_WEB ? diskAssets(process.env.PERSONALCA_WEB) : null);
  const app = createApp(openDb(path.join(home, 'ca.db')), { token, web });
  const url = `http://localhost:${port}`;

  const server = app.listen(port, localOnly ? '127.0.0.1' : '0.0.0.0', () => {
    const lan = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i!.address}:${port}`);
    console.log('\n  Personal CA is running.\n');
    console.log(`  Open it here:       ${url}${web ? '' : '   (this build has no web app inside)'}`);
    if (!localOnly) {
      console.log(`  For the phone app:  ${lan.join('   or   ') || '(connect to Wi-Fi first)'}`);
      console.log(`  Access token:       ${token}`);
      console.log('                      (also shown on the web page: More > Connect to your PC)');
    }
    console.log(`  Your data:          ${home}`);
    console.log('\n  Keep this window open while you use the app. Close it to stop.\n');
    if (!args.includes('--no-browser')) open(url);
  });
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') { console.log(`\n  Personal CA is already running (port ${port} is taken). Opening it...`); open(url); setTimeout(() => process.exit(0), 1500); return; }
    console.error(`\n  Could not start: ${e.message}`); pauseThenExit(1);
  });
} catch (e) {
  console.error(`\n  Could not start: ${(e as Error).message}`);
  pauseThenExit(1);
}
