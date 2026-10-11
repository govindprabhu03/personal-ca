// The entry point of PersonalCA.exe (a Node single-executable): the API server AND the web version of the app in one program.
//   - your data lives in %APPDATA%\PersonalCA (override with PERSONALCA_HOME): ca.db, token.txt, backups\ (daily copies), logs\
//   - listens on your network so the phone app can sync, but every API call needs the token (never open)
//   - opens the app in your browser; closing this window stops the server
//   Options:  --local-only (this PC only, no phone)   --no-browser
import { exec } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { createApp } from './app';
import { dailyBackup, openDb } from './db';
import { createLogger } from './log';
import { diskAssets, seaAssets } from './web';

const VERSION = '1.0.0';

function pauseThenExit(code: number) {
  console.log('\nPress Enter to close this window.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(code));
}
const open = (url: string) => exec(process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);

const home = process.env.PERSONALCA_HOME ?? path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'PersonalCA');
// Errors print to this window; everything (warnings too) goes to logs\personalca-DATE.log, 14 days kept.
const log = createLogger(path.join(home, 'logs'), { consoleFrom: 'error' });
process.on('unhandledRejection', (e) => log.error('unhandled rejection (carrying on)', e));
process.on('uncaughtException', (e) => { log.error('crashed', e); console.error('\n  Personal CA hit an unexpected error. Details are in the log file:\n  ' + log.file); pauseThenExit(1); });

try {
  const args = process.argv.slice(2);
  mkdirSync(home, { recursive: true });
  const tokenFile = path.join(home, 'token.txt');
  let token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
  if (!token) { token = randomBytes(18).toString('base64url'); writeFileSync(tokenFile, token); }

  const port = Number(process.env.PORT ?? 8787);
  const localOnly = args.includes('--local-only');
  const web = seaAssets() ?? (process.env.PERSONALCA_WEB ? diskAssets(process.env.PERSONALCA_WEB) : null);
  const db = openDb(path.join(home, 'ca.db'));
  const url = `http://localhost:${port}`;

  // A dated copy of your data once a day (the first start of the day, then every 6 hours while it stays open); the newest 14 are kept.
  const backup = () => { try { const f = dailyBackup(db, path.join(home, 'backups')); if (f) log.info(`backup written: ${f}`); } catch (e) { log.error('backup failed', e); } };
  backup();
  setInterval(backup, 6 * 3600_000).unref();

  const app = createApp(db, { token, web, log });
  const server = app.listen(port, localOnly ? '127.0.0.1' : '0.0.0.0', () => {
    const lan = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i!.address}:${port}`);
    log.info(`started v${VERSION} on port ${port}${localOnly ? ' (this PC only)' : ''}`);
    console.log(`\n  Personal CA ${VERSION} is running.\n`);
    console.log(`  Open it here:       ${url}${web ? '' : '   (this build has no web app inside)'}`);
    if (!localOnly) {
      console.log(`  For the phone app:  ${lan.join('   or   ') || '(connect to Wi-Fi first)'}`);
      console.log(`  Access token:       ${token}`);
      console.log('                      (also shown on the web page: More > Connect to your PC)');
    }
    console.log(`  Your data:          ${home}`);
    console.log('  Daily backups:      backups\\   Logs: logs\\   (inside the folder above)');
    console.log('\n  Keep this window open while you use the app. Close it to stop.\n');
    if (!args.includes('--no-browser')) open(url);
  });
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') { console.log(`\n  Personal CA is already running (port ${port} is taken). Opening it...`); open(url); setTimeout(() => process.exit(0), 1500); return; }
    log.error('could not start', e); console.error(`\n  Could not start: ${e.message}`); pauseThenExit(1);
  });

  // Ctrl+C or closing the window: finish in-flight requests, fold the write-ahead log into the main file, then exit.
  let stopping = false;
  const stop = (why: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`stopping (${why})`);
    const done = () => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch { /* already closed */ } process.exit(0); };
    server.close(done);
    server.closeAllConnections();
    setTimeout(done, 3000).unref();
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => stop(sig));
} catch (e) {
  log.error('could not start', e);
  console.error(`\n  Could not start: ${(e as Error).message}`);
  pauseThenExit(1);
}
