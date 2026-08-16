// The Commercial Signal contract and the Stage 2 reference evaluator.
//
// The properties these tests exist to hold, in order of how badly they would
// hurt if they broke:
//
//   1. OBJECTIVE-RELATIVE RELEVANCE. The same observed fact must be able to
//      matter to one objective and not to another. If this collapses, Commercial
//      Intelligence has quietly become "interesting things Loop noticed", which
//      is the thing the whole stage exists to not be.
//   2. NO RELEVANCE, NO RECORD. The evaluator returns null rather than a
//      negative determination, because that null IS the persistence model.
//   3. PURITY AND DETERMINISM. Same inputs, same answer, every time. A stored
//      determination that cannot be reproduced is not provenance, it is a claim.
//   4. FACT AND INFERENCE STAY APART. The evaluator states relevance; it never
//      restates the observation as though CI had established it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMERCIAL_SIGNAL_CONTRACT_VERSION,
  COMMERCIAL_SIGNAL_RELEVANCE_BASES,
  TERM_MATCH_EVALUATOR_ID,
  TERM_MATCH_EVALUATOR_VERSION,
  commercialTerms,
  evaluateTermMatch,
  isCommercialSignalRelevanceBasis,
  type CommercialObservation,
} from '../src/commercial-signal';

// A fixed instant. Nothing in the evaluator reads a clock, and this proves it by
// never giving it one that could differ between runs.
const T0 = new Date('2026-08-16T09:00:00.000Z');

function call(over: Partial<CommercialObservation> = {}): CommercialObservation {
  return {
    sourceSystem: 'CALLGRID',
    sourceKey: 'call-1001',
    sourceReference: 'call-1001',
    observedAt: T0,
    summary: 'Call call-1001 (COMPLETED): Roofing - TX / HomeAdvisor',
    descriptors: ['Roofing - TX', 'HomeAdvisor'],
    ...over,
  };
}

const ROOFING = { title: 'Grow roofing lead revenue in Texas', description: null };
const SSDI = { title: 'Increase SSDI buyer capacity', description: null };

// --- The central property -----------------------------------------------------

test('the same observation is relevant to one objective and not another', () => {
  const observation = call();

  const roofing = evaluateTermMatch(ROOFING, observation);
  const ssdi = evaluateTermMatch(SSDI, observation);

  assert.ok(roofing, 'a roofing call should be relevant to a roofing objective');
  assert.equal(ssdi, null, 'the same call carries no relevance to SSDI buyer capacity');

  // This asymmetry is the whole stage: commercial significance is not a property
  // the fact carries, it is a relation between the fact and an intent.
  assert.equal(roofing.basis, 'TERM_MATCH');
});

test('an observation matching nothing produces no determination at all', () => {
  const result = evaluateTermMatch(SSDI, call({ descriptors: ['Plumbing - CA'], summary: 'Call x (COMPLETED): Plumbing - CA' }));
  // null, not a determination with a falsy field. There is no negative form of a
  // relevance determination, and Stage 2 stores no negative-evaluation history.
  assert.equal(result, null);
});

// --- Provenance and reproducibility -------------------------------------------

test('a determination names the evaluator and the build that made it', () => {
  const result = evaluateTermMatch(ROOFING, call());
  assert.ok(result);
  assert.equal(result.evaluatorId, TERM_MATCH_EVALUATOR_ID);
  assert.equal(result.evaluatorVersion, TERM_MATCH_EVALUATOR_VERSION);
});

test('the rationale names the terms that caused it, in a stable order', () => {
  const a = evaluateTermMatch(ROOFING, call());
  const b = evaluateTermMatch(ROOFING, call());
  assert.ok(a && b);
  // Deterministic: two identical evaluations must not differ, or a re-run would
  // read as a change that did not happen.
  assert.equal(a.rationale, b.rationale);
  assert.equal(a.rationale, 'Objective and observation share the terms: roofing.');
});

test('TERM_MATCH cannot see that Texas and TX are the same place', () => {
  // NOT A DEFECT. An assertion of the documented limit, kept so nobody
  // "fixes" it by quietly adding synonyms, stemming or an ontology, none of
  // which are approved. The objective says "Texas"; the call is labelled "TX";
  // relevance here is established by 'roofing' alone, and the geography
  // contributes nothing.
  const result = evaluateTermMatch(ROOFING, call());
  assert.ok(result);
  assert.ok(!result.rationale.includes('tx'));
  assert.ok(!result.rationale.includes('texas'));

  // And with the subject removed there is nothing left to match on, so a call
  // that IS in Texas produces no signal for a Texas objective.
  const geographyOnly = evaluateTermMatch(
    { title: 'Grow revenue in Texas', description: null },
    call({ descriptors: ['Plumbing - TX'], summary: 'Call c2 (COMPLETED): Plumbing - TX' }),
  );
  assert.equal(geographyOnly, null);
});

