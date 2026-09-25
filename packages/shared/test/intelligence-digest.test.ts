// The Loop Intelligence contracts (PR A, 2026-09-24): the coverage contract every piece of domain
// intelligence carries, and the shape, retention and freshness of a digest. Pure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DIGEST_CONTENT_KEYS,
  DIGEST_CONTENT_MAX_BYTES,
  PRIVATE_INTELLIGENCE_DOMAINS,
  DIGEST_FIELD_KNOWLEDGE,
  DIGEST_FORBIDDEN_KEYS,
  DIGEST_LIST_MAX_ITEMS,
  DIGEST_STRING_MAX_CHARS,
  INTELLIGENCE_BRIEFING_RETENTION_DAYS_DECIDED,
  INTELLIGENCE_COVERAGE,
  INTELLIGENCE_COVERAGE_LANGUAGE,
  INTELLIGENCE_DIGEST_DOMAIN_RETENTION_DAYS,
  INTELLIGENCE_DIGEST_SCOPES,
  INTELLIGENCE_DIGEST_STATUSES,
  INTELLIGENCE_DIGEST_SUBJECT_RETENTION_DAYS,
  INTELLIGENCE_DIGEST_WRITABLE_SCOPES,
  INTELLIGENCE_DOMAINS,
  INTELLIGENCE_SUBJECT_KINDS,
  PRODUCT_TONES,
  WORK_RETENTION_NOT_OVERRIDABLE,
  WORK_STATE_TABLES,
  digestContentRefusals,
  digestFreshness,
  intelligenceCoverageLabel,
  intelligenceDigestExpiresAt,
  isConnectedCoverage,
  isCoverageComplete,
  isIntelligenceCoverage,
  mayReadAbsenceAsNothingHappened,
  mayShowAsCurrent,
  productLabel,
  requiresCoverageDisclosure,
  workRetentionCategory,
  type IntelligenceCoverage,
} from '../src/index';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-09-24T12:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);

// --- The coverage contract ------------------------------------------------------------------

test('six coverage values, in this order', () => {
  assert.deepEqual([...INTELLIGENCE_COVERAGE], ['CONNECTED_SUFFICIENT', 'CONNECTED_INSUFFICIENT', 'CONNECTED_PARTIAL', 'DISCONNECTED', 'STALE', 'ERROR']);
  assert.equal(isIntelligenceCoverage('STALE'), true);
  assert.equal(isIntelligenceCoverage('UNKNOWN'), false);
});

test('only SUFFICIENT is complete; PARTIAL is not complete; nothing else is a picture', () => {
  const complete = INTELLIGENCE_COVERAGE.filter(isCoverageComplete);
  assert.deepEqual(complete, ['CONNECTED_SUFFICIENT']);
  assert.equal(isCoverageComplete('CONNECTED_PARTIAL'), false, 'PARTIAL is not complete');
});

test('INSUFFICIENT is not "nothing happened", DISCONNECTED is not zero, ERROR is not "there is nothing"', () => {
  // An absence may be read as "nothing happened" only under SUFFICIENT coverage.
  assert.deepEqual(INTELLIGENCE_COVERAGE.filter(mayReadAbsenceAsNothingHappened), ['CONNECTED_SUFFICIENT']);
  for (const c of ['CONNECTED_INSUFFICIENT', 'DISCONNECTED', 'ERROR', 'STALE', 'CONNECTED_PARTIAL'] as const) {
    assert.equal(mayReadAbsenceAsNothingHappened(c), false, c);
    assert.equal(requiresCoverageDisclosure(c), true, `${c} must show its words`);
  }
  assert.equal(requiresCoverageDisclosure('CONNECTED_SUFFICIENT'), false);
});

test('only SUFFICIENT and PARTIAL may be shown as the current state; STALE only as of when it was made', () => {
  assert.deepEqual(INTELLIGENCE_COVERAGE.filter(mayShowAsCurrent), ['CONNECTED_SUFFICIENT', 'CONNECTED_PARTIAL']);
  assert.deepEqual(INTELLIGENCE_COVERAGE.filter(isConnectedCoverage), ['CONNECTED_SUFFICIENT', 'CONNECTED_INSUFFICIENT', 'CONNECTED_PARTIAL']);
});

