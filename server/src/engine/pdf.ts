// PDF statement import. Works on PDFs with a real text layer (what banks email you). Scanned images need OCR: not supported.
//
// Bank layouts differ, so instead of one template we rebuild each page's visual lines and read them with layered rules:
//   row start   = a line that begins with a date and carries at least one 2-decimal amount
//   narration   = the text cells between the date and the amounts (wrapped lines under it are merged back in)
//   direction   = (1) explicit Dr/Cr marker, (2) balance going up or down vs the previous row,
//                 (3) which header column (Withdrawal vs Deposit) the amount sits under, (4) assume debit, and say so.
// Whenever balances are printed we also check they add up, so missing or misread rows are reported, not silently accepted.
import { buildRows, parseDate, RawRow, StatementRow } from './statement';

export type PdfErrorCode = 'pdf_password_required' | 'pdf_password_wrong' | 'pdf_no_text' | 'pdf_unrecognised' | 'pdf_unreadable';
export class PdfError extends Error { constructor(public code: PdfErrorCode, msg: string) { super(msg); } }

interface Item { s: string; x: number; x1: number; y: number }
interface Line { items: Item[]; text: string; offsets: number[]; y: number }

const DATE_AT_START = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[/\-. ](?:\d{1,2}|[A-Za-z]{3,9})[/\-. ,]+\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?)?/i;
const AMOUNT = /^(?:₹|Rs\.?|INR)?\s?(\(?-?\d[\d,]*\.\d{2}\)?)\s?(Cr|Dr)?\.?$/i;
const VALUE_DATE = /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/;
const REF_NUMBER = /^(\d{6,}|0{2,}\d*)$/;
const NOISE = /^(page\s+\d+|statement\s+(of|period|date)|account\s+(no|number|statement|summary)|customer|ifsc|branch|generated|this is a computer|end of|closing balance|total|summary|continued)/i;
const OPENING = /opening balance|brought forward|b\/f/i;

async function readItems(data: Uint8Array, password?: string): Promise<Item[][]> {
  const { getDocumentProxy } = await import('unpdf');
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(data), password ? { password } : undefined);
  } catch (e: any) {
    if (e?.name === 'PasswordException')
      throw e.code === 2
        ? new PdfError('pdf_password_wrong', 'That password did not unlock the PDF. Banks often use your date of birth or PAN.')
        : new PdfError('pdf_password_required', 'This PDF is password protected. Enter its password to read it.');
    throw new PdfError('pdf_unreadable', "That doesn't look like a readable PDF.");
  }
  const pages: Item[][] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    pages.push(content.items.filter((i: any) => 'str' in i && i.str.trim()).map((i: any) => ({ s: i.str.trim(), x: i.transform[4], x1: i.transform[4] + i.width, y: i.transform[5] })));
  }
  return pages;
}

/** Group a page's text runs into visual lines (top to bottom, left to right). */
function toLines(items: Item[]): Line[] {
  const groups: { y: number; items: Item[] }[] = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.y - it.y) <= 2.5) last.items.push(it); else groups.push({ y: it.y, items: [it] });
  }
  return groups.map((g) => {
    const items = g.items.flatMap(words).sort((a, b) => a.x - b.x);
    let at = 0;
    const offsets = items.map((it) => { const o = at; at += it.s.length + 1; return o; });
    return { items, text: items.map((i) => i.s).join(' '), offsets, y: g.y };
  });
}

/** Some PDFs emit a whole row (or cell) as one text run. Split into words with estimated x positions so the rules below work either way. */
function words(it: Item): Item[] {
  const parts = it.s.split(/\s+/);
  if (parts.length === 1) return [it];
  const w = it.x1 - it.x;
  let pos = 0;
  return parts.map((p) => {
    const start = it.s.indexOf(p, pos);
    pos = start + p.length;
    return { s: p, y: it.y, x: it.x + (w * start) / it.s.length, x1: it.x + (w * pos) / it.s.length };
  });
}

const paise = (s: string) => {
  const neg = /^\(.*\)$|^-/.test(s);
  return (neg ? -1 : 1) * Math.round(parseFloat(s.replace(/[(),\s-]/g, '')) * 100);
};
const center = (i: Item) => (i.x + i.x1) / 2;

export interface PdfParse { rows: StatementRow[]; warnings: string[] }

