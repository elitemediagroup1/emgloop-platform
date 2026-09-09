// The Stage 4 event vocabulary: typed meaning, legacy history, and the line
// between the two.
//
// WHAT THESE PROVE. That a new row is understood from its governed type alone;
// that a row written before the vocabulary existed still reads correctly; that
// the two never disagree; and that the prose which used to be load-bearing is
// no longer consulted for any current row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CASE_EVENT_KINDS,
  CASE_EVENT_REASONS,
  CASE_EVENT_TYPE,
  LEGACY_CASE_EVENT_SIGNATURES,
  caseEventKind,
  isCaseEvent,
  isCaseEventKind,
  isLegacyCaseEvent,
  OBSERVATION_TYPES,
  DECISION_EVENT_TYPE,
  projectLifecycle,
  isInvestigationAuthorization,
  isFindingRecorded,
  isFindingSuperseded,
  isRecommendationEvent,
  isParticipationEvent,
  INVESTIGATION_AUTHORIZED_REASON,
  FINDING_RECORDED_REASON,
  FINDING_SUPERSEDED_REASON,
  RECOMMENDATION_RECORDED_REASON,
  RECOMMENDATION_SELECTED_REASON,
  RECOMMENDATION_DISMISSED_REASON,
  RECOMMENDATION_REVISED_REASON,
  PARTICIPANT_ADDED_REASON,
  PARTICIPANT_CHANGED_REASON,
  PARTICIPANT_RELEASED_REASON,
  type CaseEventKind,
  type ObservationType,
} from '../src/index';

const HUMAN = 'HUMAN';
const SYSTEM = 'SYSTEM';

function current(kind: CaseEventKind, actorType = HUMAN) {
  return {
    actorType,
    observationType: CASE_EVENT_TYPE[kind] as string,
    reason: CASE_EVENT_REASONS[kind],
  };
}

function legacy(kind: CaseEventKind, actorType = HUMAN) {
  const sig = LEGACY_CASE_EVENT_SIGNATURES[kind];
  return { actorType, observationType: sig.observationType as string, reason: sig.reason };
}

// --- 1. The vocabulary is governed, not prose --------------------------------------

test('1. every meaning has an observation type of its own', () => {
  const types = CASE_EVENT_KINDS.map((k) => CASE_EVENT_TYPE[k]);
  assert.equal(new Set(types).size, CASE_EVENT_KINDS.length, 'no two meanings share a type');
  for (const t of types) {
    assert.ok(
      (OBSERVATION_TYPES as readonly string[]).includes(t),
      `${t} is a real member of the observation vocabulary`,
    );
  }
});

test('1b. a current row is understood from its type ALONE, whatever the prose says', () => {
  for (const kind of CASE_EVENT_KINDS) {
    // The reason line is replaced with something a copy-editor might have
    // written, or with nothing at all. This is the exact change that used to
    // break the history silently.
    const reworded = { ...current(kind), reason: 'Somebody rewrote this sentence.' };
    const blank = { ...current(kind), reason: null };
    assert.equal(caseEventKind(reworded), kind, `${kind} survives a reworded reason`);
    assert.equal(caseEventKind(blank), kind, `${kind} survives a missing reason`);
  }
});

test('1c. the meanings are disjoint: one row is never two events', () => {
  for (const kind of CASE_EVENT_KINDS) {
    const row = current(kind);
    const matches = CASE_EVENT_KINDS.filter((k) => isCaseEvent(row, k));
    assert.deepEqual(matches, [kind], `${kind} matches itself and nothing else`);
  }
});

test('1d. an ordinary note is not a Stage 4 event', () => {
  assert.equal(caseEventKind({ actorType: HUMAN, observationType: 'NOTE_ADDED', reason: null }), null);
  assert.equal(
    caseEventKind({ actorType: HUMAN, observationType: 'NOTE_ADDED', reason: 'Called the buyer.' }),
    null,
  );
  assert.equal(caseEventKind({ actorType: SYSTEM, observationType: 'SITUATION_DETECTED', reason: null }), null);
});

test('1e. a plain REVIEWED is somebody reading, not somebody authorizing', () => {
  assert.equal(
    isInvestigationAuthorization({ actorType: HUMAN, observationType: 'REVIEWED', reason: 'Had a look.' }),
    false,
  );
});

// --- 2. Legacy history stays readable ---------------------------------------------

test('2. every pre-migration row still reads as the same meaning', () => {
  for (const kind of CASE_EVENT_KINDS) {
    assert.equal(caseEventKind(legacy(kind)), kind, `${kind} recorded before the migration`);
  }
});

test('2b. legacy and current rows agree, always', () => {
  for (const kind of CASE_EVENT_KINDS) {
    assert.equal(caseEventKind(legacy(kind)), caseEventKind(current(kind)));
  }
});

