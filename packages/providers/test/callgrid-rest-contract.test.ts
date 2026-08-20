// CallGrid REST contract fidelity — the real record, mapped.
//
// WHAT THESE PIN, AND WHY IT IS NOT "ADD SOME ALIASES"
//
// The REST Call object is a MIX of camelCase ids and PascalCase `Call`-prefixed
// attributes. The mapper looked for the economics under unprefixed camelCase
// names — `revenue`, `payout`, `cost`, `billable`, `paid`, `completed`,
// `noRoute` — and a real production record carries none of those spellings. So
// every economic fact and every outcome flag came back `undefined`, and
// `qualified`, derived from billable/converted/paid, came back undefined with
// them.
//
// That is not a cosmetic gap. `marketplace-call-projection.ts` writes
// revenueCents, payoutCents, costCents, billable, paid, noRoute and monetized
// directly from those canonical keys, so a call ingested through REST had NO
// economics while a webhook call for the same conversation had all of them —
// and Stage 3's REVENUE, MONETIZED_RATE and NO_ROUTE_RATE measures read exactly
// those columns.
//
// The fixture below is the verified production shape. The assertions are about
// what survives the mapper, not about which aliases exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapCallGridApiRecord, toBool, toNumber } from '../src/adapters/callgrid-api';
import { CallGridProvider } from '../src/adapters/callgrid.provider';
import { resolveCallOccurrence } from '../src/adapters/callgrid-occurrence';
import type { ProviderContext } from '../src/types';

const CTX: ProviderContext = { organizationId: 'org_1' };
const provider = new CallGridProvider();

/**
 * A production REST record, in the VERIFIED list-endpoint shape.
 *
 * Every key here except `UTCUnixTimeMs` and the ids was observed in a 19-record
 * `get-calls` sample across 6 campaigns and 3 statuses (2026-08-20). Note what
 * that sample did NOT contain: no CallBillable, CallPaid, CallCompleted,
 * CallNoRoute, CallCost or InboundZipCode. Those aliases are defensive, and this
 * fixture deliberately does not pretend otherwise.
 *
 * `converted` is lowercase and an INTEGER — 0 in every sampled record.
 *
 * `UTCUnixTimeMs` stands in for the canonical occurrence field the REST object
 * carries (it is not `occurredAtUnix`, which is the webhook template's key).
 * Production reconciliation resolved 4,239 records through this mapper on
 * 2026-08-11, which it could not have done without one.
 */
function restRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cmsns65v8be2d07k368ox69s9',
    createdAt: '2026-08-10T21:58:57.245Z',
    UTCUnixTimeMs: 1786399137000,
    callStatus: 'COMPLETED',
    callDuration: 15,
    CallerId: '+15551234567',
    VendorName: '1039 - Ifficient',
    BuyerName: 'CEM',
    CampaignName: 'FE Inbounds RTB',
    campaignId: 'cmng68vp2001d06inikyf6zqh',
    buyerId: 'buy-1',
    sourceId: 'src-1',
    destinationId: 'dst-1',
    SourceName: 'Ifficient Direct',
    DestinationName: 'CEM Main',
    DestinationNumber: '+15559876543',
    Duplicate: false,
    CallRevenue: '0',
    CallPayout: '0',
    CallProfit: '0',
    converted: 0,
    outcome: null,
    ...over,
  };
}

const payloadOf = (r: Record<string, unknown>) =>
  mapCallGridApiRecord(r).payload as Record<string, unknown>;

// --- Identity: PR #178's resolver stays the only rule -------------------------------

test('the canonical CallGrid id survives unchanged', () => {
  assert.equal(mapCallGridApiRecord(restRecord()).externalId, 'cmsns65v8be2d07k368ox69s9');
});

test('a record with no usable identity is still refused through the shared resolver', () => {
  const r = restRecord();
  delete r.id;
  assert.throws(() => mapCallGridApiRecord(r), /no usable call id/);
});

// --- Money ---------------------------------------------------------------------------