test('every coverage value has governed words that say what it does not mean, kept out of the flat lookup', () => {
  assert.deepEqual(Object.keys(INTELLIGENCE_COVERAGE_LANGUAGE).sort(), [...INTELLIGENCE_COVERAGE].sort());
  for (const c of INTELLIGENCE_COVERAGE) {
    const label = intelligenceCoverageLabel(c);
    assert.equal(label.from, c);
    assert.ok(PRODUCT_TONES.includes(label.tone));
    assert.ok(label.label.length > 0 && label.detail.length > 20, c);
  }
  assert.match(intelligenceCoverageLabel('CONNECTED_INSUFFICIENT').detail, /not the same as nothing happening/);
  assert.match(intelligenceCoverageLabel('DISCONNECTED').detail, /not a zero/);
  assert.match(intelligenceCoverageLabel('ERROR').detail, /does not mean there is nothing/);
  assert.match(intelligenceCoverageLabel('CONNECTED_PARTIAL').detail, /not of everything/);
  assert.match(intelligenceCoverageLabel('STALE').detail, /not now/);
  assert.notEqual(intelligenceCoverageLabel('ERROR').tone, 'VERIFIED');
  assert.equal(productLabel('STALE'), null, 'generic names never answer through the flat lookup');
  assert.equal(productLabel('CONNECTED_SUFFICIENT'), null);
  const words = Object.values(INTELLIGENCE_COVERAGE_LANGUAGE).flatMap((l) => [l.label, l.detail]).join(' ');
  assert.doesNotMatch(words, /anthropic|openai|claude|gpt|telegram|gmail|google|model\b|provider/i);
});

// --- Digest vocabulary ------------------------------------------------------------------------

test('scopes, domains, subject kinds and statuses are the approved ones; both scopes are writable since PR 2', () => {
  assert.deepEqual([...INTELLIGENCE_DIGEST_SCOPES], ['PRINCIPAL', 'ORGANIZATION']);
  assert.deepEqual([...INTELLIGENCE_DIGEST_WRITABLE_SCOPES], ['PRINCIPAL', 'ORGANIZATION']);
  assert.deepEqual([...INTELLIGENCE_DOMAINS], ['CHATS', 'MAIL', 'CALENDAR', 'CALLGRID', 'CREATORS', 'WORK', 'CRM', 'CAMPAIGNS', 'PIPELINE', 'WEBSITE']);
  assert.deepEqual([...INTELLIGENCE_SUBJECT_KINDS], ['CONVERSATION', 'THREAD', 'DOMAIN', 'ENTITY', 'EVENT']);
  assert.deepEqual([...INTELLIGENCE_DIGEST_STATUSES], ['CURRENT', 'STALE', 'WITHDRAWN']);
});

