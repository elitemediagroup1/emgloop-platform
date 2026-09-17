// Build one self-contained bundle per Brain function. Slice B6.
//
// Output: dist/<function>/index.js (+ a source map), and for the functions that reach
// Neon, the generated Prisma client with only the Lambda engine (rhel-openssl-3.0.x,
// already a binary target in schema.prisma, so the schema is unchanged).
// Metafiles go to dist/meta/, outside the assets, for the bundle fence.

import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..');
const DIST = resolve(__dirname, '..', 'dist');

/** The syntax level the bundles are built for; it must match the Lambda runtime (nodejs24.x). */
export const BUNDLE_TARGET = 'node24';

export const BRAIN_FUNCTIONS = [
  { name: 'authorizer', entry: 'authorizer', database: false },
  { name: 'dispatcher', entry: 'dispatcher', database: true },
  { name: 'worker-interactive', entry: 'worker', database: true },
  { name: 'worker-durable', entry: 'worker', database: true },
  { name: 'sweeper', entry: 'sweeper', database: true },
] as const;

function copyPrisma(target: string) {
  const modules = join(target, 'node_modules');
  cpSync(join(ROOT, 'node_modules', '@prisma', 'client'), join(modules, '@prisma', 'client'), { recursive: true, dereference: true });
  cpSync(join(ROOT, 'node_modules', '.prisma', 'client'), join(modules, '.prisma', 'client'), {
    recursive: true,
    dereference: true,
    // Only the engine Lambda runs; the development engine would double the asset.
    filter: (src) => !/libquery_engine-(?!rhel-openssl-3\.0\.x)/.test(src),
  });
}

function sizeOf(dir: string): number {
  return readdirSync(dir).reduce((n, f) => {
    const p = join(dir, f);
    const s = statSync(p);
    return n + (s.isDirectory() ? sizeOf(p) : s.size);
  }, 0);
}

async function main() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(join(DIST, 'meta'), { recursive: true });
  for (const f of BRAIN_FUNCTIONS) {
    const out = join(DIST, f.name);
    const result = await build({
      entryPoints: [resolve(__dirname, '..', 'lambda', `${f.entry}.ts`)],
      outfile: join(out, 'index.js'),
      bundle: true,
      platform: 'node',
      target: BUNDLE_TARGET,
      format: 'cjs',
      sourcemap: true,
      minify: false,
      metafile: true,
      legalComments: 'none',
      external: f.database ? ['@prisma/client', '.prisma/client'] : [],
      logLevel: 'warning',
    });
    writeFileSync(join(DIST, 'meta', `${f.name}.json`), JSON.stringify(result.metafile));
    if (f.database) copyPrisma(out);
    console.log(`${f.name}: ${(sizeOf(out) / 1_048_576).toFixed(1)} MiB`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
