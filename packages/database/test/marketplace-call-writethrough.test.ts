// MarketplaceCall write-through — regression tests for the empty-read-model incident.
//
// Live reconciliation, 2026-07-18: CallGrid 108 records, Loop 0 records.
//
// Cause: ingestion wrote the Interaction and stopped. Nothing in the ingestion
// path referenced MarketplaceCall at all; the only population route was a lazy
// backfill triggered by loading the Brain admin page, scoped to that page's own
// 7-day window, and only when that window was already empty.
//
// These tests pin the two properties that failure depended on: that ingestion
// now projects, and that a projection failure can never take ingestion down
// with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectInteractionToMarketplaceCall } from '../src/repositories/marketplace-call-projection';

const SRC = join(__dirname, '..', 'src', 'services', 'ingestion.service.ts');
const ingestionSource = readFileSync(SRC, 'utf8');

// --- The structural gap that caused the incident ---------------------------

test('the ingestion service projects into MarketplaceCall', () => {
  // Before the fix this file contained no reference to MarketplaceCall at all,
  // which is precisely why the read model was empty.
  assert.match(ingestionSource, /MarketplaceCallRepository/, 'must import the repository');
  assert.match(ingestionSource, /projectInteraction\(/, 'must call the projection');
});

test('the projection is wrapped so it can never fail ingestion', () => {
  // The Interaction is the source of truth and the projection is rebuildable.
  // If projection could throw, a read-model bug would become lost provider data
  // and the webhook would return non-2xx, triggering CallGrid retries for an
  // event already stored.
  const idx = ingestionSource.indexOf('projectInteraction(');
  assert.ok(idx > 0);
  const surrounding = ingestionSource.slice(Math.max(0, idx - 700), idx + 400);
  assert.match(surrounding, /try\s*{/, 'must be inside a try block');
  assert.match(surrounding, /catch/, 'must catch');
  assert.doesNotMatch(surrounding, /throw\s+error/, 'must not rethrow');
});

// --- The pure mapper's contract, which decides what gets projected ---------

const base = {
  id: 'int_1',
  organizationId: 'org_1',
  provider: 'callgrid',
  externalId: 'cg_1',
  channel: 'PHONE',
  occurredAt: new Date('2026-07-18T10:00:00.000Z'),
  metadata: { revenue: '25.50', buyer: 'Acme' },
  customer: { tags: [], email: 'real@northsideplumbing.co', phone: null, externalId: null, firstName: 'A', lastName: 'B' },
};

test('a well-formed CallGrid interaction projects', () => {
  const p = projectInteractionToMarketplaceCall(base as never);
  assert.ok(p, 'must project');
  assert.equal(p!.provider, 'callgrid');
  assert.equal(p!.externalId, 'cg_1');
  assert.equal(p!.interactionId, 'int_1');
  assert.equal(p!.revenueCents, 2550, 'dollars are converted to cents once');
});

test('rows the mapper legitimately declines are identifiable, not silent failures', () => {
  // Each of these returns null by design. They are the reason `skipped` is
  // reported separately from `projected` in the backfill response — a high skip
  // count is a mapping signal, not a crash.
  assert.equal(projectInteractionToMarketplaceCall({ ...base, channel: 'EMAIL' } as never), null, 'non-PHONE');
  assert.equal(projectInteractionToMarketplaceCall({ ...base, provider: null } as never), null, 'no provider');
  assert.equal(projectInteractionToMarketplaceCall({ ...base, externalId: null } as never), null, 'no externalId');
  assert.equal(
    projectInteractionToMarketplaceCall({
      ...base,
      customer: { ...base.customer, email: 'qa@example.com' },
    } as never),
    null,
    'excluded demo/test customer',
  );
});

test('projection is deterministic, so re-running a backfill is safe', () => {
  // projectWindow upserts on (provider, externalId); identical input must yield
  // an identical row or a retry would not be idempotent.
  const a = projectInteractionToMarketplaceCall(base as never);
  const b = projectInteractionToMarketplaceCall(base as never);
  assert.deepEqual(a, b);
});

test('absent economics stay null and are never defaulted to zero', () => {
  const p = projectInteractionToMarketplaceCall({ ...base, metadata: {} } as never);
  assert.ok(p);
  assert.equal(p!.revenueCents, null, 'unknown revenue is null, not 0');
  assert.equal(p!.payoutCents, null);
  assert.equal(p!.monetized, null, 'a missing flag is unknown, not false');
});
