// Builds release/PersonalCA.exe:  npm run build:exe
//   1. exports the web version of the app           (mobile/dist)
//   2. bundles the server into ONE JavaScript file   (esbuild)
//   3. bakes both into a copy of node.exe            (Node "single executable application" + postject)
// The result is one file you can double-click: server + web app, no Node or npm needed on the machine that runs it.
import { execFileSync, execSync } from 'node:child_process';
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
const server = path.join(root, 'server');
const release = path.join(root, 'release');
const work = path.join(release, 'build');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  console.log('1/5  Exporting the web app...');
  // The web bundle is PUBLIC to everyone on your network, so no secret may ever be baked into it. Clear the token and the server address.
  execSync('npx expo export --platform web --output-dir dist', {
    cwd: path.join(root, 'mobile'), stdio: 'inherit',
    env: { ...process.env, CI: '1', EXPO_PUBLIC_API_TOKEN: '', EXPO_PUBLIC_API_URL: undefined as unknown as string },
  });
  const dist = path.join(root, 'mobile', 'dist');
  if (!existsSync(path.join(dist, 'index.html'))) throw new Error('The web export produced no index.html');
  const files = walk(dist);
  const tokenFile = path.join(server, 'data', '.phone-token');
  if (existsSync(tokenFile)) {
    const secret = readFileSync(tokenFile, 'utf8').trim();
    const leaked = files.filter((f) => /\.(js|html|json|map)$/.test(f) && readFileSync(f, 'utf8').includes(secret));
    if (leaked.length) throw new Error(`Your access token was found inside the web export (${path.basename(leaked[0])}). Refusing to build.`);
  }
  console.log(`     ${files.length} web files`);

  console.log('2/5  Bundling the server...');
  await build({
    entryPoints: [path.join(server, 'src', 'exe.ts')], bundle: true, platform: 'node', target: 'node24', format: 'cjs',
    outfile: path.join(work, 'server.cjs'), legalComments: 'none', logLevel: 'warning',
    // some libraries ask where they live (import.meta.url); inside the .exe the answer is the .exe itself
    banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(process.execPath).href;" },
    define: { 'import.meta.url': '__importMetaUrl' },
  });
  console.log(`     ${mb(statSync(path.join(work, 'server.cjs')).size)} bundled`);

  console.log('3/5  Preparing the single-executable blob...');
  const assets: Record<string, string> = {};
  for (const f of files) assets[`web/${path.relative(dist, f).split(path.sep).join('/')}`] = f;
  const seaConfig = path.join(work, 'sea-config.json');
  writeFileSync(seaConfig, JSON.stringify({ main: path.join(work, 'server.cjs'), output: path.join(work, 'sea-prep.blob'), disableExperimentalSEAWarning: true, useCodeCache: false, assets }));
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

  console.log('4/5  Creating the .exe from this machine\'s Node...');
  const exe = path.join(release, 'PersonalCA.exe');
  copyFileSync(process.execPath, exe);
  execSync(`npx postject "${exe}" NODE_SEA_BLOB "${path.join(work, 'sea-prep.blob')}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`, { cwd: server, stdio: 'inherit' });

  console.log(`5/5  Done: ${exe}  (${mb(statSync(exe).size)})`);
}
main().catch((e) => { console.error('\nBuild failed:', e.message ?? e); process.exit(1); });
