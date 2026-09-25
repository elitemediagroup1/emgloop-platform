// The Daily Loop work-state contract: closed vocabularies, retention coverage, sensitivity.
//
// These are the words the database also enforces (the DL-1 migration repeats every list as a
// CHECK). A test here that drifts from that migration is the drift itself, so the migration
// is read and compared.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  WORK_ACTOR_TYPES,
  WORK_CLASSES,
  WORK_CURSOR_KINDS,
  WORK_DIRECTIONS,
  WORK_DISCONNECT_GRACE_DAYS,
  WORK_EVIDENCE_QUOTE_MAX_CHARS,
  WORK_FEEDBACK_KINDS,
  WORK_ITEM_CLOSED_STATES,
  WORK_ITEM_OUTCOMES,
  WORK_ITEM_STATES,
  WORK_OBSERVATION_TYPES,
  WORK_PRODUCER_KINDS,
  WORK_PROVENANCE_KINDS,
  WORK_PROVIDERS,
  WORK_RETENTION_CATEGORIES,
  WORK_RETENTION_POLICY_VERSION,
  WORK_SOURCES,
  WORK_STATE_SENSITIVITY,
  WORK_STATE_TABLES,
  WORK_SUBJECT_KINDS,
  WORK_SYNC_FAILURE_CLASSES,
  WORK_SYNC_OUTCOMES,
  WORK_SYSTEM_ONLY_OUTCOMES,
  WORK_TERMINATION_GRACE_DAYS,
  WORK_WITHDRAWAL_REASON_PREFIX,
  DERIVED_EVIDENCE_PROVENANCE_KEYS,
  DERIVED_WORK_SUBJECT_PREFIXES,
  derivedWorkProviderOf,
  derivedWorkSubjectPrefix,
  isWorkSource,
  isWorkWithdrawalReason,
  minimizeDerivedEvidence,
  telegramConversationSubjectRef,
  workRetentionCategory,
  workWithdrawalReason,
} from '../src/work-state';

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'database', 'prisma', 'migrations', '20260920000000_daily_loop_work_state', 'migration.sql'),
  'utf8',
);
// The item-outcome CHECK was restated in full by the migration that added REVOKED (2026-09-24);
// that file is the constraint now in force for outcomes, so the outcome list is pinned against it.
// Loop Intelligence Phase C restated the observation CHECK with WORK_LINKED added (nothing removed).
const OBSERVATION_MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'database', 'prisma', 'migrations', '20261007000000_promote_to_work', 'migration.sql'),
  'utf8',
);

const OUTCOME_MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'database', 'prisma', 'migrations', '20261001000000_work_item_outcome_revoked', 'migration.sql'),
  'utf8',
);

test('the REVOKED migration is ASCII-only, like every migration this suite pins', () => {
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(OUTCOME_MIGRATION, /[^\x00-\x7f]/, 'a migration file carries no non-ASCII byte');
});

test('the vocabularies are closed, and say only what metadata can establish', () => {
  assert.deepEqual([...WORK_SOURCES], ['GMAIL', 'CALENDAR', 'DRIVE']);
  assert.deepEqual([...WORK_PROVIDERS], ['GOOGLE']);
  assert.deepEqual([...WORK_DIRECTIONS], ['INBOUND', 'OUTBOUND']);
  assert.deepEqual([...WORK_SUBJECT_KINDS], ['THREAD', 'EVENT', 'DOCUMENT', 'CORRESPONDENT']);
  assert.deepEqual([...WORK_ACTOR_TYPES], ['HUMAN', 'SYSTEM'], 'there is no AI actor: no model writes work state');

  // The four classes a header can establish. "Opportunity" and "why it matters" need message
  // content (architecture Stage 2) and are deliberately absent: a word here would invite a guess.
  assert.deepEqual([...WORK_CLASSES], ['NEEDS_YOU', 'WAITING_ON_THEM', 'GONE_QUIET', 'FYI']);
  for (const absent of ['OPPORTUNITY', 'IMPORTANT', 'URGENT', 'LOW_PRIORITY']) {
    assert.equal((WORK_CLASSES as readonly string[]).includes(absent), false, absent);
  }

  assert.equal(isWorkSource('GMAIL'), true);
  assert.equal(isWorkSource('SLACK'), false);
});

