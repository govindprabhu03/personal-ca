// The HTTP layer: validate input (zod) -> call the service -> return JSON. No business logic lives here.
import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { hostname as osHostname, networkInterfaces } from 'node:os';
import { z } from 'zod';
import { DB } from './db';
import { monthOf, todayStr } from './engine/dates';
import { askCa, LlmClient } from './ask/agent';
import * as svc from './service';
import { AssetSource, mountWeb } from './web';

const NO_KEY = 'Ask your CA needs an Anthropic API key on the server. Set ANTHROPIC_API_KEY and restart the server.';

const money = z.number().int().positive();
const method = z.enum(['upi', 'card', 'cash', 'bnpl', 'netbanking']);
const bucket = z.enum(['need', 'want', 'waste', 'ignore']);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/);
const month = z.string().regex(/^\d{4}-\d{2}$/);
const pct = z.number().min(0).max(100);

const newTx = z.object({
  amount_paise: money, merchant_raw: z.string().max(200).optional(), note: z.string().max(300).optional(),
  category_id: z.number().int().nullable().optional(), account_id: z.number().int().optional(),
  payment_method: method.optional(), occurred_at: day.optional(),
});
const settings = z.object({
  savings_target_pct: pct, need_target_pct: pct, want_target_pct: pct,
  fixed_needs_paise: z.number().int().min(0), income_irregular: z.union([z.literal(0), z.literal(1)]),
  emergency_saved_paise: z.number().int().min(0), emergency_horizon_months: z.number().int().min(1).max(120),
}).partial();

// The real client is created on the first question (not at startup), so the server runs fine without any AI credentials.
let realClient: LlmClient | undefined;
const realLlm = (): LlmClient => (realClient ??= new Anthropic() as unknown as LlmClient);

