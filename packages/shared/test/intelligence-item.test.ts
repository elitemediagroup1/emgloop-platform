// How what happened before changes what Loop suggests now: learnFromHistory, PURE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnFromHistory, outcomeWords, type PriorOutcome } from '../src';

const at = (day: number) => new Date(Date.UTC(2026, 8, day));
const same = (outcome: string, day: number, reason: string | null = null): PriorOutcome => ({ at: at(day), outcome, reason, relation: 'SAME', subjectLabel: 'x' });
const like = (outcome: string, day: number): PriorOutcome => ({ at: at(day), outcome, reason: null, relation: 'COMPARABLE', subjectLabel: 'y' });
const FALLBACK = { posture: 'REVIEW' as const, text: 'Look into it.' };

test('no history: the producer’s own suggestion stands, with no invented basis', () => {
  assert.deepEqual(learnFromHistory([], FALLBACK), { posture: 'REVIEW', text: 'Look into it.', basis: null });
});

test('it went away on its own before: WATCH, saying how many times', () => {
  assert.deepEqual(learnFromHistory([same('RECOVERED', 3), same('NO_ACTION_NEEDED', 9)], FALLBACK), {
    posture: 'WATCH',
    text: 'Watch it before acting.',
    basis: 'The last 2 times this happened, it needed no action.',
  });
  assert.equal(learnFromHistory([same('RECOVERED', 9)], FALLBACK).basis, 'The last time this happened, it recovered without action.');
});

test('it was a false alarm last time: REVIEW before acting, quoting the person', () => {
  const learned = learnFromHistory([same('RECOVERED', 3), same('FALSE_POSITIVE', 9, 'tracking bug')], FALLBACK);
  assert.equal(learned.posture, 'REVIEW');
  assert.equal(learned.basis, 'The last time Loop raised this, it was a false alarm ("tracking bug").');
});

test('it needed action last time: ACT, as then -- the most recent outcome wins over older ones', () => {
  assert.equal(learnFromHistory([same('RECOVERED', 3), same('CONVERTED_TO_WORK', 9)], FALLBACK).posture, 'ACT');
  assert.equal(learnFromHistory([same('CONVERTED_TO_WORK', 3), same('RECOVERED', 9)], FALLBACK).posture, 'WATCH');
});

test('comparable history counts only when it is consistent and never overrides the situation’s own', () => {
  assert.equal(learnFromHistory([like('RECOVERED', 3), like('NO_ACTION_NEEDED', 5)], FALLBACK).posture, 'WATCH');
  assert.equal(learnFromHistory([like('RECOVERED', 3)], FALLBACK).posture, 'REVIEW', 'one comparable case is not a pattern');
  assert.equal(learnFromHistory([like('RECOVERED', 3), like('NO_ACTION_NEEDED', 5), like('NOT_RECOVERED', 7)], FALLBACK).posture, 'REVIEW', 'mixed history is not a pattern');
  assert.equal(learnFromHistory([like('RECOVERED', 3), like('RECOVERED', 5), same('CONVERTED_TO_WORK', 9)], FALLBACK).posture, 'ACT', 'its own history wins');
});

test('outcome words are plain', () => {
  assert.equal(outcomeWords('CONVERTED_TO_WORK'), 'became work');
  assert.equal(outcomeWords('SOMETHING_NEW'), 'something new');
});
