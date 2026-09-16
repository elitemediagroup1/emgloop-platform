// Universal Activity contract, pure. Slice A1.
//
// Every rule `validateActivityItem` enforces is proven against an otherwise valid
// item, so no test passes for the wrong reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_CONTRACT_VERSION,
  ACTIVITY_FILTER_CATEGORIES,
  ACTIVITY_FILTERS,
  ACTIVITY_VIOLATIONS,
  IDENTITY_SUBJECT_STATES,
  IDENTITY_SUBJECT_STATE_BASES,
  activityFilterIncludes,
  compareActivityItems,
  deriveIdentitySubject,
  validateActivityItem,
  type ActivityItemV1,
  type ActivitySubjectRef,
} from '../src/activity';

function item(patch: Partial<ActivityItemV1> = {}): ActivityItemV1 {
  return {
    contractVersion: ACTIVITY_CONTRACT_VERSION,
    key: 'interaction:i1',
    organizationId: 'org',
    category: 'COMMUNICATION',
    type: 'CALL',
    authority: { domain: 'callgrid', recordType: 'interaction', recordId: 'i1', sequence: null, href: null },
    time: { occurredAt: '2026-09-15T12:00:00.000Z', occurredAtBasis: 'PROVIDER_REPORTED', recordedAt: '2026-09-15T12:00:05.000Z', window: null },
    actor: { kind: 'PROVIDER', userId: null, producer: null, producerVersion: null },
    subjects: [{ kind: 'UNRESOLVED_IDENTIFIER', identifierKind: 'PHONE', assertionMode: 'NETWORK_ASSERTED', evidenceRef: null }],
    participants: [],
    identity: { state: 'UNRESOLVED', basis: 'FACT_IDENTIFIER_PRESENT' },
    provenance: { source: 'callgrid', transport: 'WEBHOOK', epistemic: 'RECORDED', ruleId: null, ruleVersion: null, evidenceCount: null, limitations: ['caller ID is network-asserted and spoofable'] },
    display: { title: 'Inbound call from an unidentified caller', channel: 'phone', direction: 'INBOUND', stateChange: null, semanticStatus: null },
    access: { requires: [{ resource: 'intelligence', action: 'view' }], workspace: null },
    sensitivity: { class: 'OPERATIONAL', rawValuesInSource: true, contentInline: false },
    ...patch,
  };
}

test('a well-formed unresolved call is valid', () => {
  assert.deepEqual(validateActivityItem(item()), []);
});

test('each rule is enforced against an otherwise valid item', () => {
  const cases: [Partial<ActivityItemV1> | ((i: ActivityItemV1) => ActivityItemV1), string][] = [
    [{ contractVersion: 'activity.v0' as never }, 'WRONG_CONTRACT_VERSION'],
    [{ organizationId: ' ' }, 'MISSING_ORGANIZATION'],
    [{ key: 'something-else' }, 'KEY_NOT_DERIVED_FROM_AUTHORITY'],
    [(i) => ({ ...i, authority: { ...i.authority, sequence: 3 } }), 'KEY_NOT_DERIVED_FROM_AUTHORITY'],
    [{ category: 'GOSSIP' as never }, 'UNKNOWN_CATEGORY'],
    [(i) => ({ ...i, time: { ...i.time, recordedAt: 'yesterday' } }), 'INVALID_TIME'],
    [(i) => ({ ...i, time: { ...i.time, window: { start: 'x', end: '2026-09-15T00:00:00Z' } } }), 'INVALID_TIME'],
    [(i) => ({ ...i, time: { ...i.time, occurredAt: null } }), 'UNKNOWN_TIME_WITHOUT_UNKNOWN_BASIS'],
    [(i) => ({ ...i, time: { ...i.time, occurredAtBasis: 'UNKNOWN' } }), 'KNOWN_TIME_WITH_UNKNOWN_BASIS'],
    [{ identity: { state: 'UNRESOLVED', basis: 'GOVERNED_ATTRIBUTION' } }, 'IDENTITY_BASIS_NOT_ALLOWED_FOR_STATE'],
    [{ identity: { state: 'KNOWN_PARTY', basis: 'GOVERNED_ATTRIBUTION' } }, 'IDENTITY_STATE_NOT_SUPPORTED_BY_SUBJECTS'],
    [{ subjects: [{ kind: 'OPPORTUNITY', id: 'o1' }], identity: { state: 'NOT_APPLICABLE', basis: 'NONE' } }, 'RESERVED_SUBJECT_KIND'],
    [{ participants: [{ kind: 'RELATIONSHIP', id: 'r1' }] }, 'RESERVED_SUBJECT_KIND'],
    [(i) => ({ ...i, category: 'FACT', provenance: { ...i.provenance, epistemic: 'INTERPRETED' } }), 'INTERPRETATION_PRESENTED_AS_FACT'],
    [(i) => ({ ...i, category: 'FINDING', provenance: { ...i.provenance, epistemic: 'RECORDED' } }), 'INTERPRETATION_PRESENTED_AS_FACT'],
    [(i) => ({ ...i, display: { ...i.display, title: 'Call from (312) 555-0142' } }), 'RAW_CONTACT_VALUE_IN_TITLE'],
    [(i) => ({ ...i, display: { ...i.display, title: 'Form from pat@example.com' } }), 'RAW_CONTACT_VALUE_IN_TITLE'],
    [{ access: { requires: [], workspace: null } }, 'NO_ACCESS_REQUIREMENT'],
    [(i) => ({ ...i, sensitivity: { ...i.sensitivity, contentInline: true as never } }), 'CONTENT_INLINE'],
  ];
  const seen = new Set<string>();
  for (const [mutation, violation] of cases) {
    const bad = typeof mutation === 'function' ? mutation(item()) : item(mutation);
    const found = validateActivityItem(bad);
    assert.ok(found.includes(violation as never), `${violation}: got ${JSON.stringify(found)}`);
    seen.add(violation);
  }
  assert.deepEqual([...seen].sort(), [...ACTIVITY_VIOLATIONS].sort(), 'every violation has a proving case');
});

