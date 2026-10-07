// PDF statement import, tested with REAL PDFs generated on the fly (pdfkit) in several bank-style layouts.
// These prove the parser against layouts I could imagine, not against your bank's actual PDF: see the README.
import type { AddressInfo } from 'node:net';
import PDFDocument from 'pdfkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { openDb } from '../src/db';
import { parsePdfStatement, PdfError } from '../src/engine/pdf';

type Doc = InstanceType<typeof PDFDocument>;
const makePdf = (draw: (d: Doc) => void, opts: Record<string, unknown> = {}) => new Promise<Buffer>((resolve) => {
  const doc = new PDFDocument({ size: 'A4', margin: 30, ...opts });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.fontSize(7.5);
  draw(doc);
  doc.end();
});
/** [text, x, 'r'?]: 'r' right-aligns the text so its RIGHT edge sits at x (how banks print amounts). */
type Col = [string, number, 'r'?];
const put = (d: Doc, y: number, cols: Col[]) => { for (const [t, x, a] of cols) d.text(t, a === 'r' ? x - d.widthOfString(t) : x, y, { lineBreak: false }); };

// Layout A: the classic 7-column bank table (separate Withdrawal / Deposit columns + running balance)
const A = { date: 25, narr: 75, ref: 250, val: 300, wd: 385, dep: 440, bal: 530 };
const headerA = (d: Doc, y: number) => put(d, y, [['Date', A.date], ['Narration', A.narr], ['Chq./Ref.No.', A.ref], ['Value Dt', A.val], ['Withdrawal Amt.', 340], ['Deposit Amt.', 400], ['Closing Balance', 460]]);
const rowA = (d: Doc, y: number, date: string, narr: string, ref: string, kind: 'wd' | 'dep', amt: string, bal: string) =>
  put(d, y, [[date, A.date], [narr, A.narr], [ref, A.ref], [date, A.val], [amt, kind === 'wd' ? A.wd : A.dep, 'r'], [bal, A.bal, 'r']]);

const bankPdf = (extra?: (d: Doc) => void) => makePdf((d) => {
  put(d, 30, [['Statement of account  Account No: 50100123456789', 25]]);
  put(d, 42, [['Statement period 01/03/2026 to 31/03/2026', 25]]);
  headerA(d, 60);
  put(d, 74, [['Opening Balance', A.narr], ['50,000.00', A.bal, 'r']]);
  rowA(d, 88, '01/03/2026', 'UPI-SWIGGY-swiggy@icici-ICIC0001-4123-UPI', '0000412345678', 'wd', '1,250.50', '48,749.50');
  rowA(d, 102, '02/03/2026', 'NEFT CR-ACME CORP SALARY MARCH', '0000999111222', 'dep', '25,000.00', '73,749.50');
  rowA(d, 116, '03/03/2026', 'UPI/DR/412345678901/ZOMATO', '0000123456789', 'wd', '340.00', '73,409.50');
  put(d, 126, [['zomato@hdfcbank/Food', A.narr]]); // wrapped narration: no date, no amounts, same column
  put(d, 780, [['Page 1 of 2', 25]]);
  d.addPage(); d.fontSize(7.5);
  headerA(d, 40); // headers repeat on every page
  rowA(d, 54, '04/03/2026', 'ATM WDL 99', '0000777', 'wd', '2,000.00', '71,409.50');
  put(d, 780, [['Page 2 of 2', 25]]);
  extra?.(d);
});