test('the real money fields map, and zero stays NUMERIC ZERO rather than absent', () => {
  const p = payloadOf(restRecord());
  // The whole point: "0" is a measured zero. Absent is unknown. They must not
  // be the same value, and a JavaScript truthiness test would collapse them.
  assert.equal(p.revenue, 0);
  assert.equal(p.payout, 0);
  for (const key of ['revenue', 'payout']) {
    assert.equal(typeof p[key], 'number', `${key} must be a number, not a string`);
    assert.notEqual(p[key], undefined);
  }
});

test('non-zero money maps with its decimals intact, through formatting', () => {
  const p = payloadOf(restRecord({ CallRevenue: '$1,234.50', CallPayout: '24.00 USD' }));
  assert.equal(p.revenue, 1234.5);
  assert.equal(p.payout, 24);
  // CallCost is DEFENSIVE — not observed on the list endpoint. Pinned only as
  // "if it ever appears, it is read", never as a claim that it does.
  assert.equal(payloadOf(restRecord({ CallCost: '0.75' })).cost, 0.75);
});

test('an unmeasured money value stays UNKNOWN and is never coerced to a measured zero', () => {
  const p = payloadOf(restRecord({ CallRevenue: 'N/A', CallPayout: '' }));
  assert.equal(p.revenue, undefined, 'text is not a number');
  assert.equal(p.payout, undefined, 'empty is absent');
  assert.equal(p.cost, undefined, 'a field the record does not carry stays unknown');
});

test('CallProfit is preserved raw and deliberately NOT canonicalised', () => {
  // The payload spreads the whole record, so the provider fact survives. There
  // is no `profit` canonical key because nothing downstream reads one and
  // MarketplaceCall has no profit column — inventing one would be a contract
  // change this PR has no reason to make.
  const p = payloadOf(restRecord());
  assert.equal(p.CallProfit, '0', 'the raw provider fact is kept');
  assert.equal(p.profit, undefined, 'no canonical key is invented');
});

// --- Booleans -------------------------------------------------------------------------

test('boolean-like values normalise correctly, and "0" NEVER becomes true', () => {
  // Directly against the helper, over every representation CallGrid has been
  // seen to use. This is the assertion that would catch a truthiness regression.
  for (const falsy of ['0', 0, false, 'false', 'no', 'n', 'FALSE']) {
    assert.equal(toBool(String(falsy)), false, `${String(falsy)} must be false`);
  }
  for (const truthy of ['1', 1, true, 'true', 'yes', 'y', 'TRUE']) {
    assert.equal(toBool(String(truthy)), true, `${String(truthy)} must be true`);
  }
  // Unknown is unknown — never guessed in either direction.
  for (const unknown of ['', '   ', 'maybe', 'N/A']) {
    assert.equal(toBool(unknown), undefined, `${unknown} must stay unknown`);
  }
  assert.equal(toBool(undefined), undefined);
  // And the number 0 is a real zero to toNumber, not an absence.
  assert.equal(toNumber('0'), 0);
  assert.notEqual(toNumber('0'), undefined);
});

test('the DEFENSIVE outcome-flag aliases are read if they appear, in either form', () => {
  // These four spellings were NOT observed on the list endpoint. This pins that
  // they are read WHEN PRESENT — it is not a claim that CallGrid sends them.
  const asBooleans = payloadOf(
    restRecord({ CallBillable: false, CallPaid: false, CallCompleted: true, CallNoRoute: false }),
  );
  assert.equal(asBooleans.billable, false);
  assert.equal(asBooleans.paid, false);
  assert.equal(asBooleans.completed, true);
  assert.equal(asBooleans.noRoute, false);

  const asStrings = payloadOf(
    restRecord({ CallBillable: '1', CallPaid: '0', CallCompleted: 'true', CallNoRoute: '0' }),
  );
  assert.equal(asStrings.billable, true);
  assert.equal(asStrings.paid, false);
  assert.equal(asStrings.completed, true);
  assert.equal(asStrings.noRoute, false);

  // And on a record shaped like the verified sample they are simply unknown —
  // never guessed from callStatus, never defaulted.
  const verified = payloadOf(restRecord());
  assert.equal(verified.billable, undefined);
  assert.equal(verified.paid, undefined);
  assert.equal(verified.completed, undefined);
  assert.equal(verified.noRoute, undefined);
});

