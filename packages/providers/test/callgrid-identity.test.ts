// Canonical CallGrid call identity.
//
// WHAT THESE PROVE
//
// One rule, two ingress paths, and no way to manufacture a call.
//
// The defect these pin is not "a weaker identity". A fabricated id is a
// DIFFERENT CALL every time it is computed: it can never match the provider's
// identity, so reconciliation reports the same record as both providerOnly and
// localOnly — one gap counted twice, in opposite directions — and because the
// fallbacks used `Date.now()` (webhook) and `Date.now() + Math.random()` (REST),
// two evaluations of one record produced two canonical calls. A poller
// re-reading an overlap window would have minted a new one on every pass.
//
// So the load-bearing test here is not "a bad record is refused". It is that a
// bad record refused TWICE produces the same refusal and zero canonical records,
// which is what makes an overlap window safe to re-read at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CALLGRID_IDENTITY_FIELDS,
  NO_IDENTITY_MESSAGE,
  resolveCallGridIdentity,
} from '../src/adapters/callgrid-identity';
import { CallGridApiError, mapCallGridApiRecord } from '../src/adapters/callgrid-api';
import { CallGridProvider } from '../src/adapters/callgrid.provider';
import type { ProviderContext } from '../src/types';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'adapters');
/**
 * Source with prose removed — line comments and block-comment bodies alike.
 *
 * The structural checks below are about CODE. The identity module's own header
 * deliberately QUOTES the two fabricated fallbacks it replaces, and names the
 * reconciliation counters they corrupted, because that is the explanation for
 * why the file exists. Scanning the prose would fail the very tests that prove
 * the code is clean.
 */
const codeOf = (path: string): string =>
  readFileSync(join(SRC, path), 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const PROVIDER_SOURCE = codeOf('callgrid.provider.ts');
const API_SOURCE = codeOf('callgrid-api.ts');
const IDENTITY_SOURCE = codeOf('callgrid-identity.ts');

const CTX: ProviderContext = { organizationId: 'org_1' };
const provider = new CallGridProvider();

/** A well-formed record: real id, real occurrence. Occurrence is never the subject here. */
function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cmsns65v8be2d07k368ox69s9',
    occurredAtUnix: '1786399137',
    callStatus: 'completed',
    campaignId: 'cmp-1',
    ...over,
  };
}

/** Both ingress paths, driven through their real entry points. */
const PATHS = [
  {
    name: 'webhook',
    run: async (r: Record<string, unknown>) => (await provider.parseWebhook(CTX, r))[0],
  },
  {
    name: 'REST',
    run: async (r: Record<string, unknown>) => mapCallGridApiRecord(r),
  },
] as const;

// --- 1, 2, 11, 12: valid identity is unchanged -------------------------------------

test('1/11/12. `id` is accepted on both paths, and valid behaviour is unchanged', async () => {
  for (const path of PATHS) {
    const event = await path.run(record());
    assert.equal(event?.externalId, 'cmsns65v8be2d07k368ox69s9', `${path.name} must keep the real id`);
    assert.ok(event?.occurredAt instanceof Date, `${path.name} occurrence is untouched`);
    assert.equal(
      event?.occurredAt.toISOString(),
      '2026-08-10T21:58:57.000Z',
      'string Unix seconds still resolve exactly as before',
    );
  }
});

test('2. every alias both paths already supported is still accepted', async () => {
  for (const key of CALLGRID_IDENTITY_FIELDS) {
    const r = record();
    delete r.id;
    r[key] = 'real-provider-id';
    for (const path of PATHS) {
      const event = await path.run(r);
      assert.equal(event?.externalId, 'real-provider-id', `${path.name} must accept ${key}`);
    }
  }
});

test('2b. `id` still wins when several spellings are present', () => {
  assert.equal(
    resolveCallGridIdentity({ id: 'first', CallId: 'second', sid: 'third' }),
    'first',
    'precedence is unchanged, so no record that resolved before resolves differently',
  );
});

test('2c. a numeric id is accepted; a boolean is not an identity', () => {
  assert.equal(resolveCallGridIdentity({ id: 4815162342 }), '4815162342');
  // `pick`/`pickField` stringify booleans for FLAG fields (billable, converted,
  // paid, noRoute) and say so. Reading that allowance as an identity would make
  // "true" a call id shared by every such record.
  assert.equal(resolveCallGridIdentity({ id: true }), null);
  assert.equal(resolveCallGridIdentity({ id: false }), null);
  assert.equal(resolveCallGridIdentity({ id: Number.NaN }), null);
});

// --- 3, 4, 5, 9, 10: refusal ------------------------------------------------------

test('3/9/10. a record with no identity field is refused on BOTH paths', async () => {
  const r = record();
  delete r.id;
  await assert.rejects(() => PATHS[0].run(r), /no usable call id/, 'webhook must refuse');
  assert.throws(() => mapCallGridApiRecord(r), /no usable call id/, 'REST must refuse');
});

test('4. a blank or whitespace-only identity is absent, not empty', async () => {
  for (const blank of ['', '   ', '\t\n']) {
    assert.equal(resolveCallGridIdentity({ id: blank }), null);
    await assert.rejects(() => PATHS[0].run(record({ id: blank })));
    assert.throws(() => mapCallGridApiRecord(record({ id: blank })));
  }
});

