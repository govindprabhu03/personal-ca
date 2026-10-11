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

## Install it: Windows `.exe` + Android `.apk`

**`release/PersonalCA.exe`** (95 MB, one file, nothing else to install). Double-click it: it starts the server, opens the full app in your browser at `http://localhost:8787`, and prints the address + access token your phone needs. Keep its window open while you use the app; close it to stop. Your data lives in `%APPDATA%\PersonalCA` (`ca.db`, `token.txt`, plus automatic `backups\` and `logs\`; see Production notes); back that folder up. Options: `--local-only` (this PC only, no phone), `--no-browser`. First launch: Windows asks whether to let it talk on your network, so tick **Private and Public** and Allow, or your phone can't reach it. Windows SmartScreen will say "unknown publisher" (the file is unsigned; More info > Run anyway). Rebuild it any time with `npm run build:exe` in `server/`.

**`release/PersonalCA.apk`** (built by Expo's cloud build from `mobile/`; profile `preview` in `mobile/eas.json`). On the phone: allow "install unknown apps" for your browser/file manager, open the APK, install. Then in the app go to **More > Connect to your PC** and enter the PC address (e.g. `192.168.0.150`) and the access token shown by `PersonalCA.exe` (or on its web page under More > Connect to your PC). Until you connect, the app works fully on its own, offline. Rebuild with `npx eas-cli build -p android --profile preview` in `mobile/`.
Signing key: `mobile/keys/personalca.keystore` + `mobile/credentials.json` (both git-ignored). **Back them up**: without them you can't install an updated APK over the old one.

**How the pieces fit:** the phone app and the browser app each hold their own database and sync with the one server (`PersonalCA.exe` or `npm run phone`). The API is on your Wi-Fi in plain HTTP (Android's "cleartext" is enabled for that), guarded by the token; it also refuses foreign `Host` headers (DNS-rebinding) and other websites' CORS requests. The web page is handed the token only when opened on the PC itself.

## Production notes

**Before any release:** `npm run verify` in `server/` is the one gate: typecheck (server + app), all tests, then a scan of everything git tracks for garbled text and for leaked secrets (keystore passwords, access tokens). It must exit 0.

**What `PersonalCA.exe` keeps in `%APPDATA%\PersonalCA`:** `ca.db` (your data), `token.txt`, `backups\` (one dated copy a day, newest 14 kept, taken at start-up and every 6 hours it stays open), `logs\` (one file a day, 14 kept; failures by route and status only, never amounts, bodies or tokens). The server also stamps `ca.db` with a data version: a newer file is refused with a clear message (never silently mangled), and an older one is copied aside (`ca.db.before-vN.bak`) before it is upgraded.
**Restore from a daily backup:** close the exe, copy `backups\ca-DATE.db` over `ca.db`, delete `ca.db-wal` and `ca.db-shm` if present, start it again. (More > Backup/Restore in the app makes a separate passphrase-encrypted export.) The daily copies are plain SQLite, as protected as `ca.db` itself, i.e. by your Windows account.

**Security posture:** every `/api` call needs the token (compared in constant time); 10 wrong tokens within a minute lock that address out for a minute (even for the right token); foreign `Host` headers and other sites' CORS are refused; responses carry `nosniff` / `X-Frame-Options: DENY` / `no-store`. The phone app encrypts its on-device copy (AES-256-GCM, key in the Android Keystore via SecureStore), has Android auto-backup switched off, and requests no storage permissions. A phone that gets 429 (locked out), 421 (unrecognised PC address) or 5xx keeps all its queued changes and retries; only a real 4xx verdict on one change (e.g. invalid input) moves it to "rejected".
If the app crashes while drawing a screen it shows "Something went wrong / Try again" instead of closing; nothing is lost.

**Known limits, on purpose:**
- Phone-to-PC traffic is plain HTTP on your own Wi-Fi (the token travels in a header). Fine at home; don't expose port 8787 to the internet. For anything wider, put it behind a TLS reverse proxy or a VPN such as Tailscale and add the hostname to `CA_ALLOWED_HOSTS`.
- The exe is unsigned (SmartScreen warns once). A code-signing certificate is the only fix; it costs money, so it isn't done.
- The APK is a direct-install build (`preview` profile). Publishing to Google Play needs the `production` profile (an AAB), a Play developer account, and a privacy policy.
- `npm audit` reports findings only inside Expo's build tooling (metro, `@expo/cli`, node-forge); none of that code ships in the APK or the exe, and npm's suggested "fix" is a downgrade to Expo 44. The server's runtime dependencies are clean.
- Not yet exercised on real hardware: the expo-sqlite adapter, notifications, biometric unlock, Ask your CA with a live key, PDFs from real banks.

## Hosted on Vercel (a cloud server for the phone)

The same server also runs on Vercel, so the phone can sync from anywhere over HTTPS, with the PC off. Live at **https://personal-ca-api-govind20.vercel.app** (Vercel project `personal-ca-api`, Mumbai region, deployed from this repo's `server/` folder).
**Connect the phone:** More > Connect to your server > address `https://personal-ca-api-govind20.vercel.app` + the access token. The secrets are in `mobile/keys/cloud-secrets.txt` (git-ignored): `CA_API_TOKEN` is what you type into the phone; `CA_DATA_KEY` encrypts the database in the cloud. **Back that file up with `mobile/keys/`**: lose `CA_DATA_KEY` and the cloud copy can't be read (your phone still holds its own full copy).

**How data survives (Vercel Functions have no disk):** the database lives as ONE encrypted file (gzip + AES-256-GCM) in a private Vercel Blob store (`personal-ca-vault`). Each request loads it (a cheap version check when nothing changed), runs the normal app on it, and if anything changed saves it back **before replying**, naming the version it replaces (`ifMatch`). If another instance saved first, or storage hiccups, the phone gets a retryable 503 and the change stays queued (same Idempotency-Key, so it applies exactly once). Code: `server/src/cloud/` (`handler.ts`, `store.ts`), entry `server/src/vercel.ts`, config `server/vercel.json`. A spare copy is kept once a day under the weekday's name (`personalca/backup-mon.bin` ...), a week of history. Typical speed: reads about 0.5 s, writes about 2 s (each storage call is about 0.4 to 0.8 s); every response carries a `Server-Timing` header.

**One main server, and the identity guard.** Each server database has an id the phone remembers. A phone will never overwrite its data from a *different* server: an **empty** one (new, or reset) is filled from the phone automatically; a **non-empty stranger** blocks with "New server" in the header and a choice in More. So the PC program and the cloud server are two separate databases: pick one as your main. (Switching the phone to the other later shows that choice; taking the other server's copy replaces the phone's.)

**Deploy / redeploy:** push to `main` (the project is linked to GitHub; or create a deployment with Vercel's tools). Vercel runs `npm run build:vercel`, which bundles `src/vercel.ts` into `server/api/index.js`. That bundle is also committed (so the function exists whatever the build order); after changing server code run `npm run build:vercel` in `server/` and commit it. Environment (Production only, secrets stored as sensitive): `CA_API_TOKEN`, `CA_DATA_KEY`, `CA_ALLOWED_HOSTS` (the host above), `BLOB_READ_WRITE_TOKEN` (added by connecting the store; the code prefers it over `BLOB_STORE_ID`). Optional: `ANTHROPIC_API_KEY` to switch on Ask your CA. Preview deployments are disabled so nothing but `main` can ever reach your data.
**Limits:** Vercel caps a request or response body at 4.5 MB, so a PDF bigger than about 3 MB can't be imported through the cloud (use the PC program), and a very large history could exceed it on sync. The web version of the app is served only by the PC program, not by the cloud server. This repo is public: no secrets are tracked (`npm run verify` checks), but the code is visible.

## Accounts: sign in with email or Google

The installed app makes everyone sign in, so each person's data is their own. **Sign-in service:** Supabase Auth, project `personal-ca-auth` (ref `xjadceycmfimtftqnmja`, Mumbai, free plan). Only identity lives there; no financial data does.
**Separation:** each user's database is its own encrypted file (`personalca/users/<user id>/db.bin` in Blob), under a key derived from the master key and that user's id (HKDF), so one user's file can't be opened with another's key. The server verifies the sign-in token (ES256, public keys fetched from the project's JWKS: no shared secret) BEFORE it loads anyone's data, and checks issuer, audience and expiry. Refusals say why (`detail`), e.g. "the token was not signed by the sign-in service this server trusts". 10 failed attempts lock a client out for a minute. Code: `server/src/cloud/{auth,handler}.ts`, `mobile/src/auth.ts`, `mobile/src/screens/Auth.tsx`.
**On the phone:** the session is stored encrypted (same keystore-backed key as the data) and counts as signed-in even offline. Signing out clears this phone's copy (the data stays in the account); if someone else signs in on the same phone, the previous person's local data is cleared first. The first sign-in after updating adopts the data already on the phone. After sign-in the app asks "what best describes you?" (salaried / freelancer / business / investor / pensioner / other, age group, residency, regime): saved in the account (`profile` table) and editable in More.
**One-time dashboard steps you must do** (I can't: they need your own Google credentials):
1. Supabase dashboard > Authentication > URL Configuration: set **Site URL** to `https://personal-ca-api-govind20.vercel.app/` (the page email links land on; it also hosts the password-reset form) and add `personalca://**` to **Redirect URLs**.
2. Google sign-in: create an OAuth client (type Web) in Google Cloud Console with the authorised redirect URI `https://xjadceycmfimtftqnmja.supabase.co/auth/v1/callback`, then paste its Client ID and secret into Supabase > Authentication > Providers > Google. Until then the Google button says it isn't switched on yet (email sign-in works regardless).
3. Optional: Supabase's built-in email sender is heavily rate-limited; add your own SMTP under Authentication > SMTP if several people will sign up.
The PC program keeps its own access token and its web page does not use accounts (it is your PC alone). The old shared-token mode on the cloud server is switched off while `SUPABASE_URL` is set.

## Tax: preparing your ITR (Money > Tax)

Enter income, deductions and taxes paid for the year; see the tax under the **new and old regime** side by side (cheaper one recommended), the **ITR form** that fits with reasons (and why simpler forms are ruled out), a **schedule-by-schedule filing worksheet** (share as text or CSV), a "before you file" checklist, and live deadline status. Numbers update as you type; Save stores them in your account. **Ask your CA** answers tax questions from the same figures (`tax_summary`, `tax_savings`): the model never computes tax.
**What it is not:** a Chartered Accountant (audits, Form 3CD, certifications, representing you before the department need a practising CA), and it does not file for you (filing needs your PAN login and OTP on the portal; the app never holds them). It prepares; you file and e-verify.
**Rules:** `shared/core/tax/rules.ts` has one table per financial year; only **FY 2025-26 (AY 2026-27, Income-tax Act 1961)** is built in, and the app says so for any other year instead of guessing. Figures were checked against secondary sources, not the Finance Act text: confirm on incometax.gov.in before filing. Adding a year = a new table plus tests. The engine (`compute.ts`) covers salary/pension, HRA, house property (self-occupied and let-out, loss set-off), business (44ADA / 44AD / books, b/f losses), capital gains (111A, 112A with the 1.25 lakh exemption, other; loss set-off; unused basic exemption), other sources, Chapter VI-A deductions, slabs by age, 87A rebate and marginal relief, surcharge with marginal relief, cess, and estimates of 234F/234A/234B. **Not modelled** (each result's notes say so when relevant): 234C, partial integration of agricultural income, the indexed-cost option for pre-July-2024 property, NRI-specific rules, foreign income and relief, ESOP/AMT, HUFs and firms, Schedule AL/FA. Tested against worked examples calculated by hand (`server/test/tax.test.ts`).
**Today's situation for FY 2025-26:** the 31 July (individual) and 31 August (business) deadlines have passed; a belated return is accepted until 31 December 2026 with a late fee and interest, and the Tax screen says so.

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