test('the item lifecycle keeps "Loop was wrong" apart from "real, and handled"', () => {
  assert.deepEqual([...WORK_ITEM_STATES], ['OPEN', 'SNOOZED', 'RESOLVED', 'DISMISSED']);
  assert.deepEqual([...WORK_ITEM_CLOSED_STATES], ['RESOLVED', 'DISMISSED']);
  assert.equal(WORK_ITEM_OUTCOMES.includes('FALSE_POSITIVE'), true, 'the accuracy signal needs its own outcome');
  assert.equal(WORK_ITEM_OUTCOMES.includes('HANDLED'), true);
  assert.equal(WORK_ITEM_OUTCOMES.includes('NOT_MINE'), true);
  // A withdrawn authorization is its own fact: never "handled", never "Loop was wrong" (§21.2).
  assert.equal(WORK_ITEM_OUTCOMES.includes('REVOKED'), true, 'a withdrawn authorization needs an outcome that is neither');
  assert.deepEqual([...WORK_SYSTEM_ONLY_OUTCOMES], ['REVOKED'], 'only the system may write it');
  assert.equal(WORK_SYSTEM_ONLY_OUTCOMES.every((o) => (WORK_ITEM_OUTCOMES as readonly string[]).includes(o)), true);
  assert.deepEqual([...WORK_OBSERVATION_TYPES].slice(0, 2), ['DETECTED', 'REDETECTED']);
  assert.deepEqual([...WORK_PRODUCER_KINDS], ['RULE', 'MODEL'], 'a Stage 3 task writes the same row, not a second queue');
  assert.deepEqual([...WORK_PROVENANCE_KINDS], ['SOURCE_FACT', 'DERIVED', 'INFERRED', 'CONFIRMED']);
  assert.deepEqual([...WORK_FEEDBACK_KINDS], ['NOT_IMPORTANT', 'ALREADY_HANDLED', 'NOT_WAITING', 'SUPPRESS_CORRESPONDENT', 'SUPPRESS_DOMAIN']);
  assert.deepEqual([...WORK_SYNC_OUTCOMES], ['SUCCEEDED', 'TRUNCATED', 'FAILED']);
  assert.equal(WORK_SYNC_FAILURE_CLASSES.includes('CURSOR_EXPIRED'), true);
  assert.equal(WORK_CURSOR_KINDS.length, 3);
});

test('every vocabulary the database also enforces appears in the DL-1 migration', () => {
  const lists: Record<string, readonly string[]> = {
    sources: WORK_SOURCES,
    classes: WORK_CLASSES,
    states: WORK_ITEM_STATES,
    outcomes: WORK_ITEM_OUTCOMES,
    observations: WORK_OBSERVATION_TYPES,
    producers: WORK_PRODUCER_KINDS,
    feedback: WORK_FEEDBACK_KINDS,
    subjects: WORK_SUBJECT_KINDS,
    syncOutcomes: WORK_SYNC_OUTCOMES,
    failures: WORK_SYNC_FAILURE_CLASSES,
    cursorKinds: WORK_CURSOR_KINDS,
    actors: WORK_ACTOR_TYPES,
  };
  for (const [name, list] of Object.entries(lists)) {
    const pinnedIn = name === 'outcomes' ? OUTCOME_MIGRATION : name === 'observations' ? OBSERVATION_MIGRATION : MIGRATION;
    for (const word of list) {
      assert.match(pinnedIn, new RegExp(`'${word}'`), `${name}: ${word} is not pinned in the migration`);
    }
  }
  // The observation CHECK is restated, not narrowed: every word DL-1 accepted, Phase C accepts.
  const dl1Observations = /"observationType" IN \(([^)]*)\)/.exec(MIGRATION)?.[1] ?? '';
  for (const quoted of dl1Observations.match(/'[A-Z_]+'/g) ?? []) assert.ok(OBSERVATION_MIGRATION.includes(quoted), `${quoted} still accepted`);
  // The outcome CHECK is restated, not narrowed: every word DL-1 accepted, the restatement accepts.
  // Inside the work_items CHECK block only: work_sync_runs has an outcome column of its own.
  const dl1ItemsCheck = /"work_items_shape_check" CHECK \(([\s\S]*?)\n\);/.exec(MIGRATION)?.[1] ?? '';
  const dl1Outcomes = /"outcome" IS NULL OR "outcome" IN \(([^)]*)\)/.exec(dl1ItemsCheck)?.[1] ?? '';
  assert.ok(dl1Outcomes.includes("'HANDLED'"), 'the DL-1 work_items outcome CHECK was found');
  for (const quoted of dl1Outcomes.match(/'[A-Z_]+'/g) ?? []) {
    assert.ok(OUTCOME_MIGRATION.includes(quoted), `${quoted} was accepted by DL-1 and must still be`);
  }
  // And the quote cap is the same number in both places.
  assert.equal(WORK_EVIDENCE_QUOTE_MAX_CHARS, 240);
  assert.match(MIGRATION, /length\("evidenceQuote"\) <= 240/);
});