test('5. a null or undefined identity is refused', async () => {
  for (const value of [null, undefined]) {
    assert.equal(resolveCallGridIdentity({ id: value }), null);
    await assert.rejects(() => PATHS[0].run(record({ id: value })));
    assert.throws(() => mapCallGridApiRecord(record({ id: value })));
  }
});

test('9b. the REST refusal uses the existing typed error vocabulary', () => {
  const r = record();
  delete r.id;
  try {
    mapCallGridApiRecord(r);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof CallGridApiError);
    // A new member of the existing closed kind union, mirroring 'no-occurrence'
    // — the precedent for unusable provider data on this path.
    assert.equal((err as CallGridApiError).kind, 'no-identity');
    assert.equal((err as CallGridApiError).status, undefined, 'not an HTTP failure');
  }
});

test('10b. both paths report the same fact, from one message', async () => {
  const r = record();
  delete r.id;
  const webhookError = await PATHS[0].run(r).then(
    () => null,
    (e: unknown) => (e as Error).message,
  );
  const restError = (() => {
    try {
      mapCallGridApiRecord(r);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  })();
  assert.equal(webhookError, NO_IDENTITY_MESSAGE);
  assert.equal(restError, NO_IDENTITY_MESSAGE);
});

// --- 6, 7, 8: THE REGRESSION THAT MATTERS -----------------------------------------

test('8. THE SAME MALFORMED RECORD, EVALUATED REPEATEDLY, PRODUCES ONE REFUSAL AND ZERO CALLS', async () => {
  // The property that makes an overlap window safe to re-read. Under the old
  // fallbacks these twenty evaluations produced twenty distinct canonical calls.
  const r = record();
  delete r.id;

  const identities = new Set<string | null>();
  const messages = new Set<string>();
  for (let i = 0; i < 20; i += 1) {
    identities.add(resolveCallGridIdentity(r));
    try {
      mapCallGridApiRecord(r);
      assert.fail('should have thrown');
    } catch (e) {
      messages.add((e as Error).message);
    }
    await assert.rejects(() => PATHS[0].run(r));
  }
  assert.deepEqual([...identities], [null], 'one answer, twenty times');
  assert.equal(messages.size, 1, 'one refusal, twenty times');
});

test('6/7. no synthetic identifier can be generated — no clock, no randomness', () => {
  for (const source of [IDENTITY_SOURCE, PROVIDER_SOURCE, API_SOURCE]) {
    assert.ok(!/'callgrid-'\s*\+/.test(source), 'the webhook fallback is gone');
    assert.ok(!/'callgrid-api-'\s*\+/.test(source), 'the REST fallback is gone');
  }
  // Neither ingredient of a fabricated id survives in the identity module.
  assert.ok(!IDENTITY_SOURCE.includes('Date.now'));
  assert.ok(!IDENTITY_SOURCE.includes('Math.random'));
  assert.ok(!IDENTITY_SOURCE.includes('randomUUID'));
  assert.ok(!IDENTITY_SOURCE.includes('createHash'));
  // And identity is never derived from something that is not identity.
  for (const forbidden of ['occurredAt', 'campaignId', 'JSON.stringify']) {
    assert.ok(!IDENTITY_SOURCE.includes(forbidden), `identity must not be derived from ${forbidden}`);
  }
});

test('6b. there is ONE canonical-id rule, and both paths call it', () => {
  assert.ok(PROVIDER_SOURCE.includes('resolveCallGridIdentity'), 'webhook uses the shared rule');
  assert.ok(API_SOURCE.includes('resolveCallGridIdentity'), 'REST uses the shared rule');
  // No path may keep a private alias list.
  assert.ok(!/pick\(data, \['id'/.test(PROVIDER_SOURCE));
  assert.ok(!/pickField\(record, \['id'/.test(API_SOURCE));
});

// --- 13, 14, 15: nothing else moved -------------------------------------------------

test('13. reconciliation identity semantics are untouched', () => {
  // `normalizeExternalIdentity` in @emgloop/shared is what reconciliation
  // compares with. This PR changes what reaches it, never how it judges.
  assert.ok(!IDENTITY_SOURCE.includes('normalizeExternalIdentity'));
  assert.ok(!IDENTITY_SOURCE.includes('providerOnly'));
  assert.ok(!IDENTITY_SOURCE.includes('localOnly'));
});

test('14. occurrence and timestamp semantics are untouched', async () => {
  assert.ok(!IDENTITY_SOURCE.includes('resolveCallOccurrence'));
  // The occurrence refusal still fires, still on its own terms, and is still
  // reported separately from the identity refusal.
  const noTime = record();
  delete noTime.occurredAtUnix;
  await assert.rejects(() => PATHS[0].run(noTime), /occurrence timestamp/);
  assert.throws(() => mapCallGridApiRecord(noTime), /occurrence timestamp/);
});

test('15. source authority, readiness and persistence semantics are untouched', () => {
  for (const symbol of [
    'IntegrationEvent',
    'MarketplaceCall',
    'declareAuthority',
    'assessReadiness',
    'receivedAt',
    'prisma',
    'ingestionSource',
  ]) {
    assert.ok(!IDENTITY_SOURCE.includes(symbol), `the identity rule must not reference ${symbol}`);
  }
});
