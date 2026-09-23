// Build one self-contained bundle per connections function (today: the media signer only).
//
// Output: dist/<function>/index.js (+ a source map), which lib/connections-stack.ts ships as the
// Lambda asset. Everything is bundled -- @emgloop/shared's pure signing module and the AWS SDK v3
// clients -- so the asset pins the SDK version rather than trusting the runtime's copy. No Prisma,
// no database: the signer never touches Neon.

import { build } from 'esbuild';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST = resolve(__dirname, '..', 'dist');

/** The syntax level the bundles are built for; it must match the Lambda runtime (nodejs24.x). */
export const BUNDLE_TARGET = 'node24';

export const CONNECTIONS_FUNCTIONS = [{ name: 'media-signer', entry: 'media-signer' }] as const;

async function main() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  for (const f of CONNECTIONS_FUNCTIONS) {
    const out = join(DIST, f.name);
    await build({
      entryPoints: [resolve(__dirname, '..', 'lambda', `${f.entry}.ts`)],
      outfile: join(out, 'index.js'),
      bundle: true,
      platform: 'node',
      target: BUNDLE_TARGET,
      format: 'cjs',
      sourcemap: true,
      minify: false,
      legalComments: 'none',
      external: [],
      logLevel: 'warning',
    });
    console.log(`${f.name}: ${(statSync(join(out, 'index.js')).size / 1024).toFixed(0)} KiB`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