describe('PDF statement parsing', () => {
  it('reads a classic bank table: wrapped narrations, repeated headers, page furniture, refs and value dates', async () => {
    const { rows, warnings } = await parsePdfStatement(await bankPdf());
    expect(rows.map((r) => [r.occurred_at.slice(0, 10), r.direction, r.amount_paise])).toEqual([
      ['2026-03-01', 'debit', 125050], ['2026-03-02', 'credit', 2500000], ['2026-03-03', 'debit', 34000], ['2026-03-04', 'debit', 200000],
    ]);
    expect(rows[0].narration).toBe('UPI-SWIGGY-swiggy@icici-ICIC0001-4123-UPI'); // ref number and value date stripped
    expect(rows[2].narration).toBe('UPI/DR/412345678901/ZOMATO zomato@hdfcbank/Food'); // wrapped line merged, page footer not
    expect(rows[3].payment_method).toBe('cash');
    expect(warnings).toEqual([]); // the running balance adds up all the way through
  });

  it('rejoins a UPI reference the bank chopped mid-word, but keeps a space at a normal line break', async () => {
    const pdf = await makePdf((d) => {
      headerA(d, 40);
      put(d, 54, [['Opening Balance', A.narr], ['50,000.00', A.bal, 'r']]);
      rowA(d, 68, '01/03/2026', 'UPI-SWIGGY-swiggy@icici-ICIC0001-4123-UP', '0000111', 'wd', '100.00', '49,900.00'); // full-width line...
      put(d, 78, [['I', A.narr]]);                                                                                   // ...wrapped mid-word
      rowA(d, 92, '02/03/2026', 'ATM WDL', '0000222', 'wd', '50.00', '49,850.00');
      put(d, 102, [['PANJIM BRANCH', A.narr]]);                                                                       // short line, normal break
    });
    expect((await parsePdfStatement(pdf)).rows.map((r) => r.narration)).toEqual(['UPI-SWIGGY-swiggy@icici-ICIC0001-4123-UPI', 'ATM WDL PANJIM BRANCH']);
  });

  it('decides direction from the balance when there are no Dr/Cr columns or markers', async () => {
    const pdf = await makePdf((d) => {
      put(d, 40, [['Date', 30], ['Description', 90], ['Amount', 380], ['Balance', 470]]);
      put(d, 54, [['Opening Balance', 90], ['10,000.00', 520, 'r']]);
      put(d, 68, [['05/03/2026', 30], ['Chai Point', 90], ['40.00', 420, 'r'], ['9,960.00', 520, 'r']]);
      put(d, 82, [['06/03/2026', 30], ['Friend sent via UPI', 90], ['500.00', 420, 'r'], ['10,460.00', 520, 'r']]);
    });
    const { rows, warnings } = await parsePdfStatement(pdf);
    expect(rows.map((r) => [r.direction, r.amount_paise])).toEqual([['debit', 4000], ['credit', 50000]]);
    expect(warnings).toEqual([]);
  });

  it('reads a credit-card style statement with Cr markers, without crying wolf about unmarked purchases', async () => {
    const pdf = await makePdf((d) => {
      put(d, 40, [['Date', 30], ['Transaction Details', 90], ['Amount (INR)', 440]]);
      put(d, 54, [['05/03/2026', 30], ['AMAZON PAY INDIA', 90], ['1,299.00', 500, 'r']]);
      put(d, 68, [['07/03/2026', 30], ['PAYMENT RECEIVED THANK YOU', 90], ['5,000.00', 500, 'r'], ['Cr', 506]]);
      put(d, 82, [['09/03/2026', 30], ['SWIGGY', 90], ['410.00', 500, 'r']]);
    });
    const { rows, warnings } = await parsePdfStatement(pdf);
    expect(rows.map((r) => [r.direction, r.amount_paise])).toEqual([['debit', 129900], ['credit', 500000], ['debit', 41000]]);
    expect(warnings).toEqual([]);
  });

  it('copes with a whole row emitted as ONE text run, with Dr/Cr markers and no header at all', async () => {
    const pdf = await makePdf((d) => {
      d.text('Opening Balance 50,000.00', 30, 40, { lineBreak: false });
      d.text('01/03/2026 UPI-SWIGGY-swiggy@icici 1,250.50 Dr 48,749.50 Cr', 30, 54, { lineBreak: false });
      d.text('02/03/2026 NEFT SALARY ACME 25,000.00 Cr 73,749.50 Cr', 30, 68, { lineBreak: false });
    });
    const { rows, warnings } = await parsePdfStatement(pdf);
    expect(rows.map((r) => [r.direction, r.amount_paise, r.narration])).toEqual([['debit', 125050, 'UPI-SWIGGY-swiggy@icici'], ['credit', 2500000, 'NEFT SALARY ACME']]);
    expect(warnings).toEqual([]);
  });

  it('warns when the running balance does not add up (a row is probably missing)', async () => {
    const pdf = await makePdf((d) => {
      headerA(d, 40);
      put(d, 54, [['Opening Balance', A.narr], ['50,000.00', A.bal, 'r']]);
      rowA(d, 68, '01/03/2026', 'Shop one', '0000111', 'wd', '100.00', '49,900.00');
      rowA(d, 82, '02/03/2026', 'Shop two', '0000222', 'wd', '50.00', '49,000.00'); // should be 49,850: a row went missing
    });
    const { rows, warnings } = await parsePdfStatement(pdf);
    expect(rows).toHaveLength(2);
    expect(rows[1].direction).toBe('debit'); // still resolved, from the Withdrawal column
    expect(warnings.join(' ')).toContain("doesn't add up for 1 row");
  });

  it('asks for the password of a protected PDF, rejects a wrong one, and reads it with the right one', async () => {
    const locked = await bankPdf().then(() => makePdf((d) => { headerA(d, 40); put(d, 54, [['Opening Balance', A.narr], ['50,000.00', A.bal, 'r']]); rowA(d, 68, '01/03/2026', 'Shop one', '0000111', 'wd', '100.00', '49,900.00'); }, { userPassword: 'secret123', ownerPassword: 'owner456' }));
    await expect(parsePdfStatement(locked)).rejects.toMatchObject({ code: 'pdf_password_required' });
    await expect(parsePdfStatement(locked, 'nope')).rejects.toMatchObject({ code: 'pdf_password_wrong' });
    expect((await parsePdfStatement(locked, 'secret123')).rows).toHaveLength(1);
  });

  it('says clearly when a PDF is a scan, not a statement, or not a PDF at all', async () => {
    const scan = await makePdf((d) => { d.rect(50, 50, 200, 200).fill('#cccccc'); });
    await expect(parsePdfStatement(scan)).rejects.toMatchObject({ code: 'pdf_no_text' });
    const letter = await makePdf((d) => { d.text('Dear customer, thank you for banking with us. Have a lovely day.', 50, 50); });
    await expect(parsePdfStatement(letter)).rejects.toMatchObject({ code: 'pdf_unrecognised' });
    await expect(parsePdfStatement(new TextEncoder().encode('definitely not a pdf'))).rejects.toBeInstanceOf(PdfError);
  });
});

