// Bundles the Vercel entry into ONE file, api/index.js, so the deployed function has no build-time surprises (same approach as the .exe).
// Vercel runs this as the project's build command (see vercel.json); run it locally with `npm run build:vercel` to check it bundles.
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import path from 'node:path';

const server = path.resolve(__dirname, '..');
build({
  entryPoints: [path.join(server, 'src', 'vercel.ts')], bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  outfile: path.join(server, 'api', 'index.js'), legalComments: 'none', logLevel: 'warning',
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__importMetaUrl' },
  footer: { js: 'module.exports = module.exports.default;' }, // Vercel calls module.exports as the handler
}).then(() => console.log(`api/index.js  ${(statSync(path.join(server, 'api', 'index.js')).size / 1048576).toFixed(1)} MB`));