test('retention is a window per category, and every work table is covered exactly once', () => {
  assert.equal(WORK_RETENTION_POLICY_VERSION, 'work-retention.2026-09-26.1');

  const covered = WORK_RETENTION_CATEGORIES.flatMap((c) => [...c.tables]);
  assert.deepEqual([...covered].sort(), [...WORK_STATE_TABLES].sort(), 'every table appears in exactly one category');
  assert.equal(new Set(covered).size, covered.length, 'no table is claimed by two categories');

  const byName = (name: string) => {
    const found = workRetentionCategory(name);
    assert.ok(found, `${name} is missing`);
    return found!;
  };
  // The approved initial product policy (architecture §21.3, D13).
  assert.equal(byName('GOOGLE_RAW_RESPONSES').rule, 'NEVER_STORED');
  assert.deepEqual(byName('GOOGLE_RAW_RESPONSES').tables, [], 'nothing stores a raw provider response');
  assert.equal(byName('GMAIL_METADATA').days, 30);
  assert.equal(byName('THREAD_CONTEXT').days, 90);
  assert.equal(byName('CALENDAR_STATE').days, 90);
  assert.equal(byName('DERIVED_WORK_FACTS').days, 365);
  assert.equal(byName('BRIEFS').days, 365);
  assert.equal(byName('PROCESSING_CACHE').days, 1, 'Stage 2 cache: a 24-hour ceiling, not a lifetime');
  assert.equal(byName('EVIDENCE_QUOTES').rule, 'TIED_TO_PARENT');
  assert.equal(byName('PROVENANCE_REFERENCES').rule, 'TIED_TO_PARENT');
  assert.equal(byName('SECURITY_AUDIT').rule, 'GOVERNED_ELSEWHERE');
  assert.equal(WORK_DISCONNECT_GRACE_DAYS, 30);
  assert.equal(WORK_TERMINATION_GRACE_DAYS, 0, 'membership termination deletes immediately');

  // No category is a number without a reason, and none is a universal duration.
  for (const category of WORK_RETENTION_CATEGORIES) {
    assert.ok(category.why.length > 20, `${category.category} states why`);
    assert.equal(category.rule === 'DAYS', category.days !== null, `${category.category}: days iff DAYS`);
  }
  assert.equal(workRetentionCategory('NOT_A_CATEGORY'), null);
});

test('a subject line is treated as content, whatever Google’s scope taxonomy calls it', () => {
  assert.equal(WORK_STATE_SENSITIVITY.work_threads?.subject, 'COMMUNICATION_CONTENT');
  assert.equal(WORK_STATE_SENSITIVITY.work_messages?.subject, 'COMMUNICATION_CONTENT');
  assert.equal(WORK_STATE_SENSITIVITY.work_items?.evidenceQuote, 'COMMUNICATION_CONTENT');
  assert.equal(WORK_STATE_SENSITIVITY.work_correspondents?.addressHash, 'OPERATIONAL', 'a hash identifies nobody');
  assert.equal(WORK_STATE_SENSITIVITY.work_correspondents?.displayAddress, 'CONTACT_IDENTIFIER');
  // Every class named is one the AI runtime already knows, so a ceiling can be enforced later.
  const known = new Set(['OPERATIONAL', 'CONTACT_IDENTIFIER', 'COMMUNICATION_CONTENT', 'WORKFORCE_PII']);
  for (const [table, columns] of Object.entries(WORK_STATE_SENSITIVITY)) {
    for (const [column, klass] of Object.entries(columns)) {
      assert.equal(known.has(klass), true, `${table}.${column} -> ${klass}`);
    }
  }
});