// ---- who may talk to this server ----
const lanAddresses = () => Object.values(networkInterfaces()).flatMap((l) => l ?? []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
/** The names this server may be reached by: this PC, its CURRENT network addresses, and anything in CA_ALLOWED_HOSTS. */
const allowedHosts = (): Set<string> => {
  const h = osHostname().toLowerCase();
  return new Set(['localhost', '127.0.0.1', '[::1]', h, `${h}.local`, ...lanAddresses(), ...(process.env.CA_ALLOWED_HOSTS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)]);
};
const hostOf = (value?: string) => { try { return new URL(`http://${value ?? ''}`).hostname.toLowerCase(); } catch { return ''; } };

export function createApp(db: DB, opts: { token?: string; today?: () => string; llm?: LlmClient | null; web?: AssetSource | null } = {}) {
  const app = express();
  const asked: number[] = []; // timestamps, for a simple "60 questions an hour" cost guard
  const today = () => opts.today?.() ?? todayStr();
  // 1. DNS-rebinding guard: a web page can make your browser send requests to "localhost" under another site's NAME. Those carry a foreign Host header.
  app.use((q, r, n) => (allowedHosts().has(hostOf(q.headers.host)) ? n() : void r.status(421).type('text').send('Unrecognised host')));
  // 2. CORS: only pages served from this PC / your own network may read answers in a browser (phone apps send no Origin and are unaffected).
  app.use(cors({ origin: (origin, cb) => { if (!origin) return cb(null, true); try { cb(null, allowedHosts().has(new URL(origin).hostname.toLowerCase())); } catch { cb(null, false); } } }));
  app.use(express.json({ limit: '30mb' })); // statements: a few MB of CSV, or a base64 PDF (about a third bigger than the file)
  app.get('/api/health', (_q, r) => { r.json({ ok: true }); });
  if (opts.token)
    app.use('/api', (q, r, n) => (q.header('x-api-key') === opts.token ? n() : void r.status(401).json({ error: 'unauthorised' })));

  // Idempotent writes. The app's offline queue replays writes after a connection drops, and a replay must never double-apply
  // (e.g. the request DID reach us but the reply was lost). A repeated Idempotency-Key is answered from the stored result.
  app.use('/api', (q, r, n) => {
    const key = q.header('idempotency-key');
    if (!key || q.method === 'GET' || !/^[A-Za-z0-9_-]{8,80}$/.test(key)) return n();
    const hit = db.prepare('SELECT status, body FROM sync_ops WHERE op_id = ?').get(key) as unknown as { status: number; body: string } | undefined;
    if (hit) return void r.status(hit.status).type('json').send(hit.body);
    let saved = false;
    const save = (body: string) => { // 5xx is not remembered: a server hiccup should be retried for real
      if (saved || r.statusCode >= 500) return;
      saved = true;
      db.prepare('INSERT OR IGNORE INTO sync_ops (op_id, status, body) VALUES (?, ?, ?)').run(key, r.statusCode, body);
    };
    const send = r.send.bind(r);
    r.send = ((body?: unknown) => { save(typeof body === 'string' ? body : ''); return send(body as never); }) as typeof r.send;
    r.on('finish', () => save('')); // bodiless responses such as 204
    n();
  });

  const id = (q: Request) => Number(q.params.id);
  const monthQ = (q: Request) => month.parse(q.query.month ?? monthOf(today()));

  app.get('/api/bootstrap', (_q, r) => { r.json(svc.bootstrap(db, today())); });
  // The whole database as plain data: how the phone refreshes its on-device copy after it has sent its own changes.
  app.get('/api/snapshot', (_q, r) => { r.json(svc.exportTables(db)); });
  // What a phone needs to connect (only reachable with the token already, so this reveals nothing new).
  app.get('/api/pairing', (q, r) => { r.json({ urls: lanAddresses().map((a) => `http://${a}:${q.socket.localPort}`), token: opts.token ?? null }); });
  app.get('/api/suggest', (q, r) => {
    const h = q.query.hour === undefined ? undefined : Number(q.query.hour);
    r.json(svc.suggest(db, String(q.query.text ?? ''), h));
  });
  app.put('/api/settings', (q, r) => { r.json(svc.updateSettings(db, settings.parse(q.body))); });

  app.post('/api/accounts', (q, r) => {
    const b = z.object({ kind: z.enum(['bank', 'cash', 'card', 'wallet']), name: z.string().min(1).max(40), opening_paise: z.number().int().default(0) }).parse(q.body);
    r.status(201).json(svc.addAccount(db, b.kind, b.name, b.opening_paise));
  });

  app.post('/api/income', (q, r) => {
    const b = z.object({ amount_paise: money, received_at: day.optional(), source: z.string().max(60).optional(), is_regular: z.boolean().optional(), account_id: z.number().int().optional() }).parse(q.body);
    r.status(201).json(svc.addIncome(db, b));
  });
  app.get('/api/income', (q, r) => { r.json(svc.listIncome(db, monthQ(q))); });
  app.delete('/api/income/:id', (q, r) => { svc.deleteIncome(db, id(q)); r.status(204).end(); });

  app.post('/api/transactions', (q, r) => { r.status(201).json(svc.createTx(db, newTx.parse(q.body))); });
  app.post('/api/transactions/bulk', (q, r) => { r.status(201).json(svc.bulkCreate(db, z.object({ items: z.array(newTx).min(1).max(50) }).parse(q.body).items)); });

  app.get('/api/subscriptions', (_q, r) => { r.json(svc.subscriptionsFor(db, today())); });
  app.post('/api/subscriptions/mark', (q, r) => {
    const b = z.object({ merchant: z.string().min(1), unused: z.boolean() }).parse(q.body);
    r.json(svc.markSubscription(db, b.merchant, b.unused, today()));
  });

  app.get('/api/bills', (_q, r) => { r.json(svc.listBills(db, today())); });
  app.post('/api/bills', (q, r) => {
    const b = z.object({
      name: z.string().min(1).max(40), emoji: z.string().max(8).optional(), kind: z.enum(['bill', 'emi']).default('bill'), amount_paise: money,
      due_day: z.number().int().min(1).max(31), remind_days: z.number().int().min(0).max(14).default(3), installments_left: z.number().int().min(1).max(600).optional(),
    }).parse(q.body);
    r.status(201).json(svc.addBill(db, b, today()));
  });
  app.post('/api/bills/:id/pay', (q, r) => {
    const b = z.object({ log_spend: z.boolean().default(true), occurred_at: day.optional() }).parse(q.body ?? {}); // occurred_at: when it was PAID (an offline tap can sync days later)
    r.json(svc.payBill(db, id(q), b.log_spend, today(), b.occurred_at));
  });
  app.delete('/api/bills/:id', (q, r) => { svc.deleteBill(db, id(q)); r.status(204).end(); });

  const person = z.string().trim().min(1).max(40);
  app.get('/api/ious', (_q, r) => { r.json(svc.iouSummary(db)); });
  app.post('/api/ious/split', (q, r) => {
    const b = z.object({
      amount_paise: money, merchant_raw: z.string().max(200).optional(), friends: z.array(person).min(1).max(15), paid_by: person.nullable().default(null),
      my_share_paise: z.number().int().min(0).optional(), payment_method: method.optional(), category_id: z.number().int().nullable().optional(), occurred_at: day.optional(),
    }).parse(q.body);
    r.status(201).json(svc.splitSpend(db, b));
  });
  app.post('/api/ious/entry', (q, r) => {
    const b = z.object({ person, amount_paise: money, kind: z.enum(['lent', 'borrowed']), note: z.string().max(100).optional(), account_id: z.number().int().optional(), occurred_at: day.optional() }).parse(q.body);
    r.status(201).json(svc.addIou(db, b));
  });
  app.post('/api/ious/settle', (q, r) => {
    const b = z.object({ person, amount_paise: money.optional(), account_id: z.number().int().optional() }).parse(q.body);
    r.json(svc.settleIou(db, b.person, b.amount_paise, b.account_id));
  });

  app.get('/api/goals', (_q, r) => { r.json(svc.listGoals(db, today())); });
  app.post('/api/goals', (q, r) => {
    const b = z.object({ name: z.string().min(1).max(40), emoji: z.string().max(8).optional(), target_paise: money, target_date: day.optional() }).parse(q.body);
    r.status(201).json(svc.addGoal(db, b, today()));
  });
  app.post('/api/goals/:id/contribute', (q, r) => { r.json(svc.contributeGoal(db, id(q), z.object({ add_paise: z.number().int() }).parse(q.body).add_paise, today())); });
  app.delete('/api/goals/:id', (q, r) => { svc.deleteGoal(db, id(q)); r.status(204).end(); });

  app.get('/api/wishlist', (_q, r) => { r.json(svc.wishlist(db)); });
  app.post('/api/wishlist', (q, r) => {
    const b = z.object({ name: z.string().min(1).max(60), price_paise: money, wait_hours: z.union([z.literal(24), z.literal(48)]).default(24) }).parse(q.body);
    r.status(201).json(svc.addWish(db, b.name, b.price_paise, b.wait_hours));
  });
  app.post('/api/wishlist/:id/decide', (q, r) => { r.json(svc.decideWish(db, id(q), z.object({ decision: z.enum(['bought', 'skipped']) }).parse(q.body).decision)); });

  app.get('/api/transactions', (q, r) => { r.json(svc.listTxs(db, monthQ(q), today())); });
  app.patch('/api/transactions/:id', (q, r) => {
    r.json(svc.patchTx(db, id(q), z.object({ category_id: z.number().int().optional(), bucket: bucket.optional(), note: z.string().max(300).optional() }).parse(q.body)));
  });
  app.delete('/api/transactions/:id', (q, r) => { svc.deleteTx(db, id(q)); r.status(204).end(); });
  app.post('/api/transactions/:id/regret', (q, r) => { r.json(svc.setRegret(db, id(q), z.object({ regret: z.boolean() }).parse(q.body).regret)); });

  app.get('/api/review/weekly', (_q, r) => { r.json(svc.weeklyReview(db, today())); });
  app.get('/api/flags', (q, r) => { r.json(svc.flagsFor(db, monthQ(q), today())); });
  app.get('/api/safe-to-spend', (q, r) => { r.json(svc.safeToSpendFor(db, day.parse(q.query.date ?? today()).slice(0, 10))); });
  app.get('/api/savings', (_q, r) => { r.json(svc.savingsFor(db, today())); });
  app.get('/api/report/monthly', (q, r) => { r.json(svc.reportFor(db, monthQ(q), today())); });

  app.post('/api/import', async (q, r) => {
    const b = z.object({
      csv: z.string().min(1).optional(), pdf_base64: z.string().min(20).optional(), password: z.string().max(100).optional(),
      account_id: z.number().int().optional(), commit: z.boolean().default(false), include_credits: z.boolean().default(false),
    }).refine((x) => !!x.csv !== !!x.pdf_base64, 'send either csv or pdf_base64').parse(q.body);
    r.json(await svc.importStatement(db, { csv: b.csv, pdf: b.pdf_base64 ? Buffer.from(b.pdf_base64, 'base64') : undefined, password: b.password }, b.account_id, b.commit, b.include_credits));
  });

  app.post('/api/ask', async (q, r) => {
    const b = z.object({
      question: z.string().trim().min(1).max(500),
      history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(2000) })).max(10).default([]),
    }).parse(q.body);
    if (opts.llm === null) throw new svc.HttpError(503, NO_KEY);
    const now = Date.now();
    while (asked.length && now - asked[0] > 3_600_000) asked.shift();
    if (asked.length >= 60) throw new svc.HttpError(429, "That's a lot of questions for one hour. Give me a breather ☕");
    asked.push(now);
    try {
      r.json(await askCa(db, b.question, b.history, { client: opts.llm ?? realLlm(), today: today() }));
    } catch (e: any) {
      if (e instanceof Anthropic.AuthenticationError || /authentication method|api.?key/i.test(String(e?.message))) throw new svc.HttpError(503, NO_KEY);
      if (e instanceof Anthropic.RateLimitError) throw new svc.HttpError(429, 'The AI is busy right now. Try again in a minute.');
      if (e instanceof Anthropic.BadRequestError) throw new svc.HttpError(502, `The AI request was rejected: ${e.message}`);
      if (e instanceof Anthropic.APIError) throw new svc.HttpError(502, `The AI service had a problem (${e.status}). Try again shortly.`);
      throw e;
    }
  });

  app.get('/api/export/transactions.csv', (_q, r) => { r.type('text/csv').send(svc.exportCsv(db)); });
  app.post('/api/backup', (q, r) => { r.json({ backup: svc.backup(db, z.object({ passphrase: z.string().min(6) }).parse(q.body).passphrase) }); });
  app.post('/api/restore', (q, r) => {
    const b = z.object({ passphrase: z.string().min(6), backup: z.string().min(2) }).parse(q.body);
    svc.restore(db, b.backup, b.passphrase);
    r.json({ ok: true });
  });
  app.post('/api/erase', (q, r) => { z.object({ confirm: z.literal(true) }).parse(q.body); svc.eraseAll(db); r.json({ ok: true }); });

  if (opts.web) mountWeb(app, opts.web, opts.token); // the web app itself, after every API route

  app.use((err: unknown, _q: Request, res: Response, _n: NextFunction) => {
    if (err instanceof z.ZodError) return void res.status(400).json({ error: 'invalid input', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    if (err instanceof svc.HttpError) return void res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    console.error(err);
    res.status(500).json({ error: 'server error' });
  });
  return app;
}
