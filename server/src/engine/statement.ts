// Statement import: bank / UPI-app CSV -> clean rows. Every bank's layout differs, so we sniff the header row
// by column-name aliases instead of hard-coding one bank. Re-importing the same file is safe (stable row hashes).
import { createHash } from 'node:crypto';
import type { PaymentMethod } from '../../../shared/types';
import { pad } from './dates';

export interface StatementRow {
  occurred_at: string; narration: string; amount_paise: number; direction: 'debit' | 'credit';
  payment_method: PaymentMethod; hash: string;
}

export function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, '');
  const head = text.split(/\r?\n/).slice(0, 10).join('\n');
  const delim = [',', ';', '\t'].map((d) => [d, head.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Many formats -> "YYYY-MM-DDTHH:mm:ss". No time on the statement => noon, so it can never look "late night". */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, mo: number, d: number, rest: string;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; rest = m[4]; }
  else if ((m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})(.*)$/))) { // "Oct 05, 2026" (UPI-app exports)
    mo = MON[m[1].slice(0, 3).toLowerCase()]; d = +m[2]; y = +m[3]; rest = m[4];
  } else {
    m = s.match(/^(\d{1,2})[/\-. ]([A-Za-z]{3,9}|\d{1,2})[/\-. ,]+(\d{2,4})(.*)$/);
    if (!m) return null;
    d = +m[1]; mo = /^\d+$/.test(m[2]) ? +m[2] : MON[m[2].slice(0, 3).toLowerCase()]; y = +m[3]; rest = m[4];
    if (y < 100) y += 2000;
  }
  if (!mo || mo > 12 || d < 1 || d > 31) return null;
  const t = rest.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  let hh = t ? +t[1] : 12;
  if (t?.[4]) hh = (hh % 12) + (t[4].toLowerCase() === 'pm' ? 12 : 0);
  return `${y}-${pad(mo)}-${pad(d)}T${t ? `${pad(hh)}:${t[2]}:${t[3] ?? '00'}` : '12:00:00'}`;
}

/** "1,250.50" / "(250)" / "-250" / "250 Dr" -> signed paise (+ direction if a Dr/Cr suffix is present). */
function amount(raw: string | undefined): { paise: number; dir?: 'debit' | 'credit' } | null {
  const t = (raw ?? '').replace(/[₹,\s]|INR|Rs\.?/gi, '');
  const m = t.match(/^(\()?(-)?(\d+(?:\.\d+)?)\)?(Dr|Cr)?$/i);
  if (!m) return null;
  const paise = Math.round(parseFloat(m[3]) * 100) * (m[1] || m[2] ? -1 : 1);
  return { paise, dir: m[4] ? (m[4].toLowerCase() === 'dr' ? 'debit' : 'credit') : undefined };
}

const find = (header: string[], re: RegExp) => header.findIndex((h) => re.test(h.trim()));

function methodOf(n: string): PaymentMethod {
  if (/\bupi\b/i.test(n)) return 'upi';
  if (/\batm\b|cash/i.test(n)) return 'cash';
  if (/\bpos\b|\becom\b|card/i.test(n)) return 'card';
  return 'netbanking';
}

export function parseStatement(csv: string): { rows: StatementRow[]; header_found: boolean } {
  const grid = parseCsv(csv);
  for (let h = 0; h < Math.min(grid.length, 40); h++) {
    const hd = grid[h].map((c) => c.trim());
    const di = find(hd, /^(txn\.?|transaction|tran|value|posting)?\s*date$/i);
    const ni = find(hd, /narration|description|particulars|details|remarks/i);
    const wi = find(hd, /withdraw|debit/i), ci = find(hd, /deposit|credit/i);
    const ai = find(hd, /^(txn |transaction )?amount( \(inr\))?$/i), ti = find(hd, /^(dr\/cr|cr\/dr|type)$/i);
    if (di < 0 || ni < 0 || (wi < 0 && ci < 0 && ai < 0)) continue;

    const rows: RawRow[] = [];
    for (const r of grid.slice(h + 1)) {
      const occurred_at = parseDate(r[di] ?? '');
      if (!occurred_at) continue; // totals / footer / blank lines
      let paise = 0, direction: 'debit' | 'credit' | null = null;
      const w = wi >= 0 ? amount(r[wi]) : null, c = ci >= 0 ? amount(r[ci]) : null;
      if (w && w.paise) { paise = Math.abs(w.paise); direction = 'debit'; }
      else if (c && c.paise) { paise = Math.abs(c.paise); direction = 'credit'; }
      else if (ai >= 0) {
        const a = amount(r[ai]);
        if (!a || !a.paise) continue;
        paise = Math.abs(a.paise);
        const type = ti >= 0 ? (r[ti] ?? '').toLowerCase() : '';
        direction = /^(dr|debit|d)\b/.test(type) ? 'debit' : /^(cr|credit|c)\b/.test(type) ? 'credit' : a.dir ?? (a.paise < 0 ? 'debit' : 'credit');
      }
      if (!direction) continue;
      rows.push({ occurred_at, narration: (r[ni] ?? '').trim(), amount_paise: paise, direction });
    }
    return { rows: buildRows(rows), header_found: true };
  }
  return { rows: [], header_found: false };
}

export interface RawRow { occurred_at: string; narration: string; amount_paise: number; direction: 'debit' | 'credit' }

/** Adds payment method and a stable hash. The nth identical row in a file gets #n, so two real identical chais survive
 *  but re-importing the same file is still detected. CSV and PDF both go through here, so de-duplication behaves the same. */
export function buildRows(list: RawRow[]): StatementRow[] {
  const seen = new Map<string, number>();
  return list.map((r) => {
    const base = createHash('sha1').update(`${r.occurred_at}|${r.amount_paise}|${r.direction}|${r.narration}`).digest('hex');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...r, payment_method: methodOf(r.narration), hash: `${base}#${n}` };
  });
}