test('2c. the legacy path is the ONLY place prose is compared, and only for old types', () => {
  for (const kind of CASE_EVENT_KINDS) {
    // A pre-migration generic row whose sentence does not match exactly is not
    // this event. That strictness is why the reason had to stop being the
    // distinction, and it is preserved for the rows that still depend on it.
    const drifted = { ...legacy(kind), reason: legacy(kind).reason + ' ' };
    assert.equal(caseEventKind(drifted), null, `${kind} with a drifted legacy sentence`);
  }
});

test('2d. isLegacyCaseEvent tells the two apart WITHOUT changing what they mean', () => {
  for (const kind of CASE_EVENT_KINDS) {
    assert.equal(isLegacyCaseEvent(legacy(kind)), true);
    assert.equal(isLegacyCaseEvent(current(kind)), false);
    // Same meaning either way — the flag is for operations, never for behaviour.
    assert.equal(caseEventKind(legacy(kind)), caseEventKind(current(kind)));
  }
  assert.equal(isLegacyCaseEvent({ actorType: HUMAN, observationType: 'NOTE_ADDED', reason: null }), false);
});

// --- 3. A type name is not a human ---------------------------------------------------

test('3. a SYSTEM actor cannot authorize an investigation, typed or legacy', () => {
  assert.equal(caseEventKind(current('INVESTIGATION_AUTHORIZED', SYSTEM)), null);
  assert.equal(caseEventKind(legacy('INVESTIGATION_AUTHORIZED', SYSTEM)), null);
  assert.equal(isInvestigationAuthorization(current('INVESTIGATION_AUTHORIZED', SYSTEM)), false);
});

test('3b. the human gate applies to authorization and to nothing else', () => {
  // Loop itself records findings and recommendations; requiring a human there
  // would make the machine unable to write its own analysis.
  for (const kind of CASE_EVENT_KINDS) {
    if (kind === 'INVESTIGATION_AUTHORIZED') continue;
    assert.equal(caseEventKind(current(kind, SYSTEM)), kind, `${kind} may be recorded by Loop`);
  }
});

// --- 4. The four feature predicates now read the type --------------------------------

test('4. the feature predicates answer identically for both representations', () => {
  const cases: Array<[CaseEventKind, (o: { actorType: string; observationType: string; reason: string | null }) => boolean]> = [
    ['INVESTIGATION_AUTHORIZED', (o) => isInvestigationAuthorization(o)],
    ['FINDING_RECORDED', (o) => isFindingRecorded(o)],
    ['FINDING_SUPERSEDED', (o) => isFindingSuperseded(o)],
    ['RECOMMENDATION_RECORDED', (o) => isRecommendationEvent(o, 'RECORDED')],
    ['RECOMMENDATION_SELECTED', (o) => isRecommendationEvent(o, 'SELECTED')],
    ['RECOMMENDATION_DISMISSED', (o) => isRecommendationEvent(o, 'DISMISSED')],
    ['RECOMMENDATION_REVISED', (o) => isRecommendationEvent(o, 'REVISED')],
    ['PARTICIPANT_ADDED', (o) => isParticipationEvent(o, 'ADDED')],
    ['PARTICIPANT_CHANGED', (o) => isParticipationEvent(o, 'CHANGED')],
    ['PARTICIPANT_RELEASED', (o) => isParticipationEvent(o, 'RELEASED')],
  ];
  assert.equal(cases.length, CASE_EVENT_KINDS.length, 'every meaning has a predicate exercised here');
  for (const [kind, predicate] of cases) {
    assert.equal(predicate(current(kind)), true, `${kind} current`);
    assert.equal(predicate(legacy(kind)), true, `${kind} legacy`);
    // And it does not answer true for a neighbour.
    const other = CASE_EVENT_KINDS.find((k) => k !== kind)!;
    assert.equal(predicate(current(other)), false, `${kind} predicate rejects ${other}`);
  }
});

test('4b. the exported reason constants are the same sentences as before', () => {
  // Verbatim, so a Case whose log spans the migration reads continuously. These
  // literals are the pre-migration text; if this test is ever "fixed" by editing
  // them, the legacy history stops matching and that is the bug.
  assert.equal(
    INVESTIGATION_AUTHORIZED_REASON,
    'A person authorized this Headline for organizational investigation. ' +
      'That is a decision to look into it, not a judgement that it is correct.',
  );
  assert.equal(
    FINDING_RECORDED_REASON,
    'Loop recorded a finding on this investigation. A finding is a claim about what is ' +
      'happening, not a decision about what to do.',
  );
  assert.equal(
    FINDING_SUPERSEDED_REASON,
    'A newer finding replaced the previous one on this investigation. The previous finding is ' +
      'kept in full.',
  );
  assert.equal(
    RECOMMENDATION_RECORDED_REASON,
    'Loop recorded what could be done about this finding. These are options for a person to ' +
      'weigh, not decisions, and nothing here has been approved or acted on.',
  );
  assert.equal(
    RECOMMENDATION_SELECTED_REASON,
    'A person selected one of the options Loop proposed. Selecting is a decision to pursue it; ' +
      'it is not the same as having done it, and it changes nothing outside Loop.',
  );
  assert.equal(
    RECOMMENDATION_DISMISSED_REASON,
    'A person set one of the options aside. Loop keeps what it proposed exactly as it was.',
  );
  assert.equal(
    RECOMMENDATION_REVISED_REASON,
    'A person revised one of the options. The version Loop proposed is kept unchanged alongside it.',
  );
  assert.equal(
    PARTICIPANT_ADDED_REASON,
    'A person was asked to contribute to this investigation. Being asked is not being ' +
      'assigned work, and nothing was created anywhere else.',
  );
  assert.equal(
    PARTICIPANT_CHANGED_REASON,
    'What a person is being asked to contribute to this investigation changed. The previous ' +
      'request is kept on this log.',
  );
  assert.equal(
    PARTICIPANT_RELEASED_REASON,
    'A person was released from this investigation. What they were asked for is kept.',
  );
});