test('the contract carries no numeric confidence and no body field', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'work-state.ts'), 'utf8');
  for (const forbidden of ['confidenceScore', 'bodyText', 'messageBody', 'snippet', 'attachmentContent']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

// --- Derived items: withdrawal (§21.2, 2026-09-24) ------------------------------------------------

test('minimizeDerivedEvidence keeps ONLY the provenance allowlist, by name, and drops every paraphrase and every unknown key', () => {
  assert.deepEqual(
    [...DERIVED_EVIDENCE_PROVENANCE_KEYS],
    ['provider', 'providerEventId', 'conversationKey', 'aiInvocationId', 'aiTaskVersion', 'conversationKind', 'contextTruncated'],
    'the allowlist is these seven keys and nothing else',
  );
  const evidence = {
    // provenance
    provider: 'TELEGRAM',
    providerEventId: 'ck:42',
    conversationKey: 'ck',
    aiInvocationId: 'inv-777',
    aiTaskVersion: '2.1.0',
    conversationKind: 'GROUP',
    contextTruncated: true,
    // the model's paraphrases and the source's name -- content-derived
    category: 'REQUEST',
    topic: 'Kickoff call',
    nextStep: 'Propose a new time',
    deadline: 'this week',
    counterpartyLabel: 'Alice Displayname',
    // something a future producer might add
    unknownFutureField: 'must not survive',
    body: 'BODYMARKER',
  };
  const at = new Date('2026-09-24T10:00:00Z');
  const out = minimizeDerivedEvidence(evidence, { at, reason: 'content authorization revoked' });
  assert.deepEqual(Object.keys(out).sort(), [...DERIVED_EVIDENCE_PROVENANCE_KEYS, 'minimizedAt', 'minimizedReason'].sort());
  assert.equal(out.provider, 'TELEGRAM');
  assert.equal(out.providerEventId, 'ck:42');
  assert.equal(out.conversationKey, 'ck');
  assert.equal(out.aiInvocationId, 'inv-777');
  assert.equal(out.aiTaskVersion, '2.1.0');
  assert.equal(out.conversationKind, 'GROUP');
  assert.equal(out.contextTruncated, true);
  assert.equal(out.minimizedAt, '2026-09-24T10:00:00.000Z');
  assert.equal(out.minimizedReason, 'content authorization revoked');
  const json = JSON.stringify(out);
  for (const gone of ['Kickoff call', 'Propose a new time', 'this week', 'Alice Displayname', 'REQUEST', 'must not survive', 'BODYMARKER', 'topic', 'nextStep', 'deadline', 'counterpartyLabel', 'category', 'unknownFutureField']) {
    assert.equal(json.includes(gone), false, `${gone} was dropped`);
  }
  // Only keys that were present are copied: a sparse evidence yields a sparse result, never a defaulted one.
  assert.deepEqual(
    minimizeDerivedEvidence({ provider: 'TELEGRAM', topic: 'x' }, { at, reason: 'r' }),
    { provider: 'TELEGRAM', minimizedAt: at.toISOString(), minimizedReason: 'r' },
  );
  // A value that is not an object yields only the fact of the minimization.
  for (const notAnObject of [null, undefined, 'text', 7, ['a']]) {
    assert.deepEqual(minimizeDerivedEvidence(notAnObject, { at, reason: 'r' }), { minimizedAt: at.toISOString(), minimizedReason: 'r' });
  }
  // Pure: the input is not mutated.
  assert.equal(evidence.topic, 'Kickoff call');
});

test('the derived-subject prefix is one constant the producers and the withdrawal share', () => {
  assert.deepEqual({ ...DERIVED_WORK_SUBJECT_PREFIXES }, { TELEGRAM: 'telegram_conversation:' });
  assert.equal(telegramConversationSubjectRef('ck_abc'), 'telegram_conversation:ck_abc');
  assert.ok(telegramConversationSubjectRef('ck_abc').startsWith(derivedWorkSubjectPrefix('TELEGRAM')!));
  assert.equal(derivedWorkSubjectPrefix('MICROSOFT_TEAMS'), null, 'a provider that produces no derived work has no prefix');
  assert.equal(derivedWorkSubjectPrefix('GOOGLE'), null);
});

test('derivedWorkProviderOf is the reverse lookup: a derived subject names its provider, every other subject is null', () => {
  assert.equal(derivedWorkProviderOf(telegramConversationSubjectRef('ck_abc')), 'TELEGRAM');
  assert.equal(derivedWorkProviderOf('telegram_conversation:'), 'TELEGRAM', "exactly what a withdrawal's startsWith matches");
  assert.equal(derivedWorkProviderOf('thread-1'), null, 'a Gmail thread id');
  assert.equal(derivedWorkProviderOf('18f2c0a9b3d4e5f6'), null, 'a Gmail thread id as Google issues them');
  assert.equal(derivedWorkProviderOf('event-1'), null, 'a calendar event');
  assert.equal(derivedWorkProviderOf('teams_conversation:ck_abc'), null, 'a provider that produces no derived work');
  assert.equal(derivedWorkProviderOf('xtelegram_conversation:ck_abc'), null, 'a prefix, not a substring');
  assert.equal(derivedWorkProviderOf(''), null);
  // Every prefix round-trips, so a provider added to the table is found by the lookup without a second edit.
  for (const [provider, prefix] of Object.entries(DERIVED_WORK_SUBJECT_PREFIXES)) {
    assert.equal(derivedWorkProviderOf(`${prefix}anything`), provider);
    assert.equal(derivedWorkSubjectPrefix(provider), prefix);
  }
});

test('a withdrawal observation is recognisable from its reason, so an accuracy signal can skip it', () => {
  assert.equal(WORK_WITHDRAWAL_REASON_PREFIX, 'withdrawn:');
  assert.equal(workWithdrawalReason('content authorization revoked'), 'withdrawn: content authorization revoked');
  assert.equal(isWorkWithdrawalReason(workWithdrawalReason('anything')), true);
  assert.equal(isWorkWithdrawalReason('waiting on them'), false, "a person's own reason");
  assert.equal(isWorkWithdrawalReason('reconciled: resolved later in the conversation'), false, 'a reconcile close is a real close');
  assert.equal(isWorkWithdrawalReason(null), false);
  assert.equal(isWorkWithdrawalReason(undefined), false);
});