test('the PR A migration CHECKs named the vocabularies of their day (history, unchanged)', () => {
  const sql = readFileSync(join(__dirname, '..', '..', 'database', 'prisma', 'migrations', '20261003000000_intelligence_digests', 'migration.sql'), 'utf8');
  const list = (column: string) => {
    const m = new RegExp(`"${column}" IN \\(([^)]*)\\)`).exec(sql);
    assert.ok(m, column);
    return [...m![1]!.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
  };
  assert.deepEqual(list('scope'), [...INTELLIGENCE_DIGEST_SCOPES]);
  assert.deepEqual(list('domain'), ['CHATS', 'MAIL', 'CALENDAR', 'CALLGRID', 'CREATORS', 'WORK', 'CRM', 'CAMPAIGNS']);
  assert.deepEqual(list('subjectKind'), ['CONVERSATION', 'THREAD', 'DOMAIN']);
  assert.deepEqual(list('coverage'), [...INTELLIGENCE_COVERAGE]);
  assert.deepEqual(list('status'), [...INTELLIGENCE_DIGEST_STATUSES]);
});

test('the PR 2 migration: per-scope partial uniqueness, the scope CHECK both ways, and the private domains spelled out', () => {
  const sql = readFileSync(join(__dirname, '..', '..', 'database', 'prisma', 'migrations', '20261006000000_intelligence_org_digests', 'migration.sql'), 'utf8');
  const list = (column: string) => {
    const m = new RegExp(`"${column}" IN \\(([^)]*)\\)`).exec(sql);
    assert.ok(m, column);
    return [...m![1]!.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
  };
  assert.deepEqual(list('scope'), [...INTELLIGENCE_DIGEST_SCOPES]);
  assert.deepEqual(list('coverage'), [...INTELLIGENCE_COVERAGE]);
  assert.deepEqual(list('status'), [...INTELLIGENCE_DIGEST_STATUSES]);
  // The domain and subject vocabularies are the registry's; the database checks their pattern.
  for (const d of INTELLIGENCE_DOMAINS) assert.match(d, /^[A-Z][A-Z_]{1,31}$/);
  for (const k of INTELLIGENCE_SUBJECT_KINDS) assert.match(k, /^[A-Z][A-Z_]{1,31}$/);
  // The private domains are spelled out in the scope CHECK and match the shared constant.
  const privateDomains = /"domain" NOT IN \(([^)]*)\)/.exec(sql)?.[1] ?? '';
  assert.deepEqual([...privateDomains.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]), [...PRIVATE_INTELLIGENCE_DOMAINS]);
  assert.match(sql, /"scope" = 'PRINCIPAL' AND "userId" IS NOT NULL/);
  assert.match(sql, /"scope" = 'ORGANIZATION'\s+AND "userId" IS NULL\s+AND "provider" IS NULL\s+AND COALESCE\("provenance"->>'consentBasis', ''\) = 'LOOP_RECORDS'/);
  assert.match(sql, /DROP CONSTRAINT "intelligence_digests_organization_scope_reserved"/);
  // The new unique indexes are created BEFORE the old one is dropped.
  const principalAt = sql.indexOf('"intelligence_digests_principal_subject_key"');
  const organizationAt = sql.indexOf('"intelligence_digests_organization_subject_key"');
  const dropAt = sql.indexOf('DROP INDEX "intelligence_digests_organizationId_userId_domain_subjectKi_key"');
  assert.ok(principalAt > 0 && organizationAt > 0 && dropAt > principalAt && dropAt > organizationAt);
  assert.match(sql, /WHERE "scope" = 'PRINCIPAL';/);
  assert.match(sql, /WHERE "scope" = 'ORGANIZATION';/);
  assert.match(sql, /pg_column_size\("content"\) <= 32768/);
  assert.equal(DIGEST_CONTENT_MAX_BYTES, 32768);
  assert.match(sql, /cardinality\("entityRefs"\) <= 32/);
  assert.equal(/^[\x00-\x7F]*$/.test(sql), true, 'ASCII only');
});

// --- Content: minimized and bounded -----------------------------------------------------------

const GOOD = {
  relevance: 'BUSINESS',
  topics: ['Pricing for the Q4 renewal'],
  developments: ['They asked for a revised quote'],
  unresolved: ['Whether the discount applies to add-ons'],
  commitments: ['Send the revised quote by Friday'],
  opportunities: [],
  concerns: ['Budget approval is pending on their side'],
  stateChange: 'Moved from exploring to negotiating.',
  synthesis: 'An active renewal negotiation waiting on your quote.',
  confidence: 'MEDIUM',
  limitations: ['Only the last 30 days of the conversation were read.'],
};

test('a well-formed digest is accepted, and so is an empty one (a digest says only what the evidence supported)', () => {
  assert.deepEqual(digestContentRefusals(GOOD), []);
  assert.deepEqual(digestContentRefusals({}), []);
});

test('body, text, quote and message are refused by name, whatever their value', () => {
  for (const key of ['body', 'text', 'quote', 'message', 'Body', 'QUOTE']) {
    assert.deepEqual(digestContentRefusals({ ...GOOD, [key]: 'x' }), ['FORBIDDEN_KEY'], key);
  }
  for (const key of ['body', 'text', 'quote', 'message']) assert.ok(DIGEST_FORBIDDEN_KEYS.includes(key));
  assert.deepEqual(digestContentRefusals({ ...GOOD, sentiment: 'good' }), ['UNKNOWN_KEY'], 'an unknown field is refused, never ignored');
});

