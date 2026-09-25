// Loop Intelligence Phase G: Loop's deterministic Briefing (the fallback that means a Briefing always exists).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ruleBriefing, type BriefingArtifact } from '../src/services/intelligence-fabric/briefing';

const a = (ref: string, status: BriefingArtifact['status'], domain = 'WORK'): BriefingArtifact => ({ ref, domain, title: 'Your work', statement: `${ref} statement.`, status, signals: [], basis: ref });

test('the rule Briefing leads with what needs you, cites each line to its artifact, and never invents one', () => {
  const b = ruleBriefing([a('digest:calm', 'CALM'), a('digest:watch', 'WATCH'), a('digest:att', 'ATTENTION'), a('situation:s1', 'WATCH', 'SITUATION')]);
  assert.equal(b.headline, '1 part of your work needs attention today.');
  assert.deepEqual(b.lines.map((l) => [l.kind, l.citations]), [['NEEDS_YOU', ['digest:att']], ['WATCH', ['digest:watch']], ['WATCH', ['situation:s1']]]);
  assert.ok(!b.lines.some((l) => l.citations.includes('digest:calm')), 'a calm reading is not a line');
  assert.equal(ruleBriefing([]).headline, 'Loop has nothing it can read for you yet today.');
  assert.equal(ruleBriefing([a('digest:calm', 'CALM')]).headline, 'Nothing pressing in what Loop can read for you today.');
});
