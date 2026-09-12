// Context is additive -- and the ways it must refuse to be anything else.
//
// WHAT THESE PROVE
//
// THE VOCABULARY IS SMALL AND REASONED. Five relations, each of which somebody
// can actually record truthfully, and a written refusal explaining where
// SUPERSEDED_BY went instead of a sixth member nobody could govern.
//
// THE PROJECTION FAILS CLOSED, ROW BY ROW. An ungoverned relation, a row naming
// no evidence, a relation that needs a basis and has none -- each is skipped
// rather than guessed into the nearest member, because an ungoverned relation
// rendered as a governed one is the silent upgrade this stage exists to prevent.
//
// NOTHING HERE COMPARES TEXT. Whether two statements disagree is a claim about
// the world; this module never looks at what evidence says.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EVIDENCE_CONTEXT_EVENT,
  EVIDENCE_RELATIONS,
  EVIDENCE_RELATION_LANGUAGE,
  EVIDENCE_CONTEXT_PREFACE,
  RELATIONS_REQUIRING_BASIS,
  SUPERSEDED_BY_BELONGS_ELSEWHERE,
  isContested,
  isEvidenceRelation,
  projectEvidenceContext,
  productLabel,
  relationRequiresBasis,
  type ContextObservation,
} from '../src/index';

const obs = (over: Partial<ContextObservation> = {}): ContextObservation => ({
  id: 'obs_1',
  observationType: EVIDENCE_CONTEXT_EVENT,
  evidenceId: 'ev_1',
  relatedEvidenceId: 'ev_2',
  evidenceRelation: 'CORRECTED_BY',
  note: null,
  actorType: 'HUMAN',
  actorUserId: 'usr_matt',
  source: 'operator',
  occurredAt: '2026-08-22T11:05:00.000Z',
  recordedAt: '2026-08-22T11:05:00.000Z',
  ...over,
});

test('five relations, each one somebody can record truthfully', () => {
  assert.deepEqual([...EVIDENCE_RELATIONS], [
    'CORROBORATED_BY',
    'CONTRADICTED_BY',
    'CLARIFIED_BY',
    'CORRECTED_BY',
    'NO_LONGER_APPLICABLE',
  ]);
  // SUPERSEDED_BY is absent on purpose, and the reasoning is written down rather
  // than left as a gap for the next reader to rediscover.
  assert.equal(isEvidenceRelation('SUPERSEDED_BY'), false);
  assert.ok(SUPERSEDED_BY_BELONGS_ELSEWHERE.includes('provider_fact_revisions'));
  assert.ok(SUPERSEDED_BY_BELONGS_ELSEWHERE.includes('CORRECTED_BY'));
});

test('four relations need a basis; the fifth names a change in the world', () => {
  assert.deepEqual([...RELATIONS_REQUIRING_BASIS], [
    'CORROBORATED_BY',
    'CONTRADICTED_BY',
    'CLARIFIED_BY',
    'CORRECTED_BY',
  ]);
  assert.equal(relationRequiresBasis('NO_LONGER_APPLICABLE'), false);
});

test('every relation says what it establishes AND what it does not', () => {
  // BOTH HALVES ARE THE PRODUCT. "Corrected by" read alone is easily mistaken
  // for a verdict about the question the evidence was about.
  for (const r of EVIDENCE_RELATIONS) {
    const lang = EVIDENCE_RELATION_LANGUAGE[r];
    assert.ok(lang.label.length > 0, r);
    assert.ok(lang.establishes.length > 20, r);
    assert.ok(lang.doesNotEstablish.length > 20, r);
    assert.equal('tone' in lang, false, `${r} must carry no tone`);
    assert.equal(productLabel(r), null, `${r} must not be in the badge dictionary`);
  }
  assert.ok(EVIDENCE_CONTEXT_PREFACE.includes('unchanged'));
});

test('the projection keeps only governed, complete rows', () => {
  const byEvidence = projectEvidenceContext([
    obs({ id: 'a' }),
    // Not a context row at all.
    obs({ id: 'b', observationType: 'NOTE_ADDED' }),
    // A relation this build does not govern.
    obs({ id: 'c', evidenceRelation: 'SUPERSEDED_BY' }),
    // Needs a basis, has none.
    obs({ id: 'd', evidenceRelation: 'CORROBORATED_BY', relatedEvidenceId: null }),
    // Names no evidence.
    obs({ id: 'e', evidenceId: null }),
    // An actor type nothing produces.
    obs({ id: 'f', actorType: 'AI_MODEL' }),
  ]);
  assert.deepEqual([...(byEvidence.get('ev_1') ?? [])].map((c) => c.id), ['a']);
});

test('a relation that names a change in the world needs no basis to survive', () => {
  const byEvidence = projectEvidenceContext([
    obs({ evidenceRelation: 'NO_LONGER_APPLICABLE', relatedEvidenceId: null, note: 'We rotated the token on Tuesday.' }),
  ]);
  const entry = byEvidence.get('ev_1')?.[0];
  assert.equal(entry?.relation, 'NO_LONGER_APPLICABLE');
  assert.equal(entry?.basisEvidenceId, null);
  assert.equal(entry?.note, 'We rotated the token on Tuesday.');
});

test('context is keyed by the evidence it is ABOUT, in the order it was learned', () => {
  const byEvidence = projectEvidenceContext([
    obs({ id: 'first', evidenceId: 'ev_1', occurredAt: '2026-08-22T09:00:00.000Z' }),
    obs({ id: 'other', evidenceId: 'ev_9' }),
    obs({ id: 'second', evidenceId: 'ev_1', occurredAt: '2026-08-22T10:00:00.000Z' }),
  ]);
  assert.deepEqual((byEvidence.get('ev_1') ?? []).map((c) => c.id), ['first', 'second']);
  assert.equal((byEvidence.get('ev_9') ?? []).length, 1);
});

test('provenance survives: who said it, or which producer did', () => {
  const human = projectEvidenceContext([obs()]).get('ev_1')?.[0];
  assert.equal(human?.actorType, 'HUMAN');
  assert.equal(human?.actorUserId, 'usr_matt');
  assert.equal(human?.source, 'operator');

  // A deterministic producer is representable and carries its policy name. No
  // producer writes one today; the shape refuses to pretend otherwise by
  // requiring the same attribution a person's leaves.
  const machine = projectEvidenceContext([
    obs({ actorType: 'SYSTEM', actorUserId: null, source: 'provider-fact-convergence.v1' }),
  ]).get('ev_1')?.[0];
  assert.equal(machine?.actorType, 'SYSTEM');
  assert.equal(machine?.source, 'provider-fact-convergence.v1');
});

test('contested means recorded as disputed, never resolved', () => {
  const ctx = projectEvidenceContext([obs({ evidenceRelation: 'CONTRADICTED_BY' })]).get('ev_1') ?? [];
  assert.equal(isContested(ctx), true);
  const agreed = projectEvidenceContext([obs({ evidenceRelation: 'CORROBORATED_BY' })]).get('ev_1') ?? [];
  assert.equal(isContested(agreed), false);
});

test('the module never reads what the evidence says', () => {
  // A relation derived from text similarity would be a model guessing about
  // language and calling it a fact about the world. There is no path to it here.
  const source = readFileSync(new URL('../src/evidence-context.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  // WORD BOUNDARIES, because the file's own written refusal contains the word
  // "restatements" -- and a check that fires on prose gets weakened by the next
  // person rather than obeyed.
  assert.equal(/\bstatement\b|\bsimilar|\bembedding|\bcompare/i.test(source), false);
});