test('oversize is refused: a string over 280 characters, a list over 8 entries', () => {
  assert.equal(DIGEST_STRING_MAX_CHARS, 280);
  assert.equal(DIGEST_LIST_MAX_ITEMS, 8);
  assert.deepEqual(digestContentRefusals({ synthesis: 'x'.repeat(280) }), []);
  assert.deepEqual(digestContentRefusals({ synthesis: 'x'.repeat(281) }), ['STRING_TOO_LONG']);
  assert.deepEqual(digestContentRefusals({ topics: ['y'.repeat(281)] }), ['STRING_TOO_LONG']);
  assert.deepEqual(digestContentRefusals({ topics: Array.from({ length: 8 }, (_, i) => `t${i}`) }), []);
  assert.deepEqual(digestContentRefusals({ topics: Array.from({ length: 9 }, (_, i) => `t${i}`) }), ['LIST_TOO_LONG']);
  // Characters, not UTF-16 units.
  assert.deepEqual(digestContentRefusals({ synthesis: '\u{1F600}'.repeat(280) }), []);
});

test('wrong types and unknown words are refused', () => {
  assert.deepEqual(digestContentRefusals(null), ['NOT_AN_OBJECT']);
  assert.deepEqual(digestContentRefusals([GOOD]), ['NOT_AN_OBJECT']);
  assert.deepEqual(digestContentRefusals({ topics: 'one' }), ['WRONG_TYPE']);
  assert.deepEqual(digestContentRefusals({ topics: [1] }), ['WRONG_TYPE']);
  assert.deepEqual(digestContentRefusals({ synthesis: '   ' }), ['EMPTY_STRING']);
  assert.deepEqual(digestContentRefusals({ relevance: 'MAYBE' }), ['UNKNOWN_RELEVANCE']);
  assert.deepEqual(digestContentRefusals({ confidence: 0.93 }), ['UNKNOWN_CONFIDENCE'], 'never a self-scored number');
});

// --- Retention -------------------------------------------------------------------------------

test('retention: a subject digest lives 30 days past its newest evidence; a domain rollup 30 days past generation; briefing 90 is decided, not built', () => {
  assert.equal(INTELLIGENCE_DIGEST_SUBJECT_RETENTION_DAYS, 30);
  assert.equal(INTELLIGENCE_DIGEST_DOMAIN_RETENTION_DAYS, 30);
  assert.equal(INTELLIGENCE_BRIEFING_RETENTION_DAYS_DECIDED, 90);
  assert.deepEqual(intelligenceDigestExpiresAt({ subjectKind: 'CONVERSATION', lastEvidenceAt: at(-5), windowEnd: at(-1), generatedAt: T0 }), at(25));
  assert.deepEqual(intelligenceDigestExpiresAt({ subjectKind: 'THREAD', lastEvidenceAt: null, windowEnd: at(-1), generatedAt: T0 }), at(29), 'no evidence: the window end anchors it');
  assert.deepEqual(intelligenceDigestExpiresAt({ subjectKind: 'DOMAIN', lastEvidenceAt: at(-20), windowEnd: at(0), generatedAt: T0 }), at(30));
});

test('the retention policy has an INTELLIGENCE_DIGESTS category governing intelligence_digests, which no override can move', () => {
  const category = workRetentionCategory('INTELLIGENCE_DIGESTS');
  assert.ok(category);
  assert.equal(category!.rule, 'DAYS');
  assert.equal(category!.days, 30);
  assert.deepEqual(category!.tables, ['intelligence_digests']);
  assert.ok(WORK_STATE_TABLES.includes('intelligence_digests'), 'covered by the every-table-in-one-category test');
  assert.deepEqual([...WORK_RETENTION_NOT_OVERRIDABLE], ['INTELLIGENCE_DIGESTS', 'INTELLIGENCE_REFRESH_REQUESTS']);
});

// --- Freshness -------------------------------------------------------------------------------

