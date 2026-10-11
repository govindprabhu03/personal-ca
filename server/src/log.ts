// A tiny logger: one line per event, to the console and (when given a folder) to a daily file, keeping the last 14 days.
// It never logs request bodies, tokens or amounts: only what happened, to which route, and how it ended.
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string, err?: unknown): void; file?: string };

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** `consoleFrom`: which levels also print to the console (INFO never does; callers use console.log for the friendly banner). */
export function createLogger(dir?: string, opts: { keepDays?: number; consoleFrom?: 'info' | 'warn' | 'error' | 'never' } = {}): Logger {
  const keep = opts.keepDays ?? 14;
  const from = opts.consoleFrom ?? 'warn';
  const toConsole = (level: string) => from === 'info' || (from === 'warn' ? level !== 'INFO' : from === 'error' && level === 'ERROR');
  let dirOk = false;
  if (dir) { try { mkdirSync(dir, { recursive: true }); dirOk = true; prune(dir, keep); } catch { /* logging must never stop the app */ } }
  const write = (level: string, msg: string) => {
    const now = new Date();
    const line = `${stamp(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${level} ${msg}`;
    if (toConsole(level)) console.error(line);
    if (dir && dirOk) { try { appendFileSync(path.join(dir, `personalca-${stamp(now)}.log`), line + '\n'); } catch { /* disk full / locked: carry on */ } }
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m, err) => write('ERROR', err ? `${m}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}` : m),
    file: dir ? path.join(dir, `personalca-${stamp(new Date())}.log`) : undefined,
  };
}

function prune(dir: string, keep: number) {
  const files = readdirSync(dir).filter((f) => /^personalca-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) { try { unlinkSync(path.join(dir, f)); } catch { /* in use */ } }
}

export const quietLogger: Logger = { info() {}, warn() {}, error() {} };
