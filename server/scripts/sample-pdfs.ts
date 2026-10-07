// Makes two fake bank statements to try PDF import with:  npm run sample-pdfs   ->  server/data/samples/
//   sample-statement.pdf          a normal text-layer statement
//   sample-statement-locked.pdf   the same, password-protected (password: 15031999)
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

const rows: [date: string, narration: string, kind: 'wd' | 'dep', paise: number][] = [
  ['01/10/2026', 'NEFT CR-ACME CORP-STIPEND OCTOBER', 'dep', 1500000],
  ['01/10/2026', 'UPI-PG RENT-landlord@okaxis-SBIN0001-5512-UPI', 'wd', 600000],
  ['02/10/2026', 'UPI-NETFLIX-netflix@hdfcbank-HDFC0000-8821-UPI', 'wd', 64900],
  ['02/10/2026', 'UPI-SWIGGY-swiggy@icici-ICIC0001-4123-UPI', 'wd', 41000],
  ['03/10/2026', 'UPI/DR/412345678901/ZOMATO', 'wd', 34000],
  ['04/10/2026', 'UPI-UBER INDIA-uber@axisbank-UTIB0001-7740-UPI', 'wd', 25000],
  ['04/10/2026', 'POS 400000XXXXXX1234 AMAZON PAY INDIA', 'wd', 129900],
  ['05/10/2026', 'ATM WDL 112233 PANJIM', 'wd', 200000],
  ['05/10/2026', 'UPI-RIA SHARMA-ria@oksbi-SBIN0002-3391-UPI', 'dep', 40000],
  ['06/10/2026', 'CREDIT CARD LATE PAYMENT FEE', 'wd', 11800],
];
const inr = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const C = { date: 25, narr: 75, ref: 270, val: 320, wd: 400, dep: 455, bal: 545 };

function make(file: string, userPassword?: string) {
  const doc = new PDFDocument({ size: 'A4', margin: 30, ...(userPassword ? { userPassword, ownerPassword: userPassword + '!owner' } : {}) });
  doc.pipe(createWriteStream(file));
  doc.fontSize(7.5);
  const put = (y: number, t: string, x: number, right = false) => doc.text(t, right ? x - doc.widthOfString(t) : x, y, { lineBreak: false });
  put(30, 'Sample Bank Ltd   Statement of account   Account No: 50100123456789', 25);
  put(42, 'Statement period 01/10/2026 to 31/10/2026', 25);
  [['Date', 25], ['Narration', 75], ['Chq./Ref.No.', 270], ['Value Dt', 320], ['Withdrawal Amt.', 355], ['Deposit Amt.', 415], ['Closing Balance', 475]].forEach(([t, x]) => put(60, t as string, x as number));
  let bal = 1000000, y = 74;
  put(y, 'Opening Balance', C.narr); put(y, inr(bal), C.bal, true);
  rows.forEach(([date, narr, kind, p], i) => {
    y += 14; bal += kind === 'dep' ? p : -p;
    put(y, date, C.date); put(y, narr.slice(0, 44), C.narr); put(y, String(4000000 + i * 137).padStart(13, '0'), C.ref); put(y, date, C.val);
    put(y, inr(p), kind === 'wd' ? C.wd : C.dep, true); put(y, inr(bal), C.bal, true);
    if (narr.length > 44) { y += 10; put(y, narr.slice(44), C.narr); } // long narrations wrap onto a second line, like real statements
  });
  put(780, 'Page 1 of 1', 25);
  doc.end();
}

const dir = path.join(__dirname, '..', 'data', 'samples');
mkdirSync(dir, { recursive: true });
make(path.join(dir, 'sample-statement.pdf'));
make(path.join(dir, 'sample-statement-locked.pdf'), '15031999');
console.log(`Wrote sample PDFs to ${dir}  (locked file password: 15031999)`);
