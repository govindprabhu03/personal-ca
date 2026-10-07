// The server-only parts of the service. They need Node (crypto, PDF parsing), so they can't run on the phone.
// Everything else (shared/core/service.ts) is the same code on both sides.
import { categorise } from '../../shared/categorise';
import { ctx, createTx, exportTables, get, HttpError, importTables, run } from '../../shared/core/service';
import type { DB } from '../../shared/core/schema';
import type { ImportResult, ImportRow } from '../../shared/types';
import { decrypt, encrypt } from './engine/crypto';
import { parsePdfStatement, PdfError } from './engine/pdf';
import { parseStatement, StatementRow } from './engine/statement';

/** CSV text or a PDF (optionally password-protected) -> the same rows -> the same preview/commit. */
export async function importStatement(db: DB, src: { csv?: string; pdf?: Uint8Array; password?: string }, accountId: number | undefined, commit: boolean, includeCredits: boolean): Promise<ImportResult> {
  let rows: StatementRow[], header_found = true, warnings: string[] = [];
  if (src.pdf) {
    try { ({ rows, warnings } = await parsePdfStatement(src.pdf, src.password)); }
    catch (e) { if (e instanceof PdfError) throw new HttpError(422, e.message, e.code); throw e; }
  } else ({ rows, header_found } = parseStatement(src.csv ?? ''));
  const c = ctx(db, 12);
  const out: ImportRow[] = [];
  let credits = 0, dups = 0, imported = 0;
  const exists = (hash: string) => !!get(db, 'SELECT 1 AS x FROM transactions WHERE import_hash = ? UNION SELECT 1 FROM income WHERE import_hash = ?', hash, hash);
  if (commit) db.exec('BEGIN');
  try {
    for (const r of rows) {
      const dup = exists(r.hash);
      if (r.direction === 'credit') {
        if (!includeCredits) { credits++; continue; }
        if (dup) { dups++; continue; }
        if (commit) { addIncomeRow(db, r.amount_paise, r.occurred_at, r.narration, accountId, r.hash); imported++; }
        continue;
      }
      const v = categorise(r.narration, '', c);
      out.push({ occurred_at: r.occurred_at, narration: r.narration, merchant: v.merchant_norm, amount_paise: r.amount_paise, category_name: v.category,
        bucket: v.bucket, confidence: v.confidence, payment_method: r.payment_method, duplicate: dup });
      if (dup) { dups++; continue; }
      if (commit) {
        createTx(db, { amount_paise: r.amount_paise, merchant_raw: r.narration, occurred_at: r.occurred_at, payment_method: r.payment_method,
          account_id: accountId, source: 'statement', import_hash: r.hash });
        imported++;
      }
    }
    if (commit) db.exec('COMMIT');
  } catch (e) { if (commit) db.exec('ROLLBACK'); throw e; }
  return { committed: commit, rows: out, imported, duplicates: dups, credits_skipped: credits, header_found, format: src.pdf ? 'pdf' : 'csv', warnings };
}
function addIncomeRow(db: DB, paise: number, at: string, source: string, accountId: number | undefined, hash: string) {
  const acc = accountId ?? get<{ id: number }>(db, 'SELECT id FROM accounts ORDER BY id LIMIT 1')!.id;
  run(db, 'INSERT INTO income (account_id, amount_paise, received_at, source, is_regular, import_hash) VALUES (?,?,?,?,0,?)', acc, paise, at, source, hash);
}

/** Encrypted backup: the whole database, AES-256-GCM under your passphrase. */
export const backup = (db: DB, passphrase: string): string => encrypt(JSON.stringify(exportTables(db)), passphrase);
export function restore(db: DB, blob: string, passphrase: string) {
  let data;
  try { data = JSON.parse(decrypt(blob, passphrase)); } catch { throw new HttpError(400, 'wrong passphrase or damaged backup'); }
  importTables(db, data);
}
