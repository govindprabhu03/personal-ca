# Personal CA, Phase 1

A "judge, not a tracker": tags every spend **Need / Want / Waste**, learns from a weekly **regret review**, and turns it into one daily **safe-to-spend** number and a **savings target**. (Research: `Personal CA — Expense Checker App Research.docx`.)

## Stack, and why

| Layer | Used | Why |
|---|---|---|
| Mobile app | **React Native (Expo) + TypeScript** | One codebase for Android + iOS (research doc's pick). Expo's web target lets you preview in a browser. |
| API | **Node.js + Express 5 + TypeScript** | Your existing stack. Express stays out of the way so the logic is visible. |
| Validation | **zod** | Every request body is checked at the edge; bad input gets a clean `400`, not a crash. |
| Database | **SQLite** via Node's built-in `node:sqlite` | No install, no native build on Windows. Plain SQL, so a later move to Postgres/Supabase is a driver swap. |
| Money | **Integer paise everywhere** | Floats drift (`0.1+0.2`). Whole paise never do. |
| "CA brain" | **Plain TypeScript functions** in `server/src/engine/` | Rules + formulas, no LLM. Pure functions are deterministic and unit-testable. |
| Shared contract | `shared/types.ts`, `money.ts`, `labels.ts` | Server and app import the *same* types, so the API can't drift apart. |
| AI | **`@anthropic-ai/sdk`** (server only) | Claude explains and chooses tools; our code does the maths. See "Ask your CA". |
| PDF | **`unpdf`** (server) | Text-layer PDF statements; `pdfkit` (dev only) generates test PDFs. |
| Offline | `@react-native-async-storage/async-storage`, `@noble/ciphers`, `expo-crypto` | Outbox + cache on the phone, AES-256-GCM encrypted; the sync logic itself is dependency-free in `shared/sync.ts`. |
| On-device DB | `expo-sqlite` (phone), `sql.js` (web preview) | The same schema + service code as the server runs on the phone. |
| Tests | **Vitest** | 74 tests: formulas, detectors, parsers, and real-HTTP end-to-end flows. |
| Look & feel | `expo-linear-gradient`, `@expo-google-fonts/outfit` | Gradient hero cards and a friendly rounded font; everything else is plain React Native (swipes use the built-in `PanResponder`). |
| Security | App PIN + biometrics, AES-256-GCM encrypted backup, optional API token | Money data. Server binds to localhost unless you set `CA_API_TOKEN`. |

## How it was built (the full-stack procedure, in order)

1. **Contract first**: `shared/types.ts` defines every object that crosses the wire (Tx, SafeToSpend, MonthlyReport...). Both sides are written against it.
2. **Engine before UI**: `server/src/engine/` holds the maths as pure functions with unit tests:
   `categorise` (rules, then your corrections) → `detectors` (late-night, sale, spike, pay-later, small leaks, payday, fees, double charge, repeat regret) → `savings` (safe-to-spend, emergency fund) → `report` → `statement` (CSV import).
3. **Database**: `db.ts` (schema + seed categories), then `service.ts` (the only place that touches SQL: read rows → call engine → return API shapes).
4. **HTTP layer**: `app.ts` validates input with zod and calls the service. No business logic here.
5. **Tests at two levels**: unit tests on the engine (`engine.test.ts`), then `api.test.ts`: real HTTP against an in-memory DB (quick-add → verdict → regret → numbers → import → backup/restore → auth).
6. **Mobile**: `src/api.ts` (typed client) → `src/ui.tsx` (small component kit) → five screens (`src/screens/`) → `App.tsx` (tabs + quick-add button + lock gate).
7. **Verify in a browser**, then wire up demo data (`npm run demo`) so every screen has something to show.

## Try it on a real phone

See **`PHONE-TEST.md`** for the step-by-step checklist. Short version: `npm run phone` in `server/` (listens on your network, makes a private token, writes it to `mobile/.env`), then `npx expo start -c` in `mobile/` and scan the QR with Expo Go. A wrong or missing token never loses data: changes wait on the phone and the header shows 🔑 Token until it's fixed.

## Run it

```bash
# terminal 1: API (http://127.0.0.1:8787, db at server/data/ca.db)
cd server && npm start
npm run demo            # optional: loads a realistic week of sample data
npm test                # 19 tests

# terminal 2: app
cd mobile && npm run web          # browser preview
cd mobile && npx expo start       # phone: scan the QR with Expo Go
```

**On a real phone** the API must listen on the network, and it refuses to do that without a token:

```powershell
$env:HOST="0.0.0.0"; $env:CA_API_TOKEN="pick-a-long-secret"; npm start     # in server/
# in mobile/.env:  EXPO_PUBLIC_API_TOKEN=pick-a-long-secret
```

## Phase 1: the ten must-haves

| # | Feature | Where |
|---|---|---|
| 1 | Quick add (live verdict suggestion, remembers last choices) | `AddSheet.tsx`, `POST /api/transactions`, `GET /api/suggest` |
| 2 | Statement import (CSV; bank layouts sniffed; re-import safe) | `engine/statement.ts`, `More.tsx` |
| 3 | Income + cash wallets | `Savings.tsx`, `/api/income`, `/api/accounts` |
| 4 | Need/Want/Waste tags (rules + your corrections) | `engine/categorise.ts` |
| 5 | Weekly regret review (worth it / regret) | `Review.tsx`, `/api/review/weekly` |
| 6 | Waste detector (9 detectors, each shows its reason) | `engine/detectors.ts` |
| 7 | Monthly report (split vs target, top leaks, vs last month) | `engine/report.ts`, `Report.tsx` |
| 8 | Safe-to-spend today | `engine/savings.ts` → `safeToSpend` |
| 9 | Savings target calculator (3-6 / 6-12 months, step-down) | `engine/savings.ts` → `savingsPlan` |
| 10 | Export, backup, app lock | `service.ts`, `engine/crypto.ts`, `lock.tsx` |

## Deliberate choices and known gaps

- **Single user, no login yet.** The research data model has `users`; Phase 1 is one person on one server. Add `user_id` + auth (Supabase) when it goes multi-user.
- **Server-authoritative, not offline-first.** The research doc wants quick-add to work offline. Phase 1 talks to a local API; an on-device SQLite + sync queue is the Phase 1.5 job.
- **Statement import is CSV only.** PDF statements (the doc lists CSV *or* PDF) need a text-extraction step per bank. Statement rows carry no time, so they are stamped 12:00 and never trigger "late-night".
- **Soft signals flag, only regret or a fee makes waste.** Late-night/sale/pay-later mark a want; your regret tap (or a fee) turns it into waste.
- **No transfers between accounts yet.** An ATM withdrawal is ignored as spend but does not credit the Cash wallet; add cash via income or an opening balance.
- **Review uses buttons, not swipes**; **CSV export only** (PDF later); **PIN stored in the OS keystore on phones**, `localStorage` on web (preview only).
- **Detector thresholds** (`CFG` in `detectors.ts`) are the research doc's starting values: tune them on your own data.

## Phase 2 (built): the "coach" features

| Feature | Where |
|---|---|
| **Chat entry**: "chai 20, auto 60, yesterday swiggy 340 cash" → 3 entries (rules, no LLM; shared parser so the app previews instantly) | `shared/chat.ts`, `AddSheet.tsx`, `POST /api/transactions/bulk` |
| **Subscription finder**: 3+ charges ~30 days apart, stable amount, next due date, yearly cost; "I don't use this" turns it into waste | `engine/subscriptions.ts`, `Report.tsx` |
| **Goals** with progress + "₹/month needed" | `/api/goals`, `Savings.tsx` |
| **Cooling-off wishlist**: wait 24-48h before you can buy; skipped wishes are counted as money kept | `/api/wishlist`, `Savings.tsx` |
| **Streak** 🔥 (consecutive days you logged a spend) | `service.streakFor`, app header |

Mid-month spike alerts already show up under "Heads up" (the spike detector now ignores monthly subscriptions, which always look like weekly spikes).

## Phase 3 (built): bill reminders and splits

| Feature | How it works | Where |
|---|---|---|
| **Bill & EMI reminders** | Each bill has a due day (31 clamps to month-end). The "next cycle" is this month's until you mark it paid, then next month's. Status: overdue / due soon / upcoming. "Paid ✅" can log the spend (bills → a need, EMIs → EMI & Loans); EMIs count down instalments and retire at zero. | `engine/bills.ts`, `Bills.tsx`, Today → "Coming up" |
| **Phone notifications** | One local notification per unpaid bill, N days before at 9 am (opt-in, lazy-loaded `expo-notifications`). **Not verified on a real device**: the web preview can't show them. | `mobile/src/reminders.ts` |
| **Splits** | Equal split or an exact share for you; rounding paise go to whoever paid. **Only your share is a spend.** | `shared/splits.ts`, `Friends.tsx`, `POST /api/ious/split` |
| **IOUs & netting** | A friends ledger where each row records both what they owe you *and* the real cash that moved. Settling up is cash in/out, never income or expense, so a friend repaying ₹1,000 counts as ₹0 spent and your account balance stays true. | `iou_entries` table, `service.ts` |

Worked example: you pay ₹1,200 for 3 people. Your budget sees ₹400; your account shows −₹1,200; friends owe you ₹800. Each repayment adds cash back to the account and shrinks what they owe.

## On-device database (built; this replaced the cache-based sync below)

The phone now has a **real SQLite database** and runs the **same service and engine code as the server**. Every screen, every number, every detector is computed on the phone: with no signal, Today, Insights, Money, Bills, Friends and the Swipe deck all work and recompute. There is no "estimate" any more.

**How it's built**
- `shared/core/` is the pure brain (schema, service, detectors, savings, report, subscriptions, bills, dates), used unchanged by both sides. Node-only things (CSV/PDF import, encrypted backup) stay in `server/src/service-node.ts`. Old paths still work through tiny re-export stubs.
- The database talks through a 2-method interface (`prepare` / `exec`), so the same code runs on `node:sqlite` (server and tests), **`expo-sqlite`** (phones, `mobile/src/localdb.ts`) and **`sql.js`** (the web preview, `localdb.web.ts`, loaded from a CDN).
- `shared/commands.ts` describes every action once: the REST call that tells the server, and the local function that applies it to the phone's database (the very same function the server runs).
- **Local-first writes** (`shared/sync.ts`): applied to the phone's database instantly, then queued in an outbox and sent in order with a unique `Idempotency-Key` (so a lost reply can never double-apply). Rows created on the phone get ids from a separate high range; they can't be edited until synced, and are replaced by the server's rows afterwards.
- **Refresh**: once the server has everything, the phone downloads `GET /api/snapshot` and replaces its own copy (so other devices' changes arrive and ids converge). It never does this while changes are still waiting, so nothing the server hasn't seen is overwritten. A change the server refuses shows up under More → Offline & sync, and the next refresh makes the phone agree.
- **Persistence & encryption**: the database lives in memory and is saved as ONE AES-256-GCM encrypted snapshot together with the outbox (so they can never disagree after a crash), split into small pieces for phone storage limits; key in the OS keystore. This keeps encryption working in Expo Go, with no SQLCipher build needed.
- **Needs the server**: statement import, backup, restore, erase, Ask your CA. They run on the server first, then the phone refreshes.

**Honest limits:** a first-ever launch on a brand-new phone starts empty (seeded defaults) until it can reach the server once. A very large history means a bigger snapshot to download and re-save per change (fine for personal use: hundreds of KB). Edits are last-write-wins. Verified end to end in a real browser with a real SQLite engine (server killed, spend logged, every Insights number recomputed offline, cold restart, server restored, automatic sync, phone and server agree to the paisa). The **native `expo-sqlite` adapter is typechecked against the installed library but has not been run on a physical phone**.

## Offline-first sync (superseded by the on-device database above)

Log a spend with no signal and it just works: the app **never waits for the network to capture**. Everything is saved on the phone and sent when the connection returns.

**How it works** (`shared/sync.ts`, plain TypeScript with storage and network injected, so the code that runs on the phone is tested against the real server):
- **Reads:** network first; every success is cached (newest 60 screens). Offline, the last synced copy answers, so the whole app opens and browses with no connection. Safe-to-spend has a "latest copy" fallback for a new day.
- **Writes:** the daily loop (log a spend, chat-add, regret/worth-it taps, category fixes, income, mark a bill paid, goal top-ups, splits, IOUs, settling) goes into an **outbox** when the server can't be reached and is replayed **in order** when it can. Things that need the server (imports, backups, Ask your CA, settings, creating goals/bills/wishes) say plainly that they need a connection.
- **Never double-applies:** every write carries a unique `Idempotency-Key`; the server remembers the answer (`sync_ops` table, 30 days) and a replay is answered, not re-run. This covers the nasty case where the server applied a write but the reply was lost.
- **Time is the time you LOGGED it**, not the time it synced, so late-night detection, streaks and the right month all stay correct.
- **Instant local feedback:** the category verdict comes from the same rule engine on the phone (`shared/categorise.ts`); pending spends appear in Recent with "⏳ waiting to sync"; safe-to-spend updates immediately as an estimate (same formula as the server, tested for parity). When the queue syncs, the server re-judges with your learned corrections and every number is recomputed.
- **Rejections are visible:** if the server says no to a replayed change (e.g. it was deleted elsewhere), it moves to a "couldn't save" list in More → Offline & sync instead of blocking the queue.
- **Encrypted at rest:** the cache and outbox are AES-256-GCM encrypted (`mobile/src/cipher.ts`, key in the OS keystore, fresh nonce per write, tampering detected). "Delete all my data" and "Restore" also wipe the local cache and outbox.
- **Knocking:** a cheap `/health` ping on app foreground and every 15 s while offline or waiting; the header shows 📴 Offline · N / 🔄 Syncing / ⏳ N / ⚠️ N, and screens refresh when a backlog drains.

**Honest limits:** only spends have instant local effects. Other queued actions (e.g. "Paid ✅", a regret tap) are applied on the server at sync, and the lists they affect refresh then (a bill marked paid offline is hidden until synced). Edits are last-write-wins; this is a one-person app, so there is no merge logic. Queued actions can't depend on a spend that hasn't synced (those rows are read-only until they do). The server is still the source of truth: there is no on-device database, so analytics can't be computed offline (Insights shows the last synced data). Verified end to end in the browser (server killed, spend logged, cold restart offline, server restored, automatic sync) but **not on a physical phone**, where Android/iOS background and network behaviour can differ.

## PDF statement import (built)

**More → Import a statement → Choose CSV or PDF.** Same preview and de-duplication as CSV; passwords and warnings are handled in the app.

**How it works** (`server/src/engine/pdf.ts`, text extraction by `unpdf`, i.e. Mozilla's PDF.js): bank layouts differ, so instead of one template each page is rebuilt into visual lines and read with layered rules:
- **Row** = a line that starts with a date and has at least one 2-decimal amount. Page headers/footers, repeated headers, statement-period lines, reference numbers and value dates are ignored; wrapped narrations are merged back in (and a UPI reference chopped mid-word is rejoined without a stray space).
- **Debit or credit?** In order: (1) an explicit Dr/Cr marker, (2) the running balance going up or down vs the previous row (opening balance read from its line), (3) which header column the amount sits under (Withdrawal vs Deposit), (4) assume money out, and *say so*.
- **It checks its own work:** when balances are printed, rows are verified to add up. If not, you get a warning ("a row may be missing") in the preview instead of silently wrong numbers.
- **Password-protected PDFs** (most Indian banks) ask for the password in-app. It is used once in memory to open the file; never stored or logged.
- **Clear failures:** a scan or photo ("no readable text, use the CSV"), a PDF that isn't a statement, or an unreadable file each get their own message.

**Honest status:** tested with real PDFs generated in six bank-style layouts (classic 7-column table, balance-only, credit-card with Cr markers, whole-row-as-one-text-run with Dr/Cr and no header, wrapped narrations, password-protected) plus an end-to-end HTTP import. It has **not** been tried on a real bank's PDF, because none is on the dev machine, so layouts I haven't imagined may fail. UPI-app PDFs (PhonePe, Google Pay) print each payment as a multi-line block and are **not supported**: export their CSV instead. Don't import the same statement as both CSV and PDF (narrations differ slightly, so duplicates aren't detected across formats).

Try it without your own data: `npm run sample-pdfs` in `server/` writes `data/samples/sample-statement.pdf` and a password-protected twin (password `15031999`).

## Ask your CA (built)

Tap **💬 Ask** in the header and chat with your own numbers: "How much did I spend on food delivery in September?", "Am I on track to save?", "Who owes me money?".

**How it works** (`server/src/ask/`): Claude gets nine read-only tools (`spend_summary`, `list_flags`, `savings_status`, `safe_to_spend`, `find_transactions`, `monthly_report`, `subscriptions`, `bills`, `friends`). It decides which to call; the server runs them against the database and returns the figures. A manual tool-use loop (max 6 round-trips per question) feeds results back until Claude writes the answer.

**The rules from the research doc, enforced in code:**
- **The model never does the maths.** Every total, share and date is computed in `ask/tools.ts`; the system prompt forbids adding up or estimating, and tool results arrive pre-computed in rupees.
- **Privacy by construction.** Tool results contain only merchant (cleaned name), amount, date and category. Raw bank narrations, UPI IDs, account names/numbers and free-text notes are never included. A test seeds a UPI ID, a phone number in a note and an account name, then asserts none of it appears in anything sent to the model.
- **Key stays on the server.** The app only talks to `POST /api/ask`. No key = a friendly 503, and everything else keeps working.
- **No investment advice**: the prompt tells it to explain how much to save and which habits to change, not which funds to buy.
- **Safety nets:** tool inputs are validated (bad input becomes an error result the model can retry); refusals are handled; 60 questions/hour cap; the app shows which tools the answer used ("🔎 Looked at: spending summary").

**Turn it on** (PowerShell, in `server/`):

```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."; npm start
```

Optional: `CA_MODEL` (default `claude-opus-5-5`; set `claude-sonnet-5-5` to cut cost), `CA_EFFORT` (default `low`), `CA_FALLBACK=off` (turns off the server-side refusal fallback if your account/model rejects it).

**Honest status:** the tool layer, privacy guarantee and agent loop are covered by tests using a scripted fake model. It has **not been run against the live API** (no key on the dev machine), so model quality and the exact beta/fallback parameters are unverified. If a real question returns "The AI request was rejected: ...", try `CA_FALLBACK=off` first.

## The redesign

Bright lilac canvas, white rounded "sticker" cards, a violet→pink gradient hero, **Outfit** font, emoji as icons, friendly copy (never a red alarm: Need 🌱 mint, Want ✨ sunshine, Waste 🫠 pink). Highlights: swipeable regret deck (drag right = worth it, left = regret), money-vibe badge in the report, emoji-burst celebration when you log, floating tab bar with a centre **+**.
One file restyles everything: `mobile/src/theme.ts` (tokens) and `mobile/src/ui.tsx` (components).

## Still to build

Verifying on real hardware/accounts: the on-device database (expo-sqlite) and sync on a phone, phone notifications, Ask your CA against the live API, PDF import against real bank PDFs; PhonePe/Google Pay PDF block layouts; OCR for scanned statements.