describe('PDF import over HTTP', () => {
  let base = '', server: ReturnType<ReturnType<typeof createApp>['listen']>;
  const post = async (body: unknown) => {
    const r = await fetch(`${base}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  beforeAll(async () => {
    server = createApp(openDb(':memory:'), { today: () => '2026-03-10' }).listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); });

  it('previews, commits once, and skips duplicates on re-import; credits are skipped by default', async () => {
    const pdf_base64 = (await bankPdf()).toString('base64');
    const prev = (await post({ pdf_base64 })).json;
    expect([prev.format, prev.committed, prev.credits_skipped, prev.rows.map((r: any) => r.category_name)]).toEqual(['pdf', false, 1, ['Food Delivery', 'Food Delivery', 'Cash Withdrawal']]);
    expect((await post({ pdf_base64, commit: true })).json.imported).toBe(3);
    const again = (await post({ pdf_base64, commit: true })).json;
    expect([again.imported, again.duplicates]).toEqual([0, 3]);
    const tx = await (await fetch(`${base}/api/transactions?month=2026-03`)).json();
    expect(tx.find((t: any) => t.merchant_raw.includes('SWIGGY'))).toMatchObject({ amount_paise: 125050, category_name: 'Food Delivery', source: 'statement' });
  });

  it('surfaces PDF problems as a 422 with a code the app can act on, and needs exactly one of csv / pdf', async () => {
    const locked = (await makePdf((d) => { headerA(d, 40); rowA(d, 54, '01/03/2026', 'Shop', '0000111', 'wd', '100.00', '49,900.00'); }, { userPassword: 'pw12345', ownerPassword: 'own12345' })).toString('base64');
    const need = await post({ pdf_base64: locked });
    expect([need.status, need.json.code]).toEqual([422, 'pdf_password_required']);
    expect((await post({ pdf_base64: locked, password: 'pw12345' })).status).toBe(200);
    expect((await post({})).status).toBe(400);
    expect((await post({ csv: 'a', pdf_base64: locked })).status).toBe(400);
  });
});