// --- Derived state --------------------------------------------------------------------

test('CONVERSION IS TRI-STATE: zero is UNKNOWN, never a negative', () => {
  // Conversion is postback-deferred — CallGrid's own campaign logs say revenue
  // and billable are set when the postback arrives — so 0 at list-read time is
  // the unset default, not a decision. Every sampled record was 0; no 1 was ever
  // observed; the webhook tag resolved to "".
  // null, explicitly — see the mapper: an omission would let the raw literal
  // stand in the canonical key's place, and `boolOrNull` reads a raw "false" as
  // a decided negative.
  assert.equal(payloadOf(restRecord()).converted, null, 'converted: 0 -> UNKNOWN');
  assert.equal(payloadOf(restRecord({ converted: '0' })).converted, null);
  assert.equal(payloadOf(restRecord({ converted: false })).converted, null);
  assert.equal(payloadOf(restRecord({ converted: 'false' })).converted, null, 'even a literal false');
  // And the provider's literal is preserved beside it, so no evidence is lost.
  assert.equal(payloadOf(restRecord()).providerConverted, '0');

  // A positive asserts a conversion. "1 -> true" is the SAFE DEFAULT, not an
  // observed fact — it errs toward silence rather than toward a claim.
  assert.equal(payloadOf(restRecord({ converted: 1 })).converted, true, 'converted: 1 -> true');
  assert.equal(payloadOf(restRecord({ converted: '1' })).converted, true);
  assert.equal(payloadOf(restRecord({ converted: true })).converted, true);
});

test('WHY: a stored false would enter the CONVERSION_RATE denominator, permanently', () => {
  // `convertedReported` counts rows where the column is NOT NULL, and the
  // measure is "calls flagged converted / calls that carried the flag at all".
  // A false is a counted negative; a null is excluded. A population of
  // not-yet-postbacked calls would therefore compute 0% at FULL coverage — the
  // exact shape the 2026-08-05 population had, where all 974 carried
  // converted=false. And IngestionService short-circuits a PROCESSED event, so
  // a later poll could never replace the false with a true.
  const population = Array.from({ length: 50 }, (_, i) =>
    payloadOf(restRecord({ id: `call-${i}`, converted: 0 })),
  );
  // `boolOrNull` in the projection decides a value only from a real boolean or
  // the strings "true"/"false". Nothing here may be one of those.
  assert.equal(
    population.filter((p) => typeof p.converted === 'boolean' || p.converted === 'false').length,
    0,
    'not one of them may be counted as a reported negative',
  );
});

test('there is no CallConverted, and none is looked for', () => {
  // The sample looked for CallConverted, conversion, CallConversion,
  // isConverted, IsConverted, convertedAt and conversionStatus, and found none.
  // A record carrying ONLY that invented spelling must resolve to unknown.
  const invented = restRecord();
  delete invented.converted;
  assert.equal(payloadOf({ ...invented, CallConverted: 1 }).converted, null, 'unknown, not true');
  assert.equal(payloadOf({ ...invented, CallConverted: 1 }).providerConverted, undefined);
});

test('`qualified` cannot be decided NO from a verified REST record, and that is correct', () => {
  // `qualified` decides NO only when billable, converted AND paid are all
  // explicitly false. Under the tri-state rule converted is never false on this
  // path, so a REST record can assert monetized YES or stay unknown — it can
  // never assert NO. That is the honest outcome while conversion is
  // postback-deferred, not a gap: monetized: null withholds, monetized: false
  // would be a claim.
  assert.equal(payloadOf(restRecord()).qualified, undefined, 'silence stays silence');
  assert.equal(payloadOf(restRecord({ converted: 1 })).qualified, true, 'a positive decides YES');
  assert.equal(
    payloadOf(restRecord({ CallBillable: false, CallPaid: false, converted: 0 })).qualified,
    undefined,
    'two falses and an unknown is not a NO',
  );
  // A billable positive still decides YES on its own.
  assert.equal(payloadOf(restRecord({ CallBillable: true })).qualified, true);
});