// --- 5. Nothing about the Case's lane changed ----------------------------------------

test('5. a Case replays to the same lane before and after the migration', () => {
  // The whole log, written both ways. The projection must not be able to tell.
  const at = (n: number) => new Date(Date.UTC(2026, 8, 1, n));
  const build = (shape: 'current' | 'legacy') =>
    CASE_EVENT_KINDS.map((kind, i) => {
      const row = shape === 'current' ? current(kind) : legacy(kind);
      return {
        observationType: row.observationType as ObservationType,
        occurredAt: at(i + 1),
        sequence: i + 1,
        actorType: row.actorType as 'HUMAN',
        assignedToUserId: null,
        previousState: null,
        newState: null,
        outcome: null,
        measuredEffectCents: null,
      };
    });

  const now = projectLifecycle(build('current'));
  const then = projectLifecycle(build('legacy'));
  assert.equal(now.state, then.state);
  assert.equal(now.state, 'NEEDS_REVIEW', 'none of these ten events moves a Case between lanes');
  assert.equal(now.assigneeUserId, then.assigneeUserId);
  assert.equal(now.ownerUserId, then.ownerUserId);
  assert.equal(now.reopenCount, then.reopenCount);
  assert.equal(now.resolvedAt, then.resolvedAt);
  assert.equal(now.outcome, then.outcome);
});

test('5b. authorization does not clear the review queue, exactly as REVIEWED did not', () => {
  const one = projectLifecycle([
    {
      observationType: 'INVESTIGATION_AUTHORIZED',
      occurredAt: new Date('2026-09-01T00:00:00Z'),
      sequence: 1,
      actorType: 'HUMAN',
      assignedToUserId: null,
      previousState: null,
      newState: null,
      outcome: null,
      measuredEffectCents: null,
    },
  ]);
  assert.equal(one.state, 'NEEDS_REVIEW', 'a queue is cleared by deciding, not by authorizing');
});

// --- 6. The published event contract did not move ------------------------------------

test('6. the new types announce the events their generic predecessors announced', () => {
  // Naming an observation better must not change what every existing subscriber
  // receives. Authorization was a REVIEWED row; the other nine were notes.
  assert.equal(DECISION_EVENT_TYPE.INVESTIGATION_AUTHORIZED, DECISION_EVENT_TYPE.REVIEWED);
  for (const kind of CASE_EVENT_KINDS) {
    if (kind === 'INVESTIGATION_AUTHORIZED') continue;
    assert.equal(
      DECISION_EVENT_TYPE[CASE_EVENT_TYPE[kind]],
      DECISION_EVENT_TYPE.NOTE_ADDED,
      `${kind} announces what it announced before`,
    );
  }
});

// --- 7. Source discipline --------------------------------------------------------------

test('7. no feature module compares a Stage 4 reason line any more', () => {
  // The debt being retired was four files each matching prose. `case-observation`
  // is now the only file allowed to, and only for pre-migration rows. A new
  // `reason ===` comparison in a feature module is the regression this catches.
  for (const file of [
    'src/case-finding.ts',
    'src/case-recommendation.ts',
    'src/case-participation.ts',
    'src/headline-investigation.ts',
  ]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.equal(
      /observation\.reason\s*===/.test(src),
      false,
      `${file} must not decide what a row means by reading its reason`,
    );
  }
});

test('7b. the legacy table is closed: one entry per meaning, no more', () => {
  assert.deepEqual(
    Object.keys(LEGACY_CASE_EVENT_SIGNATURES).sort(),
    [...CASE_EVENT_KINDS].sort(),
    'a new meaning gets a typed member and no legacy entry',
  );
  // And every legacy signature uses one of the two generic types it actually
  // used. A "legacy" entry naming a Stage 4 type would be a contradiction.
  for (const kind of CASE_EVENT_KINDS) {
    const t = LEGACY_CASE_EVENT_SIGNATURES[kind].observationType;
    assert.ok(t === 'NOTE_ADDED' || t === 'REVIEWED', `${kind} legacy type is generic`);
  }
});

test('7c. isCaseEventKind is a real guard', () => {
  assert.equal(isCaseEventKind('FINDING_RECORDED'), true);
  assert.equal(isCaseEventKind('NOTE_ADDED'), false);
  assert.equal(isCaseEventKind(''), false);
});
