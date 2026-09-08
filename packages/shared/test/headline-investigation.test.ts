// The pure half of Headline → Case: identity, severity, vocabulary.
//
// These are cheap and they carry real weight, because identity is what makes a
// second press of Investigate land on the investigation that already exists
// rather than opening a duplicate one into the same Headline.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INVESTIGATION_AUTHORIZED_REASON,
  INVESTIGATION_PRODUCER,
  INVESTIGATION_PRODUCER_VERSION,
  PROMOTION_OUTCOMES,
  investigationDetectionKey,
  investigationRecurrenceKey,
  promotionOpenedOrFoundCase,
  severityForHeadline,
} from '../src/headline-investigation';
import { DECISION_SEVERITIES } from '../src/decision-contract';

test('the investigation identity is derived from the headline and is stable', () => {
  assert.equal(investigationRecurrenceKey('hl_1'), 'headline:hl_1');
  assert.equal(investigationRecurrenceKey('hl_1'), investigationRecurrenceKey('hl_1'));
  assert.notEqual(investigationRecurrenceKey('hl_1'), investigationRecurrenceKey('hl_2'));
});

test('the identity contains NO timestamp, which is what makes a repeat press safe', () => {
  const key = investigationRecurrenceKey('hl_1');
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(key), 'no date');
  assert.ok(!/\d{10,}/.test(key), 'no epoch');
});

test('the detection key is stable too, so a concurrent double-press collides', () => {
  assert.equal(investigationDetectionKey('hl_1'), 'promotion:hl_1');
  assert.notEqual(investigationDetectionKey('hl_1'), investigationRecurrenceKey('hl_1'));
});

test('SEVERITY IS MODEST: a headline may reach NOTABLE and never HIGH or CRITICAL', () => {
  // What a Headline knows is whether the move ran against a stated objective — a
  // fact about arithmetic and a human's declared intent. It does not know the
  // move is critical to the business, so it may not say so.
  assert.equal(severityForHeadline(true), 'NOTABLE');
  assert.equal(severityForHeadline(false), 'INFORMATIONAL');
  for (const v of [true, false]) {
    const s = severityForHeadline(v);
    assert.ok((DECISION_SEVERITIES as readonly string[]).includes(s), 'a shipped severity');
    assert.ok(s !== 'HIGH' && s !== 'CRITICAL');
  }
});

test('the authorization reason states what the decision is NOT', () => {
  assert.match(INVESTIGATION_AUTHORIZED_REASON, /authorized/i);
  assert.match(INVESTIGATION_AUTHORIZED_REASON, /not a judgement that it is correct/);
});

test('the producer names Commercial Intelligence, not a provider', () => {
  assert.equal(INVESTIGATION_PRODUCER, 'commercial-intelligence');
  assert.ok(!INVESTIGATION_PRODUCER.includes('callgrid'));
  assert.equal(INVESTIGATION_PRODUCER_VERSION, 'headline-investigation.v1');
});

test('the outcome vocabulary is closed and only two mean a case exists', () => {
  assert.deepEqual([...PROMOTION_OUTCOMES].sort(), [
    'ALREADY_INVESTIGATING',
    'HEADLINE_NOT_FOUND',
    'NO_AUTHORIZING_HUMAN',
    'PROMOTED',
  ]);
  for (const o of PROMOTION_OUTCOMES) {
    assert.equal(promotionOpenedOrFoundCase(o), o === 'PROMOTED' || o === 'ALREADY_INVESTIGATING');
  }
});
