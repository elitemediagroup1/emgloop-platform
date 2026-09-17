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
  WORK_TERMINATION_GRACE_DAYS,
  isWorkSource,
  workRetentionCategory,
} from '../src/work-state';

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'database', 'prisma', 'migrations', '20260920000000_daily_loop_work_state', 'migration.sql'),
  'utf8',
);

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
    for (const word of list) {
      assert.match(MIGRATION, new RegExp(`'${word}'`), `${name}: ${word} is not pinned in the migration`);
    }
  }
  // And the quote cap is the same number in both places.
  assert.equal(WORK_EVIDENCE_QUOTE_MAX_CHARS, 240);
  assert.match(MIGRATION, /length\("evidenceQuote"\) <= 240/);
});

test('retention is a window per category, and every work table is covered exactly once', () => {
  assert.equal(WORK_RETENTION_POLICY_VERSION, 'work-retention.2026-09-17.1');

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