export async function parsePdfStatement(data: Uint8Array, password?: string): Promise<PdfParse> {
  const pages = await readItems(data, password);
  if (pages.flat().reduce((n, i) => n + i.s.length, 0) < 20)
    throw new PdfError('pdf_no_text', 'This PDF has no readable text; it looks like a scan or photo. Download the CSV from your bank instead.');

  const lines = pages.map(toLines);
  const isHeader = (l: Line) => /\bdate\b/i.test(l.text) && /narration|description|particulars|details|remarks|transaction/i.test(l.text) && /withdraw|debit|deposit|credit|amount/i.test(l.text);
  const head = lines.flat().find(isHeader);
  const debitX = head?.items.find((i) => /withdraw|debit|^dr$/i.test(i.s)), creditX = head?.items.find((i) => /deposit|credit|^cr$/i.test(i.s));

  // A narration may wrap onto further lines; each piece remembers where its text ended (x1) so we can tell how to glue it back.
  const rows: { occurred_at: string; amount_paise: number; direction: 'debit' | 'credit'; narrX: number; chunks: { text: string; x1: number }[] }[] = [];
  let prevBalance: number | null = null, guessed = 0, mismatches = 0, anyMark = false;

  for (const pageLines of lines) {
    let current: (typeof rows)[number] | null = null;
    for (const line of pageLines) {
      if (isHeader(line)) { current = null; continue; }
      const m = line.text.match(DATE_AT_START);
      const when = m && parseDate(m[0]);

      if (!when) { // wrapped narration, an opening-balance line, or page furniture
        if (OPENING.test(line.text)) {
          const a = line.items.map((i) => i.s.match(AMOUNT)).filter(Boolean).pop();
          if (a) prevBalance = paise(a[1]);
          current = null;
        } else if (current && !NOISE.test(line.text) && Math.abs(line.items[0].x - current.narrX) <= 6 && !line.items.some((i) => AMOUNT.test(i.s))) {
          const parts = line.items.filter((i) => !REF_NUMBER.test(i.s));
          if (parts.length) current.chunks.push({ text: parts.map((i) => i.s).join(' '), x1: parts[parts.length - 1].x1 });
        } else current = null;
        continue;
      }

      const rest = line.items.filter((_, k) => line.offsets[k] >= m![0].length);
      const amounts: { it: Item; v: number; mark?: 'cr' | 'dr' }[] = [];
      const text: Item[] = [];
      let afterAmount = false;
      for (const it of rest) {
        const a = it.s.match(AMOUNT), sfx = it.s.match(/^(Cr|Dr)\.?$/i);
        if (a) { amounts.push({ it, v: paise(a[1]), mark: a[2]?.toLowerCase() as 'cr' | 'dr' | undefined }); afterAmount = true; continue; }
        if (sfx && afterAmount) { amounts[amounts.length - 1].mark ??= sfx[1].toLowerCase() as 'cr' | 'dr'; continue; } // "1,250.50 Dr"
        afterAmount = false;
        if (!VALUE_DATE.test(it.s) && !REF_NUMBER.test(it.s)) text.push(it);
      }
      if (!amounts.length) { current = null; continue; } // e.g. "01/03/2026 to 31/03/2026" statement-period line

      // which amount is the transaction, and which (if any) is the running balance?
      const hasBalance = amounts.length >= 2;
      const balance = hasBalance ? amounts[amounts.length - 1] : null;
      const txn = (hasBalance ? amounts.slice(0, -1) : amounts).find((a) => a.v !== 0);
      if (!txn) { if (balance) prevBalance = Math.abs(balance.v); current = null; continue; }
      const amt = Math.abs(txn.v);
      if (txn.mark) anyMark = true;

      let direction: 'debit' | 'credit' | null = txn.mark ? (txn.mark === 'cr' ? 'credit' : 'debit') : null;
      if (balance) {
        const bal = Math.abs(balance.v);
        if (prevBalance !== null) {
          const delta = bal - prevBalance;
          const byBalance = Math.abs(delta - amt) <= 1 ? 'credit' : Math.abs(delta + amt) <= 1 ? 'debit' : null;
          if (!byBalance) mismatches++;
          direction ??= byBalance;
        }
        prevBalance = bal;
      }
      if (!direction && debitX && creditX) direction = Math.abs(center(txn.it) - center(debitX)) <= Math.abs(center(txn.it) - center(creditX)) ? 'debit' : 'credit';
      if (!direction) { direction = txn.v < 0 && !hasBalance ? 'credit' : 'debit'; guessed++; }

      current = { occurred_at: parseDate(m![0])!, amount_paise: amt, direction, narrX: text[0]?.x ?? 0, chunks: [{ text: text.map((i) => i.s).join(' '), x1: text.length ? text[text.length - 1].x1 : 0 }] };
      rows.push(current);
    }
  }

  if (!rows.length) throw new PdfError('pdf_unrecognised', "I could read the PDF but couldn't find transaction rows in it. Try the CSV download from your bank.");
  const warnings: string[] = [];
  // In "Cr-marked" statements (cards) an unmarked amount simply IS a purchase, so only warn when nothing in the file gives a clue.
  if (guessed && !anyMark) warnings.push(`${guessed} row${guessed > 1 ? 's' : ''} had no clear debit/credit marker, so I assumed money out. Check them in the preview.`);
  if (mismatches) warnings.push(`The running balance doesn't add up for ${mismatches} row${mismatches > 1 ? 's' : ''}, so a row may be missing or misread. Compare with your statement.`);
  // Glue wrapped pieces back together. If the line above ran all the way to the right edge of the narration column, the bank
  // chopped a long token (a UPI reference) mid-word: join with nothing. Otherwise it was a normal line break: join with a space.
  const maxX1 = Math.max(...rows.flatMap((r) => r.chunks.map((c) => c.x1)));
  const tol = Math.max(6, 0.08 * (maxX1 - Math.min(...rows.map((r) => r.narrX))));
  const narration = (r: (typeof rows)[number]) => r.chunks.reduce((acc, c, i) => (i === 0 ? c.text : acc + (r.chunks[i - 1].x1 >= maxX1 - tol ? '' : ' ') + c.text), '');
  const raw: RawRow[] = rows.map((r) => ({ occurred_at: r.occurred_at, amount_paise: r.amount_paise, direction: r.direction, narration: narration(r).replace(/\s+/g, ' ').trim() }));
  return { rows: buildRows(raw), warnings };
}
