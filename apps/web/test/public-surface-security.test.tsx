// Unauthenticated surface — regression tests.
//
// /demo/timeline rendered the newest customer of the live organization (name,
// phone, email, message bodies) — or any organization's customer by id — to
// anyone on the internet, and /demo/intake let anyone create customers,
// interactions, AI assignments and bookings in that organization. Both routes,
// their modules and the unscoped repository reads they relied on are deleted.
//
// These tests pin that, and the wider property it exposed: a route reachable
// without a session must not read or write tenant data. They inventory every
// public page, every server action and every API route, so a new unguarded
// entry point fails here rather than in production.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as database from '@emgloop/database';
import { CustomerRepository, InteractionRepository, createRepositories } from '@emgloop/database';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(WEB, 'src');
const REPOS = fileURLToPath(new URL('../../../packages/database/src/repositories', import.meta.url));

const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const SOURCES = walk(SRC).filter((p) => /\.(ts|tsx)$/.test(p)).map((p) => ({ rel: relative(SRC, p), src: readFileSync(p, 'utf8') }));

/** Body of the function whose declaration starts at `from`, by brace matching. */
function bodyAt(src: string, from: number): string {
  let i = from;
  let paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')' && --paren === 0) break;
  }
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  return src.slice(open);
}

// ---------------------------------------------------------------------------

