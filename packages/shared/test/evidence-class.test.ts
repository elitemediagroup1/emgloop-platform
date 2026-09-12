// How evidence arrived -- and the meanings the class is not allowed to carry.
//
// WHAT THESE PROVE
//
// THE VOCABULARY IS NARROW ON PURPOSE. Two members, both of which something
// actually produces. A taxonomy invented ahead of its producers is the same
// failure as a button that does nothing.
//
// THE CLASS RANKS NOTHING. It says how evidence entered Loop, never whether to
// believe it: no tone, no score, no ordering, and no place in the state-badge
// dictionary. A reader that could render HUMAN_REPORTED with the tick that means
// "Loop stands behind this" would have published a hierarchy nobody decided.
//
// AN UNKNOWN CLASS IS NOT MEASURED. The one question the Stage 3 gate asks fails
// closed, so a row this build does not recognise can never be the one that
// reaches a measurement gate.
//
// EVIDENCE NAMING NO MEASURE CANNOT CONTRADICT ANYTHING. Grouping on a null
// metric would make every unmeasured row "the same measurement" as every other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_EVIDENCE_CLASS,
  EVIDENCE_CLASSES,
  EVIDENCE_CLASS_LANGUAGE,
  HUMAN_REPORT_CAVEAT,
  HUMAN_REPORT_SOURCE,
  findEvidenceContradictions,
  isEvidenceClass,
  isMeasuredEvidence,
  productLabel,
  reportedLine,
  type FindingEvidenceRef,
} from '../src/index';

test('two classes, and the default is the one every older row truthfully has', () => {
  assert.deepEqual([...EVIDENCE_CLASSES], ['MEASURED', 'HUMAN_REPORTED']);
  assert.equal(DEFAULT_EVIDENCE_CLASS, 'MEASURED');
});

test('an unrecognised class is not measured — the gate question fails closed', () => {
  assert.equal(isMeasuredEvidence({ evidenceClass: 'MEASURED' }), true);
  assert.equal(isMeasuredEvidence({ evidenceClass: 'HUMAN_REPORTED' }), false);
  for (const unknown of ['DETERMINISTIC_DIAGNOSTIC', 'DOCUMENT', '', 'measured']) {
    assert.equal(isMeasuredEvidence({ evidenceClass: unknown }), false, unknown);
    assert.equal(isEvidenceClass(unknown), false, unknown);
  }
});

test('the class carries no tone, and no state badge can render one', () => {
  // THE FIVE TONES SAY WHAT LOOP KNOWS. How evidence arrived is not that.
  for (const c of EVIDENCE_CLASSES) {
    const label = EVIDENCE_CLASS_LANGUAGE[c];
    assert.ok(label.label.length > 0);
    assert.equal('tone' in label, false, `${c} must carry no tone`);
    assert.equal(productLabel(c), null, `${c} must not be in the badge dictionary`);
  }
});

test('the class vocabulary states no trust, authority or reliability', () => {
  // A2: evidence class identifies how evidence entered Loop. It does NOT encode
  // trust, authority, reliability, diagnostic power or confidence -- those belong
  // to claim-type standards that do not exist yet, and a word here would be read
  // as the ranking this file refuses to make.
  const source = readFileSync(new URL('../src/evidence-class.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  assert.equal(/confidence|reliab|trust|weight|score|rank/i.test(source), false);
});

test('a report reads as attributed, never as a bare fact', () => {
  assert.equal(reportedLine('usr_matt'), 'usr_matt reported');
  assert.equal(reportedLine(null), 'Somebody reported');
  assert.ok(HUMAN_REPORT_CAVEAT.includes('has not established'));
  // The caveat must not hedge into implying Loop DOUBTS it either: it records
  // what is true, which is that it was reported.
  assert.equal(/doubt|unverified|unreliable|suspect/i.test(HUMAN_REPORT_CAVEAT), false);
});

test('a human report is recorded under the actor vocabulary the log already uses', () => {
  assert.equal(HUMAN_REPORT_SOURCE, 'operator');
});

const ref = (over: Partial<FindingEvidenceRef> = {}): FindingEvidenceRef => ({
  id: 'ev_1',
  source: 'ci',
  metricKey: 'REVENUE',
  window: 'w1',
  value: 10,
  completeness: 1,
  ...over,
});

test('evidence naming no measure takes no part in contradiction detection', () => {
  // Two rows with different values, different sources, and no metric between
  // them. They are not a disagreement about anything.
  const found = findEvidenceContradictions([
    ref({ id: 'a', metricKey: null, source: 's1', value: 1 }),
    ref({ id: 'b', metricKey: null, source: 's2', value: 2 }),
  ]);
  assert.deepEqual(found, []);

  // And a null-metric row cannot be dragged into a real contradiction either.
  const real = findEvidenceContradictions([
    ref({ id: 'a', source: 's1', value: 1 }),
    ref({ id: 'b', source: 's2', value: 2 }),
    ref({ id: 'c', metricKey: null, source: 's3', value: 3 }),
  ]);
  assert.equal(real.length, 1);
  assert.deepEqual(real[0]?.evidenceIds, ['a', 'b']);
});
