import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isDemoSeedEnabled, seedMayActivate } from '../src/demo-seed';

// Production-safety regression suite (Blocker 1). The demo bootstrap used to run
// on every cold start and resurrect removed team members. These pin the gate that
// makes production fail closed, and the rule that a removed member is never
// reactivated by a seed.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

// --- isDemoSeedEnabled: fail closed --------------------------------------------

test('unset flag never seeds — the default everywhere, including production', () => {
  assert.equal(isDemoSeedEnabled({}), false);
  assert.equal(isDemoSeedEnabled({ NODE_ENV: 'development' }), false);
  assert.equal(isDemoSeedEnabled({ NODE_ENV: 'production' }), false);
});

test('flag alone is not enough — production runtime hard-blocks it', () => {
  // production host wins even with the flag on
  assert.equal(isDemoSeedEnabled({ EMG_SEED_DEMO: 'true' }, 'app.emgloop.com'), false);
  // Netlify production context blocks it
  assert.equal(isDemoSeedEnabled({ EMG_SEED_DEMO: 'true', CONTEXT: 'production' }), false);
  // NODE_ENV=production with no other signal blocks it
  assert.equal(isDemoSeedEnabled({ EMG_SEED_DEMO: 'true', NODE_ENV: 'production' }), false);
});

test('flag + non-production runtime enables seeding (review/dev only)', () => {
  assert.equal(isDemoSeedEnabled({ EMG_SEED_DEMO: 'true', NODE_ENV: 'development' }), true);
  // a deploy-preview netlify host is explicitly non-production even if NODE_ENV=production
  assert.equal(isDemoSeedEnabled({ EMG_SEED_DEMO: 'true', NODE_ENV: 'production' }, 'deploy-preview-42--emgloop.netlify.app'), true);
  // Netlify branch/preview context
  assert.equal(isDemoSeedEnabled({ EMG_SEED_DEMO: 'true', CONTEXT: 'deploy-preview' }), true);
});

test('the flag must be exactly "true" — no truthy coercion', () => {
  assert.equal(isDemoSeedEnabled({ EMG_SEED_DEMO: '1', NODE_ENV: 'development' }), false);
  assert.equal(isDemoSeedEnabled({ EMG_SEED_DEMO: 'TRUE', NODE_ENV: 'development' }), false);
  assert.equal(isDemoSeedEnabled({ EMG_SEED_DEMO: 'yes', NODE_ENV: 'development' }), false);
});

// --- seedMayActivate: a removed member is never resurrected ---------------------

test('a DISABLED (removed/disabled) member is never reactivated by a seed', () => {
  assert.equal(seedMayActivate('DISABLED', false), false);
});

test('a seed may activate a freshly-created or still-pending row', () => {
  assert.equal(seedMayActivate('INVITED', true), true);  // just created
  assert.equal(seedMayActivate('INVITED', false), true); // pending acceptance
});

test('an already-ACTIVE member is a no-op (nothing to reactivate)', () => {
  assert.equal(seedMayActivate('ACTIVE', false), false);
});

// --- static assertion: no ungated demo identities in production bootstrap ------

const DEMO_IDENTITIES = ['viewer@emgloop.com', 'manager@emgloop.com', 'Riley Viewer', 'Morgan Manager'];

test('the identity bootstrap gates every demo identity behind the seed flag', () => {
  const src = readFileSync(join(repoRoot, 'apps/web/src/auth/bootstrap.ts'), 'utf8');
  assert.ok(
    src.includes('demoSeedAllowed') && src.includes('isDemoSeedEnabled'),
    'bootstrap must gate seeding behind the fail-closed demo-seed predicate',
  );
  // The fail-closed early return must run BEFORE any demo identity is WRITTEN.
  // Anchor on the quoted data literals (the ensureUser args) so an explanatory
  // comment mentioning the fakes by name does not count as a write.
  const gateAt = src.indexOf('if (!demoSeedAllowed())');
  assert.ok(gateAt >= 0, 'the fail-closed early return must be present');
  const writeMarkers = ["'manager@emgloop.com'", "'viewer@emgloop.com'"];
  for (const marker of writeMarkers) {
    const at = src.indexOf(marker);
    assert.ok(at >= 0, `bootstrap is the expected home of ${marker}`);
    assert.ok(gateAt < at, `seeding of ${marker} must be gated behind the demo-seed flag`);
  }
});

test('the Prisma seed script contains no known demo team identities', () => {
  const src = readFileSync(join(repoRoot, 'packages/database/prisma/seed.ts'), 'utf8');
  for (const id of DEMO_IDENTITIES) {
    assert.ok(!src.includes(id), `prisma/seed.ts must not reference ${id}`);
  }
});
