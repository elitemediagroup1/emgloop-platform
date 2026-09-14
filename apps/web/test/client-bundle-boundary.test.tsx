// Client components never pull the database into the browser.
//
// The People page crashed on the client ("Application error: a client-side
// exception has occurred") because its BulkBar -- a 'use client' component --
// imported one constant from @emgloop/database. That package's entry constructs
// a PrismaClient as it loads; bundled for the browser, Prisma throws on first
// touch, so the whole page failed to hydrate, whether opened directly or from
// the sidebar. Type-checking and `next build` both passed.
//
// This walks the module graph every 'use client' file ships to the browser:
// its imports, and theirs, through local files. A 'use server' module is not
// followed -- the bundler replaces it with references to server actions -- and
// type-only imports are erased. Nothing reachable may import the database
// package, Prisma, or a server-only module.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const FORBIDDEN = [/^@emgloop\/database(\/|$)/, /^@prisma\/client(\/|$)/, /^server-only$/];

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
});

// The first statement decides the module's boundary, as it does for Next.
function directive(src: string): 'client' | 'server' | null {
  const body = src.replace(/^(\s*(\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*/, '');
  if (/^['"]use client['"]/.test(body)) return 'client';
  if (/^['"]use server['"]/.test(body)) return 'server';
  return null;
}

/** Runtime (non type-only) module specifiers a file imports or re-exports. */
function runtimeImports(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const out: string[] = [];
  // One statement at a time: a clause never crosses a semicolon.
  const statement = /\b(import|export)\s+(type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(statement)) {
    if (m[2]) continue; // `import type` / `export type`
    const clause = m[3]!.trim();
    const named = clause.match(/^\{([\s\S]*)\}$/);
    if (named && named[1]!.split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '))) continue;
    out.push(m[4]!);
  }
  for (const m of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push(m[1]!); // side-effect import
  for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!); // dynamic import
  return out;
}

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every forbidden import reachable from a client entry, with the path that reaches it. */
function forbiddenReachable(entry: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const visit = (file: string, trail: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    if (trail.length > 0 && directive(src) === 'server') return; // shipped as action references only
    for (const spec of runtimeImports(src)) {
      const here = [...trail, relative(SRC, file)];
      if (FORBIDDEN.some((f) => f.test(spec))) {
        found.push(`${here.join(' → ')} imports ${spec}`);
      } else if (spec.startsWith('.') || spec.startsWith('@/')) {
        const next = resolveLocal(file, spec);
        if (next) visit(next, here);
      }
    }
  };
  visit(entry, []);
  return found;
}

const CLIENT_ENTRIES = walk(SRC).filter((f) => directive(readFileSync(f, 'utf8')) === 'client');

describe('Client components never ship the database to the browser', () => {
  it('finds the client components it is guarding', () => {
    const names = CLIENT_ENTRIES.map((f) => relative(SRC, f));
    assert.ok(names.includes('app/crm/customers/bulk-bar.tsx'), 'the People bulk bar is a client component');
    assert.ok(names.length >= 5, names.join(', '));
  });

  it('no client component reaches @emgloop/database, @prisma/client or server-only', () => {
    const violations = CLIENT_ENTRIES.flatMap(forbiddenReachable);
    assert.deepEqual(violations, []);
  });

  it('the People bulk bar gets its statuses from the server page', () => {
    const bar = readFileSync(join(SRC, 'app/crm/customers/bulk-bar.tsx'), 'utf8');
    assert.equal(runtimeImports(bar).some((s) => s.startsWith('@emgloop/database')), false);
    assert.match(bar, /export function BulkBar\(\{ tags, statuses \}: \{ tags: string\[\]; statuses: readonly string\[\] \}\)/);
    const page = readFileSync(join(SRC, 'app/crm/customers/page.tsx'), 'utf8');
    assert.match(page, /<BulkBar tags=\{tags\} statuses=\{PIPELINE_STATUSES\} \/>/);
    assert.match(page, /await requirePermission\('customers', 'view'\);/, 'the page still authorizes before any read');
  });

  it('the detector sees what bundles: runtime imports count, type-only imports and server actions do not', () => {
    assert.deepEqual(runtimeImports(`import { PIPELINE_STATUSES } from '@emgloop/database';`), ['@emgloop/database']);
    assert.deepEqual(runtimeImports(`import {\n  a,\n  b,\n} from '@emgloop/database';`), ['@emgloop/database']);
    assert.deepEqual(runtimeImports(`import type { PipelineStatus } from '@emgloop/database';`), []);
    assert.deepEqual(runtimeImports(`import { type PipelineStatus } from '@emgloop/database';`), []);
    assert.deepEqual(runtimeImports(`import { type A, B } from '@emgloop/database';`), ['@emgloop/database']);
    assert.deepEqual(runtimeImports(`export { x } from '@prisma/client';`), ['@prisma/client']);
    assert.deepEqual(runtimeImports(`import 'server-only';`), ['server-only']);
    assert.deepEqual(runtimeImports(`export type Row = { a: string; };\nimport { x } from '@emgloop/database';`), ['@emgloop/database']);
    assert.equal(directive(`'use server';\nimport { repositories } from '@emgloop/database';`), 'server');
    assert.equal(directive(`// header\n'use client';\nimport x from 'y';`), 'client');
  });
});