test('identity is derived from subjects, most specific first, and an Intake link is never Known', () => {
  const phone: ActivitySubjectRef = { kind: 'UNRESOLVED_IDENTIFIER', identifierKind: 'PHONE', assertionMode: null, evidenceRef: null };
  const intake: ActivitySubjectRef = { kind: 'INTAKE_RECORD', customerId: 'c1' };
  const visitor: ActivitySubjectRef = { kind: 'ANONYMOUS_CONTINUITY', continuity: 'VISITOR', property: 'p', evidenceRef: null };
  const person: ActivitySubjectRef = { kind: 'PARTY', partyId: 'p1', partyType: 'PERSON', reference: 'ESTABLISHED', canonicalPartyId: 'p1' };
  const company: ActivitySubjectRef = { kind: 'PARTY', partyId: 'c9', partyType: 'COMPANY', reference: 'SUPERSEDED', canonicalPartyId: 'c10' };
  const buyer: ActivitySubjectRef = { kind: 'PROVIDER_COUNTERPARTY', role: 'BUYER', provider: 'callgrid', externalId: 'b1' };
  assert.deepEqual(deriveIdentitySubject([visitor, phone, person]), { state: 'KNOWN_PARTY', basis: 'GOVERNED_ATTRIBUTION' });
  assert.deepEqual(deriveIdentitySubject([company]), { state: 'KNOWN_COMPANY', basis: 'GOVERNED_ATTRIBUTION' });
  assert.deepEqual(deriveIdentitySubject([intake, phone]), { state: 'UNRESOLVED', basis: 'FACT_IDENTIFIER_PRESENT' });
  assert.deepEqual(deriveIdentitySubject([intake]), { state: 'UNRESOLVED', basis: 'INTAKE_LINK_CONTEXT' });
  assert.deepEqual(deriveIdentitySubject([visitor]), { state: 'ANONYMOUS', basis: 'CONTINUITY_KEY_PRESENT' });
  assert.deepEqual(deriveIdentitySubject([buyer, { kind: 'CASE', id: 'k' }]), { state: 'NOT_APPLICABLE', basis: 'NONE' }, 'a provider buyer is not a Party');
  for (const state of IDENTITY_SUBJECT_STATES) assert.ok(IDENTITY_SUBJECT_STATE_BASES[state].length > 0, state);
});

test('filters cover every category; facts appear only under All', () => {
  assert.deepEqual([...ACTIVITY_FILTERS], ['ALL', 'COMMUNICATIONS', 'WORK', 'INTELLIGENCE', 'CHANGES']);
  for (const c of ACTIVITY_CATEGORIES) assert.ok(activityFilterIncludes('ALL', c), c);
  const narrowed = new Set(ACTIVITY_FILTERS.filter((f) => f !== 'ALL').flatMap((f) => [...ACTIVITY_FILTER_CATEGORIES[f]]));
  assert.deepEqual([...ACTIVITY_CATEGORIES].filter((c) => !narrowed.has(c)), ['FACT']);
  assert.equal(activityFilterIncludes('INTELLIGENCE', 'FACT'), false);
});

test('ordering is newest first by occurrence (else recording), then by key, and stable', () => {
  const a = item({ key: 'interaction:a', authority: { domain: 'x', recordType: 'interaction', recordId: 'a', sequence: null, href: null } });
  const b = item({ key: 'interaction:b', authority: { domain: 'x', recordType: 'interaction', recordId: 'b', sequence: null, href: null } });
  const older = item({ time: { occurredAt: '2026-09-14T00:00:00.000Z', occurredAtBasis: 'LOOP_CLOCK', recordedAt: '2026-09-14T00:00:00.000Z', window: null } });
  const unknownButRecent = item({ key: 'audit:z', time: { occurredAt: null, occurredAtBasis: 'UNKNOWN', recordedAt: '2026-09-16T00:00:00.000Z', window: null } });
  const sorted = [older, a, unknownButRecent, b].sort(compareActivityItems).map((i) => i.key);
  assert.deepEqual(sorted, ['audit:z', 'interaction:b', 'interaction:a', 'interaction:i1']);
});

test('fence: pure, no confidence, no raw content fields', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'activity.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /confidence|score|probabilit/i);
  assert.doesNotMatch(src, /\b(body|messageBody|phoneNumber|emailAddress|callerNumber)\s*[:?]/);
  assert.doesNotMatch(src, /Date\.now|new Date\(|Math\.random|process\.env|fetch\(|prisma/i);
});