describe('The /demo surface is gone', () => {
  it('has no routes', () => {
    assert.equal(existsSync(join(SRC, 'app', 'demo')), false, 'src/app/demo must not exist');
  });

  it('keeps only the shared load-failure helper in src/demo', () => {
    assert.deepEqual(readdirSync(join(SRC, 'demo')), ['db-health.tsx']);
  });

  it('nothing links to, redirects to or recreates a /demo route', () => {
    for (const { rel, src } of SOURCES) {
      assert.equal(/['"`(]\/demo(\/|['"`?)\s])/.test(code(src)), false, `${rel} references a /demo route`);
    }
    for (const cfg of ['next.config.mjs']) {
      assert.equal(/\/demo/.test(readFileSync(join(WEB, cfg), 'utf8')), false, cfg);
    }
    assert.equal(/\/demo/.test(readFileSync(join(WEB, '..', '..', 'netlify.toml'), 'utf8')), false, 'netlify.toml');
  });

  it('the public intake generator and live-org seeding cannot be re-wired', () => {
    for (const { rel, src } of SOURCES) {
      assert.equal(
        /function (submitQuoteRequest|runQuoteToBooking|ensureDemoOrganization|ensureSeeded|getLatestCustomer)\b/.test(src),
        false,
        rel,
      );
    }
  });

  it('the Intake Board does not send an empty state to a data generator', () => {
    const board = readFileSync(join(SRC, 'app', 'crm', 'pipeline', 'page.tsx'), 'utf8');
    assert.equal(/\/demo\/intake|Run an/.test(code(board)), false);
  });
});

describe('No unscoped customer-data read remains for a route to reach', () => {
  it('customers, interactions and bookings cannot be read by id alone', () => {
    const customer = CustomerRepository.prototype as unknown as Record<string, unknown>;
    for (const m of ['findById', 'findLatest', 'createFromName', 'listByOrganization']) assert.equal(customer[m], undefined, `CustomerRepository.${m}`);
    assert.equal((InteractionRepository.prototype as unknown as Record<string, unknown>).timelineFor, undefined);
    assert.equal('BookingRepository' in database, false, 'BookingRepository (id-only read and update) is deleted');
    const registry = createRepositories({} as never) as unknown as Record<string, unknown>;
    assert.equal('bookings' in registry, false);
  });

  it('those repositories issue no query keyed only by a record or customer id', () => {
    for (const file of ['customer.repository.ts', 'interaction.repository.ts']) {
      const src = code(readFileSync(join(REPOS, file), 'utf8'));
      assert.equal(/where:\s*\{\s*(id|customerId)\s*\}/.test(src), false, file);
    }
  });
});

// ---------------------------------------------------------------------------

describe('Every page reachable without a session reads no tenant data', () => {
  // /crm is cookie-gated at the edge and every /crm page guards itself; /app
  // guards in its layouts. Everything else in src/app is public.
  // /terms and /privacy are the public legal documents (Terms of Service, Privacy Policy):
  // static server components in the (legal) route group, whose layout only loads the design
  // system's stylesheet. They must stay reachable without a session and must read nothing.
  const PUBLIC_PAGES = new Set(['page.tsx', 'login/page.tsx', 'status/page.tsx', 'dashboard/page.tsx', '(legal)/terms/page.tsx', '(legal)/privacy/page.tsx']);
  const DATA = /@emgloop\/database|crm\/crm-data|repositories|prisma|crmRepos/;

  const pages = walk(join(SRC, 'app'))
    .filter((p) => p.endsWith('page.tsx'))
    .map((p) => relative(join(SRC, 'app'), p).split('\\').join('/'))
    .filter((p) => !p.startsWith('crm/') && !p.startsWith('app/'));

  it('the public page inventory is exactly the reviewed set', () => {
    assert.deepEqual(pages.sort(), [...PUBLIC_PAGES].sort());
  });

  it('no public page imports a data layer', () => {
    for (const p of pages) {
      assert.equal(DATA.test(readFileSync(join(SRC, 'app', p), 'utf8')), false, p);
    }
  });
});

describe('Every server action authenticates, except the reviewed sign-in flows', () => {
  const BASE_GUARD = /\b(requirePermission|requireWorkspace|requireWorkspaceSession|requireCrmContext|getSession)\(/;
  // Reachable before sign-in by design: each is token-, credential- or rate-limited.
  const PUBLIC_ACTIONS = new Set([
    'loginAction', 'logoutAction', 'loopLoginAction',
    'requestResetAction', 'resetPasswordAction', 'acceptInviteAction',
    'submitAccessRequest',
  ]);

  // An exported require* helper that itself calls a base guard counts as a guard.
  const helperGuards = new Set<string>();
  for (const { src } of SOURCES) {
    for (const m of src.matchAll(/export async function (require\w+)\s*\(/g)) {
      if (BASE_GUARD.test(bodyAt(src, m.index!))) helperGuards.add(m[1]!);
    }
  }

  const actions = SOURCES.filter(({ src }) => /^['"]use server['"]/m.test(src));

  it('finds the server action modules', () => {
    assert.ok(actions.length >= 15, `found ${actions.length}`);
  });

  it('each exported action calls a guard before it can read or write', () => {
    const unguarded: string[] = [];
    for (const { rel, src } of actions) {
      const localGuards = new Set<string>();
      for (const m of src.matchAll(/(?:^|\n)(?:export )?async function (\w+)\s*\(/g)) {
        if (BASE_GUARD.test(bodyAt(src, m.index! + m[0].indexOf('async')))) localGuards.add(m[1]!);
      }
      for (const m of src.matchAll(/export async function (\w+)\s*\(/g)) {
        const name = m[1]!;
        if (PUBLIC_ACTIONS.has(name)) continue;
        const body = code(bodyAt(src, m.index!));
        const calls = new Set([...body.matchAll(/\b(\w+)\(/g)].map((c) => c[1]!));
        const guarded = BASE_GUARD.test(body)
          || [...calls].some((c) => helperGuards.has(c) || (localGuards.has(c) && c !== name));
        if (!guarded) unguarded.push(`${rel}::${name}`);
      }
    }
    assert.deepEqual(unguarded, []);
  });
});

describe('Every API route authenticates, except static public endpoints', () => {
  // `authenticateBrainWorkerRequest` (B5) verifies a pinned-key worker token; brain-boundary.test.tsx
  // proves each internal Brain route calls it before anything else.
  // `getSessionBinding` resolves the same signed session as `getSession` and also returns its
  // row id (the Google connect routes bind their state to it).
  // `apiCaller` (creator API routes) resolves the same signed session through `getSession` and
  // answers 401/403 itself. `verifyLocalMediaToken` is the expiring per-request HMAC behind the
  // DEV-ONLY local media disk route (`@emgloop/providers`, timing-safe), which also answers 404 on
  // any production runtime before reading the token.
  const AUTH = /getSession\(|getSessionBinding\(|\bcan\(|requireCrmContext\(|requirePermission\(|authenticateService\(|verifyWebhook|timingSafeEqual|LOOP_EVENT_SECRET|authenticateBrainWorkerRequest\(|apiCaller\(|verifyLocalMediaToken\(/;
  const PUBLIC_ROUTES = new Set(['health/route.ts', 'sdk/config/route.ts', 'sdk/emg-loop/route.ts']);
  const DB_ACCESS = /repositories\.|prisma\.|crmRepos|\.findMany\(|\.findFirst\(|\.create\(/;

  const routes = walk(join(SRC, 'app', 'api')).filter((p) => p.endsWith('route.ts'));

  it('each route authenticates, inherits authentication, or is a reviewed public endpoint', () => {
    for (const p of routes) {
      const rel = relative(join(SRC, 'app', 'api'), p).split('\\').join('/');
      const src = readFileSync(p, 'utf8');
      if (PUBLIC_ROUTES.has(rel)) {
        assert.equal(DB_ACCESS.test(code(src)), false, `${rel} is public and must not touch the database`);
        continue;
      }
      const reexport = code(src).match(/export \{[^}]+\} from '(\.[^']+)'/);
      const effective = reexport ? readFileSync(join(p, '..', reexport[1]! + '.ts'), 'utf8') : src;
      assert.match(effective, AUTH, `${rel} has no authentication`);
    }
  });
});
