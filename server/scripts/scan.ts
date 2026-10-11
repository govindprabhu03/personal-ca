// Pre-release hygiene scan over everything git tracks:
//   1. garbled text (UTF-8 that was re-read as Windows-1252: Ã©, â€”, â‚¹, ðŸ…), which a PowerShell rewrite can cause
//   2. secrets: the keystore passwords and any access token on this machine must never appear in tracked files
// Exit code 1 on any finding. Run via `npm run verify`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const TEXT = /\.(ts|tsx|js|jsx|json|md|html|css|txt|ya?ml)$/i;

// a lead byte read as a Latin-1/cp1252 letter, then a continuation byte read as cp1252 punctuation  (written as escapes so this file is clean itself)
const GARBLED = /[ÂÃâð][\u0080-¿ŒœŠšŸŽžƒˆ˜–-›€™]/;

const secrets: string[] = [];
const take = (v: unknown) => { if (typeof v === 'string' && v.length >= 8) secrets.push(v); };
const credFile = path.join(root, 'mobile', 'credentials.json');
if (existsSync(credFile)) { try { const k = JSON.parse(readFileSync(credFile, 'utf8')).android?.keystore ?? {}; take(k.keystorePassword); take(k.keyPassword); } catch { /* unreadable: nothing to guard */ } }
for (const f of [path.join(root, 'server', 'data', '.phone-token'), path.join(process.env.APPDATA ?? '', 'PersonalCA', 'token.txt')]) {
  if (f && existsSync(f)) take(readFileSync(f, 'utf8').trim());
}

const problems: string[] = [];
for (const rel of tracked) {
  if (/(^|\/)(credentials\.json|.*\.keystore|.*\.jks|\.env.*)$/.test(rel)) problems.push(`${rel}: a secrets file is tracked by git`);
  if (!TEXT.test(rel) || /package-lock\.json$/.test(rel)) continue;
  const full = path.join(root, rel);
  if (!existsSync(full)) continue;
  const lines = readFileSync(full, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (GARBLED.test(line)) problems.push(`${rel}:${i + 1}: garbled text  ${line.trim().slice(0, 60)}`);
    for (const s of secrets) if (line.includes(s)) problems.push(`${rel}:${i + 1}: contains a secret value`);
  });
}
if (problems.length) { console.error(problems.slice(0, 30).join('\n') + `\n\n${problems.length} problem(s) found.`); process.exit(1); }
console.log(`scan ok: ${tracked.length} tracked files, ${secrets.length} secret value(s) checked`);