const digest = { coverage: 'CONNECTED_SUFFICIENT' as IntelligenceCoverage, status: 'CURRENT' as const, windowEnd: at(-1), expiresAt: at(20) };
const live = { sourceLastEvidenceAt: at(-2), connectionLive: true, now: T0 };

test('freshness: a current digest keeps the coverage it was generated with', () => {
  assert.equal(digestFreshness(digest, live), 'CONNECTED_SUFFICIENT');
  assert.equal(digestFreshness({ ...digest, coverage: 'CONNECTED_PARTIAL' }, live), 'CONNECTED_PARTIAL');
  assert.equal(digestFreshness(digest, { ...live, sourceLastEvidenceAt: null }), 'CONNECTED_SUFFICIENT', 'unknown newer evidence is not newer evidence');
});

test('freshness: newer evidence at the source, a STALE mark, or nearing expiry -> STALE', () => {
  assert.equal(digestFreshness(digest, { ...live, sourceLastEvidenceAt: at(0) }), 'STALE', 'the source moved past the window');
  assert.equal(digestFreshness({ ...digest, status: 'STALE' }, live), 'STALE');
  assert.equal(digestFreshness({ ...digest, expiresAt: at(0.5) }, live), 'STALE', 'within a day of expiry');
  assert.equal(digestFreshness({ ...digest, expiresAt: at(-1) }, live), 'STALE', 'past expiry, before the sweep');
});

test('freshness: a connection that is not live, or a withdrawn digest -> DISCONNECTED; an unknown stored value -> ERROR', () => {
  assert.equal(digestFreshness(digest, { ...live, connectionLive: false }), 'DISCONNECTED');
  assert.equal(digestFreshness({ ...digest, status: 'WITHDRAWN' }, live), 'DISCONNECTED');
  assert.equal(digestFreshness({ ...digest, coverage: 'GREAT' }, live), 'ERROR');
});

// --- Chats Intelligence (2026-09-25): two additive content fields and the per-field knowledge basis ---

test('additive fields: `operational` is a bounded list and `attention` a bounded sentence, refused like the rest', () => {
  assert.deepEqual(digestContentRefusals({ operational: ['The install moved to next week'], attention: 'Dana set a deadline for the contract' }), []);
  assert.ok(digestContentRefusals({ operational: Array.from({ length: DIGEST_LIST_MAX_ITEMS + 1 }, (_, i) => `op ${i}`) }).includes('LIST_TOO_LONG'));
  assert.ok(digestContentRefusals({ operational: ['x'.repeat(DIGEST_STRING_MAX_CHARS + 1)] }).includes('STRING_TOO_LONG'));
  assert.ok(digestContentRefusals({ operational: 'not a list' }).includes('WRONG_TYPE'));
  assert.ok(digestContentRefusals({ attention: '' }).includes('EMPTY_STRING'));
  assert.ok(digestContentRefusals({ attention: 'x'.repeat(DIGEST_STRING_MAX_CHARS + 1) }).includes('STRING_TOO_LONG'));
  assert.ok(digestContentRefusals({ attention: ['a list'] }).includes('WRONG_TYPE'));
  // Still total: a key the contract does not name is refused, and the evidence keys are refused by name.
  assert.ok(digestContentRefusals({ decisions: ['x'] }).includes('UNKNOWN_KEY'));
  assert.ok(digestContentRefusals({ quote: 'x' }).includes('FORBIDDEN_KEY'));
});

test('every content field but `limitations` states what it KNOWS: only developments and commitments are OBSERVED', () => {
  // `reading` and `signals` (PR 2) carry their knowledge per signal, in the participation contract.
  const fields = DIGEST_CONTENT_KEYS.filter((k) => k !== 'limitations' && k !== 'reading' && k !== 'signals').sort();
  assert.deepEqual(Object.keys(DIGEST_FIELD_KNOWLEDGE).sort(), fields, 'one basis per field, no more, no fewer');
  const observed = Object.entries(DIGEST_FIELD_KNOWLEDGE).filter(([, k]) => k === 'OBSERVED').map(([f]) => f).sort();
  assert.deepEqual(observed, ['commitments', 'developments']);
  assert.ok(Object.isFrozen(DIGEST_FIELD_KNOWLEDGE));
});
