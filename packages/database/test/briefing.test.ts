// Loop Intelligence Phase G: Loop's deterministic Briefing (the fallback that means a Briefing always
// exists) -- and the truthfulness rules it shares with the composed one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARTIAL_COVERAGE_LIMITATION } from '@emgloop/shared';

import { briefingAbsenceJustified, gapLimitations, ruleBriefing, historicalBriefingReferences, type BriefingArtifact } from '../src/services/intelligence-fabric/briefing';

const a = (ref: string, status: BriefingArtifact['status'], domain = 'WORK', coverage: BriefingArtifact['coverage'] = 'CONNECTED_SUFFICIENT'): BriefingArtifact => ({
  ref, domain, title: 'Your work', statement: `${ref} statement.`, status, signals: [], basis: ref, coverage,
  limitations: coverage === 'CONNECTED_PARTIAL' ? [PARTIAL_COVERAGE_LIMITATION] : [],
});

test('the rule Briefing leads with what needs you, cites each line to its artifact, and never invents one', () => {
  const b = ruleBriefing([a('digest:calm', 'CALM'), a('digest:watch', 'WATCH'), a('digest:att', 'ATTENTION'), a('situation:s1', 'WATCH', 'SITUATION')]);
  assert.equal(b.headline, '1 part of your work needs attention today.');
  assert.deepEqual(b.lines.map((l) => [l.kind, l.citations]), [['NEEDS_YOU', ['digest:att']], ['WATCH', ['digest:watch']], ['WATCH', ['situation:s1']]]);
  assert.ok(!b.lines.some((l) => l.citations.includes('digest:calm')), 'a calm reading is not a line');
  assert.equal(ruleBriefing([]).headline, 'Loop has nothing it can read for you yet today.');
});

test('AI-off fallback: "nothing pressing" ONLY when every reading is SUFFICIENT and nothing was left out', () => {
  assert.equal(ruleBriefing([a('digest:calm', 'CALM')]).headline, 'Nothing pressing in what Loop can read for you today.');
  // PARTIAL coverage never justifies an absence.
  const partial = ruleBriefing([a('digest:calm', 'CALM', 'WORK', 'CONNECTED_PARTIAL')]);
  assert.doesNotMatch(partial.headline, /nothing pressing/i);
  assert.match(partial.headline, /cannot say nothing is pressing/);
  assert.ok(partial.limitations.includes(PARTIAL_COVERAGE_LIMITATION), 'the partial reading keeps its limitation');
  // A reading Loop holds but could not use today (stale, disconnected, insufficient, error) is a gap, not quiet.
  for (const coverage of ['STALE', 'DISCONNECTED', 'CONNECTED_INSUFFICIENT', 'ERROR'] as const) {
    const gapped = ruleBriefing([a('digest:calm', 'CALM')], [{ domain: 'MAIL', coverage }]);
    assert.doesNotMatch(gapped.headline, /nothing pressing/i, coverage);
    assert.ok(gapped.limitations.some((l) => l.startsWith('Mail ')), `${coverage} is said`);
  }
  // Nothing readable but gaps: never "nothing to read", never "nothing pressing".
  assert.match(ruleBriefing([], [{ domain: 'CALENDAR', coverage: 'STALE' }]).headline, /cannot say nothing is pressing/);
});

test('a PARTIAL reading says it is partial in its line', () => {
  const b = ruleBriefing([a('digest:p', 'ATTENTION', 'WORK', 'CONNECTED_PARTIAL')]);
  assert.match(b.lines[0]!.statement, /\(from a partial reading\)$/);
});

test('gap words are Loop’s own and name the part, never a source’s text', () => {
  assert.deepEqual(gapLimitations([{ domain: 'MAIL', coverage: 'STALE' }, { domain: 'CALLGRID', coverage: 'CONNECTED_INSUFFICIENT' }]), ['Mail is out of date, so it is not in today’s Briefing.', 'CallGrid has too little to go on, so it is not in today’s Briefing.']);
  assert.equal(briefingAbsenceJustified([a('d', 'CALM')], []), true);
  assert.equal(briefingAbsenceJustified([a('d', 'CALM')], [{ domain: 'MAIL', coverage: 'STALE' }]), false);
});

test('fallback preserves complete sentences and decimal amounts and never exposes structured JSON', () => {
  const source = { ...a('snapshot:callgrid', 'WATCH', 'CALLGRID', 'CONNECTED_PARTIAL'), title: 'CallGrid', statement: '{"calls":475,"reportedRevenue":"2965.91"}', displayStatement: '475 stored calls, 148 monetized. Reported revenue is $2965.91.' };
  const line = ruleBriefing([source]).lines[0]!;
  assert.equal(line.statement, 'CallGrid: 475 stored calls, 148 monetized. Reported revenue is $2965.91. (from a partial reading)');
  assert.doesNotMatch(ruleBriefing([{ ...source, displayStatement: undefined }]).lines[0]!.statement, /\{|reportedRevenue/);
  const long = ruleBriefing([{ ...source, displayStatement: 'One complete sentence. ' + 'x'.repeat(400) + '.' }]).lines[0]!.statement;
  assert.equal(long, 'CallGrid: One complete sentence. (from a partial reading)');
  assert.ok(long.length <= 240);
});


test('historical references distinguish authorized stale sources from revoked, withdrawn and expired evidence', () => {
  const now = new Date('2026-10-16T14:00:00Z');
  const rows = [
    { id: 'mail', provider: 'GMAIL' as const, status: 'STALE' as const, expiresAt: new Date('2026-11-01') },
    { id: 'withdrawn', provider: null, status: 'WITHDRAWN' as const, expiresAt: new Date('2026-11-01') },
    { id: 'expired', provider: null, status: 'CURRENT' as const, expiresAt: now },
    { id: 'disconnected', provider: 'TELEGRAM' as const, status: 'CURRENT' as const, expiresAt: new Date('2026-11-01') },
  ];
  const sources = new Map(rows.map((r) => [r.id, { connectionLive: r.id !== 'disconnected' }]));
  const candidates = [a('snapshot:callgrid', 'WATCH', 'CALLGRID'), a('digest:mail', 'ATTENTION', 'MAIL')];
  assert.deepEqual(historicalBriefingReferences(candidates, rows, sources, now, true), ['snapshot:callgrid', 'digest:mail']);
  assert.deepEqual(historicalBriefingReferences(candidates, rows, sources, now, false), ['snapshot:callgrid'], 'a candidate digest cannot bypass revoked Mail authorization');
  assert.deepEqual(historicalBriefingReferences(candidates, rows, new Map(), now, true), ['snapshot:callgrid'], 'unknown source permission fails closed');
});