test('`outcome` is preserved raw and mapped to nothing', () => {
  // Verified present and null in every sampled record. Its populated
  // representation has never been observed, and the request accepting
  // converted/not-converted as an outcomes FILTER is not a response contract.
  const p = payloadOf(restRecord());
  assert.equal(p.outcome, null, 'the raw provider field survives');
  assert.equal(p.converted, null, 'conversion comes from `converted`, never from outcome');
  assert.equal(
    payloadOf(restRecord({ outcome: 'converted' })).converted,
    null,
    'a populated outcome never decides conversion — its contract is unobserved',
  );
});

// --- Attribution and geography ---------------------------------------------------------

test('attribution is verified; the inbound ZIP alias is defensive', () => {
  const p = payloadOf(restRecord());
  // The compact list endpoint carries no geography at all, so a verified record
  // has no ZIP and the canonical key is correctly absent.
  assert.equal(p.callerZip, undefined, 'absent stays absent');
  // Read if it ever appears — not a claim that it does.
  assert.equal(payloadOf(restRecord({ InboundZipCode: '10001' })).callerZip, '10001');
  // Ids stay ids and names stay display-only.
  assert.equal(p.campaignId, 'cmng68vp2001d06inikyf6zqh');
  assert.equal(p.campaign, 'FE Inbounds RTB');
  assert.equal(p.vendor, '1039 - Ifficient');
  assert.equal(p.buyer, 'CEM');
  assert.equal(p.source, 'Ifficient Direct');
  assert.equal(p.destination, 'CEM Main');
  assert.equal(p.apiSource, 'callgrid-api', 'REST provenance marker is untouched');
});

test('a realistic record loses NO verified provider economics', () => {
  // The regression in one assertion: every canonical key the projection reads
  // must survive for a record carrying the provider's own values. Any future
  // rename that breaks one spelling fails here.
  const p = payloadOf(restRecord());
  for (const key of ['revenue', 'payout', 'campaign', 'vendor', 'buyer', 'durationSeconds']) {
    assert.notEqual(p[key], undefined, `${key} must survive the mapper`);
  }
});

test('THE MINIMUM VERIFIED RECORD maps deterministically', () => {
  // id + createdAt + callStatus + CallRevenue + CallPayout + converted, plus the
  // canonical occurrence field. Nothing else. Twice, to pin determinism.
  const minimal = {
    id: 'cmsns65v8be2d07k368ox69s9',
    createdAt: '2026-08-10T21:58:57.245Z',
    UTCUnixTimeMs: 1786399137000,
    callStatus: 'COMPLETED',
    CallRevenue: '12.50',
    CallPayout: '4.00',
    converted: 0,
  };
  const first = mapCallGridApiRecord(minimal);
  const second = mapCallGridApiRecord(minimal);
  assert.equal(first.externalId, 'cmsns65v8be2d07k368ox69s9');
  assert.equal(first.occurredAt.toISOString(), '2026-08-10T21:58:57.000Z');
  const p = first.payload as Record<string, unknown>;
  assert.equal(p.revenue, 12.5);
  assert.equal(p.payout, 4);
  assert.equal(p.converted, null, 'postback-deferred: zero is unknown');
  assert.equal(p.apiSource, 'callgrid-api');
  assert.deepEqual(first.payload, second.payload, 'same record, same canonical payload');
  assert.equal(first.eventType, second.eventType);
});

// --- Occurrence -------------------------------------------------------------------------