test('the rationale is CI speaking, and never restates the observation as fact', () => {
  const result = evaluateTermMatch(ROOFING, call());
  assert.ok(result);
  // The determination carries no copy of the source's summary. Fact and
  // inference are different statements and the contract keeps them apart.
  assert.ok(!result.rationale.includes('COMPLETED'));
  assert.ok(!('summary' in result));
  assert.ok(!('observedAt' in result));
});

// --- Scoring is absent, deliberately ------------------------------------------

test('a determination carries no score, confidence or weight', () => {
  const result = evaluateTermMatch(ROOFING, call());
  assert.ok(result);
  assert.deepEqual(
    Object.keys(result).sort(),
    ['basis', 'evaluatorId', 'evaluatorVersion', 'rationale'],
    'a new field here is a product decision, not a refactor',
  );
});

test('more matched terms does not produce a stronger determination', () => {
  const one = evaluateTermMatch(ROOFING, call({ descriptors: ['Roofing'] }));
  const many = evaluateTermMatch(ROOFING, call({ descriptors: ['Roofing - TX', 'Texas roofing leads'] }));
  assert.ok(one && many);
  // Both are simply "may be relevant". Loop has no approved model that could
  // rank one above the other, so nothing here pretends it does.
  assert.equal(one.basis, many.basis);
});

// --- Term normalization -------------------------------------------------------

test('intent verbs are dropped so every objective does not match every observation', () => {
  const terms = commercialTerms('Grow roofing lead revenue in Texas');
  assert.ok(!terms.has('grow'), 'intent verbs would otherwise match on the verb alone');
  assert.ok(!terms.has('in'));
  assert.ok(terms.has('roofing'));
  assert.ok(terms.has('revenue'));
  assert.ok(terms.has('texas'));
});

test('two-character terms survive but single characters do not', () => {
  const terms = commercialTerms('TX a b2b');
  assert.ok(terms.has('tx'));
  assert.ok(terms.has('b2b'));
  assert.ok(!terms.has('a'));
});

test('an objective whose title carries no subject matter matches nothing', () => {
  // "Grow more" is entirely intent verbs. It must produce no terms and therefore
  // no determination, rather than matching every observation in the tenant.
  const result = evaluateTermMatch({ title: 'Grow more', description: null }, call());
  assert.equal(result, null);
});

test('the description is read as well as the title', () => {
  const result = evaluateTermMatch(
    { title: 'Expand partnerships', description: 'Focus on HomeAdvisor as a channel.' },
    call(),
  );
  assert.ok(result, 'subject matter in the description must count');
  assert.match(result.rationale, /homeadvisor/);
});

test('matching is case-insensitive and ignores punctuation', () => {
  const result = evaluateTermMatch(
    { title: 'ROOFING/TX pipeline', description: null },
    call(),
  );
  assert.ok(result);
});

// --- The contract itself ------------------------------------------------------

test('the relevance vocabulary is closed and Stage 2 defines exactly one member', () => {
  assert.deepEqual([...COMMERCIAL_SIGNAL_RELEVANCE_BASES], ['TERM_MATCH']);
  assert.ok(isCommercialSignalRelevanceBasis('TERM_MATCH'));
  assert.ok(!isCommercialSignalRelevanceBasis('HEADLINE'));
  assert.ok(!isCommercialSignalRelevanceBasis('term_match'));
});

test('the contract is versioned', () => {
  assert.equal(COMMERCIAL_SIGNAL_CONTRACT_VERSION, 'commercial-signal.v1');
});

test('the evaluator is pure — it neither reads nor mutates its inputs', () => {
  const observation = call();
  const before = JSON.stringify(observation);
  const objective = { ...ROOFING };
  const objectiveBefore = JSON.stringify(objective);

  evaluateTermMatch(objective, observation);

  assert.equal(JSON.stringify(observation), before);
  assert.equal(JSON.stringify(objective), objectiveBefore);
});
