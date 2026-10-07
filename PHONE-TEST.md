# Testing Personal CA on your phone

Everything below was checked on this PC (your Wi-Fi: `192.168.0.150`). What can only be checked on a real phone is marked 🧪.

## 0. Before you start (2 minutes)
- Install **Expo Go** on your phone (Play Store / App Store). Phone and PC on the **same Wi-Fi** (not a guest or college network: those often block devices from talking to each other. If it won't connect, turn on your phone's hotspot and join the PC to it).
- Windows says your Wi-Fi is "Public", but there is already an allow-rule for Node.js, so you shouldn't need to touch the firewall. If Windows pops up "Allow Node.js to communicate?", tick **Public** and Allow.

## 1. Start it (two terminals)
**Terminal 1 (the server):**
```powershell
cd "D:\My Projects (Claude)\personal-ca\server"
npm run phone
```
It makes a private token, writes it into `mobile/.env`, and prints your network address. Leave it running.

**Terminal 2 (the app):**
```powershell
cd "D:\My Projects (Claude)\personal-ca\mobile"
npx expo start -c
```
Scan the QR code: **Android** with the Expo Go app, **iPhone** with the Camera app. (`-c` clears the cache so the token is picked up. Use it any time you change `.env`.)

> Optional, for something to look at: in a third terminal, `cd server` then `npm run demo` loads a sample week of data. Pull down on Today (or More → Sync now) to refresh.

## 2. The checklist
Tick these off in order. Each says what you should see.

| # | Do this | You should see |
|---|---|---|
| 1 | Open the app | "Opening your on-device database…" then your data. 🧪 **If you see "Couldn't open the on-device database"**, tell me the message: it means `expo-sqlite` misbehaves on your phone. |
| 2 | Tap **+**, add `45`, "chai" | The category is suggested as you type; saves with a 🎉. |
| 3 | **Airplane mode ON** (or Wi-Fi off). Add a spend (₹120, "Zomato") | Header shows **📴 Offline · 1**. Today's number and the Spent tile change **immediately**. Open **Insights**: totals, % split and Top leaks changed too. |
| 4 | Still offline: try chat add, `chai 20, auto 60` | Both entries appear; offline count goes up. |
| 5 | Still offline: swipe a card on the **Swipe** tab | The card flies away and the next one appears. (Rows marked ⏳ can't be swiped yet. That's by design until they sync.) |
| 6 | **Fully close the app** (swipe it away) and reopen it, still offline | Everything is still there, including the ⏳ rows. |
| 7 | **Airplane mode OFF** | Within ~15 seconds the 📴 chip disappears by itself, the ⏳ rows become normal rows. Check the PC: `http://localhost:8787/api/transactions?month=2026-10` (needs the token header) or just open More → Offline & sync: "All synced". |
| 8 | Kill the server (Ctrl+C in terminal 1), log a spend, restart it with `npm run phone` | The app keeps working; after the restart it syncs on its own. |
| 9 | More → **PIN lock**: set a PIN, switch apps and come back | PIN screen appears. 🧪 Fingerprint/Face unlock may behave differently in Expo Go (especially iPhone). |
| 10 | Money → **Bills** → add a bill, then **🧪 Send a test reminder in 10 seconds** and lock the phone | A notification arrives. 🧪 This is the first real test of notifications. (Expo Go supports local notifications; remote push isn't used.) |
| 11 | More → **Import**: pick a CSV, or the sample PDF (see below) | Preview with categories; PDFs ask for a password if locked. |
| 12 | Tap **💬 Ask** | Without an API key you'll get "needs an Anthropic API key". With one: see §4. |

### Getting the sample PDFs onto your phone (for #11)
```powershell
cd "D:\My Projects (Claude)\personal-ca\server"
npm run sample-pdfs
```
Files appear in `server\data\samples\` (`sample-statement.pdf`, and a locked twin with password `15031999`). Send them to your phone (email to yourself, Google Drive, USB, or Nearby Share/AirDrop), then pick them in the app.

## 3. If something goes wrong
| Symptom | Likely cause and fix |
|---|---|
| Expo Go: "Project is incompatible with this version" | Expo Go is older/newer than SDK 57. Update Expo Go. If it still refuses, tell me; the fix is a development build. |
| App opens but header says **📴 Offline** the whole time | The phone can't reach the PC. Same Wi-Fi? Server running via `npm run phone` (not `npm start`)? Try opening `http://192.168.0.150:8787/api/health` in your **phone's browser**: you should see `{"ok":true}`. If not: guest Wi-Fi isolation or firewall. Try the hotspot trick. |
| Header shows **🔑 Token** | The app's token doesn't match the server's. Nothing is lost. Stop Expo, run `npm run phone` again (rewrites `mobile/.env`), then `npx expo start -c`. |
| First launch is empty even though the server has data | Normal until the first sync. Pull to refresh or More → Sync now. |
| iPhone asks about "local network" | Allow it for Expo Go. |
| The IP address changed (router gave a new one) | Expo uses the current one automatically; just restart `npx expo start -c`. |

## 4. Ask your CA with a real key
Stop the server, then:
```powershell
cd "D:\My Projects (Claude)\personal-ca\server"
$env:ANTHROPIC_API_KEY="sk-ant-..."
npm run phone
```
Ask "How much did I spend this month?" It should answer from your numbers and show "🔎 Looked at: …". If you get "The AI request was rejected", run with `$env:CA_FALLBACK="off"` as well.

## 5. What to send me afterwards
Just the numbers of any rows that didn't match "You should see", plus any red message text. A screenshot is ideal. Things I most want to know: #1 (database opens), #6 (survives closing), #7 (auto-sync), #10 (notification), and which phone (Android/iPhone) you used.