test('the production webhook occurredAtUnix string-seconds resolves correctly', () => {
  // The provider forensic finding, verified rather than assumed: the webhook
  // template sends Unix SECONDS as a JSON STRING. `finite()` coerces a numeric
  // string, the magnitude test classifies it as seconds, and it resolves.
  const resolved = resolveCallOccurrence({ occurredAtUnix: '1786399137' });
  assert.ok(resolved.at instanceof Date);
  assert.equal(resolved.at?.toISOString(), '2026-08-10T21:58:57.000Z');
  assert.equal(resolved.field, 'occurredAtUnix');
  assert.equal(resolved.millisecondPrecision, false, 'seconds are seconds');
});

test('the REST record resolves occurrence from its OWN canonical field, never createdAt', () => {
  const p = mapCallGridApiRecord(restRecord());
  assert.equal(p.occurredAt.toISOString(), '2026-08-10T21:58:57.000Z');
  // createdAt is record-creation time and is banned as an occurrence source —
  // it ran ~16s after the event on a real record. Proven by moving it far away
  // and asserting the answer does not follow.
  const skewed = mapCallGridApiRecord(restRecord({ createdAt: '2020-01-01T00:00:00.000Z' }));
  assert.equal(skewed.occurredAt.toISOString(), '2026-08-10T21:58:57.000Z');
});

// --- REST / webhook canonical convergence -------------------------------------------------

test('REST and webhook converge on the facts both genuinely carry', async () => {
  // Same call, two ingress paths, different provider field names. The canonical
  // meaning must be identical — that is what makes "webhook first, poller later"
  // one call rather than two half-populated ones.
  const webhookPayload = {
    id: 'cmsns65v8be2d07k368ox69s9',
    occurredAtUnix: '1786399137',
    callStatus: 'COMPLETED',
    campaignId: 'cmng68vp2001d06inikyf6zqh',
    revenue: '0',
    CallConverted: '',
  };
  const webhook = (await provider.parseWebhook(CTX, webhookPayload))[0];
  const rest = mapCallGridApiRecord(restRecord());
  const wp = webhook?.payload as Record<string, unknown>;
  const rp = rest.payload as Record<string, unknown>;

  assert.equal(webhook?.externalId, rest.externalId, 'one canonical identity');
  assert.equal(
    webhook?.occurredAt.toISOString(),
    rest.occurredAt.toISOString(),
    'one occurrence, from two different provider fields',
  );
  // Only the facts BOTH fixtures genuinely carry. billable / paid / noRoute are
  // deliberately absent from this list: the webhook payload asserts them and the
  // verified REST list record does not, so asserting equality would be
  // manufacturing agreement rather than finding it.
  for (const key of ['revenue', 'campaignId']) {
    assert.deepEqual(rp[key], wp[key], `${key} must mean the same on both paths`);
  }
  // CONVERGENCE ON UNKNOWN, which is the point. The webhook template's
  // [[tag:CallConverted]] resolved to "" across the captured Aug 10-14 payloads,
  // and REST zero is the unset default. Both paths say "no conversion fact yet"
  // rather than one saying "no" and the other saying nothing.
  // Neither path yields a DECIDED value, which is the property that matters:
  // `boolOrNull` decides only from a real boolean or "true"/"false". The webhook
  // omits the key entirely, REST writes an explicit null; both project to a null
  // column and neither enters the CONVERSION_RATE denominator.
  assert.equal(wp.converted, undefined, 'webhook: a blank tag is unknown');
  assert.equal(rp.converted, null, 'REST: zero is unknown');
  for (const v of [wp.converted, rp.converted]) {
    assert.notEqual(typeof v, 'boolean', 'neither path may assert a conversion decision');
  }
});

test('convergence is NOT forced for a fact only one source supplies', () => {
  // The REST object carries no `apiSource` equivalent on the webhook side, and
  // the webhook carries geography the REST object may not. Asserting equality
  // for those would be manufacturing agreement rather than finding it.
  const rp = payloadOf(restRecord());
  assert.equal(rp.apiSource, 'callgrid-api');
  assert.equal(payloadOf(restRecord()).callerZip, undefined, 'absent stays absent, never defaulted');
  assert.equal(payloadOf(restRecord()).billable, undefined, 'and an unasserted flag is not inferred');
});
