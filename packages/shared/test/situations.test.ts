// Loop Intelligence Phase F: situation contracts (synthesis, independent verification) and the
// deterministic clusterer. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_TASKS,
  CASE_ORGANIZATION_WHERE,
  PRIVATE_SITUATION_SOURCE,
  SITUATION_SYNTHESIS_SCHEMA_ID,
  SITUATION_VERIFICATION_SCHEMA_ID,
  aiOutputContract,
  aiPortableSchemaViolations,
  clusterSituationSignals,
  situationVisibility,
  SITUATION_SYNTHESIS_SCHEMA,
  SITUATION_VERIFICATION_SCHEMA,
  type IntelligenceSignal,
  type SituationEvidence,
  type SituationSignalInput,
} from '../src';

const DAY = 86_400_000;
const T0 = Date.parse('2026-09-20T12:00:00Z');
const synthTask = AI_TASKS.find((t) => t.taskId === 'situation.synthesis')!;
const verifyTask = AI_TASKS.find((t) => t.taskId === 'situation.verify')!;
const synth = aiOutputContract(SITUATION_SYNTHESIS_SCHEMA_ID)!;
const verify = aiOutputContract(SITUATION_VERIFICATION_SCHEMA_ID)!;

const REFS = new Set(['digest:a/calls-change', 'digest:b/campaign.x']);
const EVIDENCE: SituationEvidence = {
  figures: new Map([['digest:a/calls-change', new Set([40, 100, 60])], ['digest:b/campaign.x', new Set([12])]]),
  dates: new Set(['2026-09-20']),
  entityRefs: new Set(['provider_member:callgrid:campaign:x']),
  signalTimes: new Map([['digest:a/calls-change', T0], ['digest:b/campaign.x', T0 + DAY]]),
  clusterRefs: new Set(['provider_member:callgrid:campaign:x']),
  situations: new Map([['case_open', new Set(['provider_member:callgrid:campaign:x'])]]),
};

const answer = (patch: Record<string, unknown> = {}) => ({
  schemaId: SITUATION_SYNTHESIS_SCHEMA_ID,
  decision: 'UPDATE',
  situationId: 'case_open',
  title: 'Calls and a campaign moved together',
  narrative: 'Calls fell 40% in the same week one campaign carried 12 calls nobody bought.',
  claims: [
    { kind: 'OBSERVATION', statement: 'Calls fell 40% on the week before.', citations: ['digest:a/calls-change'] },
    { kind: 'CONNECTION', statement: 'The same campaign appears in both readings at the same time.', citations: ['digest:a/calls-change', 'digest:b/campaign.x'] },
  ],
  limitations: [],
  ...patch,
});

function rejections(value: unknown, evidence: SituationEvidence = EVIDENCE) {
  const parsed = synth.parse(value);
  if (!parsed) return ['UNPARSED'];
  return synth.validate(parsed, synthTask, REFS, evidence);
}

test('the synthesis, verification and briefing schemas are portable and registered', () => {
  assert.deepEqual(aiPortableSchemaViolations(SITUATION_SYNTHESIS_SCHEMA), []);
  assert.deepEqual(aiPortableSchemaViolations(SITUATION_VERIFICATION_SCHEMA), []);
  for (const id of ['situation-synthesis.v1', 'situation-verification.v1', 'loop-briefing.v1']) assert.ok(aiOutputContract(id), id);
  // The verification route is independent by construction: its task says what it checks, nothing more.
  assert.equal(verifyTask.outputSchemaId, SITUATION_VERIFICATION_SCHEMA_ID);
  assert.equal(verifyTask.consequence, 'READ_ONLY');
});

test('synthesis: a grounded UPDATE of a SUPPLIED situation passes', () => {
  assert.deepEqual(rejections(answer()), []);
});

test('synthesis refuses: an unsupplied situation id, an uncited claim, a citation not supplied, and a number the citations do not hold', () => {
  assert.ok(rejections(answer({ situationId: 'case_elsewhere' })).includes('CITATION_NOT_SUPPLIED'));
  assert.ok(rejections(answer({ claims: [{ kind: 'OBSERVATION', statement: 'Calls fell.', citations: [] }] })).includes('UNCITED_CLAIM'));
  assert.ok(rejections(answer({ claims: [{ kind: 'OBSERVATION', statement: 'Calls fell.', citations: ['digest:z/other'] }] })).includes('CITATION_NOT_SUPPLIED'));
  assert.ok(rejections(answer({ claims: [{ kind: 'OBSERVATION', statement: 'Calls fell 55%.', citations: ['digest:a/calls-change'] }] })).includes('UNSUPPORTED_NUMBER_IN_TEXT'));
  // A number held only by ANOTHER source is not support for this claim.
  assert.ok(rejections(answer({ claims: [{ kind: 'OBSERVATION', statement: 'The campaign carried 12 calls.', citations: ['digest:a/calls-change'] }] })).includes('UNSUPPORTED_NUMBER_IN_TEXT'));
});

test('synthesis refuses causal overreach -- co-occurrence is shown, cause never is', () => {
  for (const statement of ['Calls fell because the campaign stopped.', 'The drop was due to the campaign.', 'The campaign led to fewer calls.', 'Revenue is down, driven by one buyer.']) {
    assert.ok(rejections(answer({ claims: [{ kind: 'IMPLICATION', statement, citations: ['digest:a/calls-change'] }] })).includes('CAUSAL_OVERREACH'), statement);
  }
  assert.ok(rejections(answer({ narrative: 'Calls fell as a result of the campaign.' })).includes('CAUSAL_OVERREACH'));
});

test('synthesis refuses joining evidence from windows too far apart, a NEW that duplicates an open situation, and prose that instructs', () => {
  const far: SituationEvidence = { ...EVIDENCE, signalTimes: new Map([['digest:a/calls-change', T0], ['digest:b/campaign.x', T0 + 30 * DAY]]) };
  assert.ok(rejections(answer(), far).includes('TEMPORAL_MISMATCH'));
  assert.ok(rejections(answer({ decision: 'NEW', situationId: null })).includes('DUPLICATE_SITUATION'));
  assert.deepEqual(rejections(answer({ decision: 'NEW', situationId: null }), { ...EVIDENCE, situations: new Map() }), []);
  assert.ok(rejections(answer({ narrative: 'You should call the buyer today.' })).length > 0);
  assert.ok(rejections(answer({ decision: 'NONE', situationId: null })).includes('WRONG_SCHEMA'), 'NONE carries no claims');
  assert.deepEqual(rejections(answer({ decision: 'NONE', situationId: null, claims: [], title: null, narrative: null })), []);
});

test('verification: one verdict per supplied claim index, nothing else', () => {
  const check = (verdicts: unknown[], claimCount = 2) => {
    const parsed = verify.parse({ schemaId: SITUATION_VERIFICATION_SCHEMA_ID, verdicts, limitations: [] });
    return parsed ? verify.validate(parsed, verifyTask, REFS, { ...EVIDENCE, claimCount } as SituationEvidence) : ['UNPARSED'];
  };
  assert.deepEqual(check([{ claimIndex: 0, verdict: 'SUPPORTED' }, { claimIndex: 1, verdict: 'UNCLEAR' }]), []);
  assert.ok(check([{ claimIndex: 2, verdict: 'SUPPORTED' }]).includes('WRONG_SCHEMA'), 'no such claim');
  assert.ok(check([{ claimIndex: 0, verdict: 'SUPPORTED' }, { claimIndex: 0, verdict: 'UNCLEAR' }]).includes('WRONG_SCHEMA'), 'one verdict each');
  assert.ok(check([{ claimIndex: 0, verdict: 'TRUE' }]).includes('WRONG_SCHEMA'));
});

// --- clustering -----------------------------------------------------------------------------------

const sig = (key: string, entities: string[], patch: Partial<IntelligenceSignal> = {}): IntelligenceSignal => ({ key, kind: 'RISK', knowledge: 'OBSERVED', statement: `${key} moved.`, entities, evidenceRefs: ['x'], severity: 'MEDIUM', ...patch });
const input = (domain: string, key: string, entities: string[], at = T0, patch: Partial<IntelligenceSignal> = {}): SituationSignalInput => ({ ref: `digest:${domain}/${key}`, domain, signal: sig(key, entities, patch), at });

test('clustering: the same record in two domains inside the window is one candidate; outside it, or in one domain, is none', () => {
  const c = clusterSituationSignals([input('CALLGRID', 'a', ['campaign:c1']), input('CAMPAIGNS', 'b', ['campaign:c1'], T0 + 3 * DAY)], []);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0]!.domains, ['CALLGRID', 'CAMPAIGNS']);
  assert.equal(c[0]!.clusterBasis, 'campaign:c1');
  assert.equal(clusterSituationSignals([input('CALLGRID', 'a', ['campaign:c1']), input('CAMPAIGNS', 'b', ['campaign:c1'], T0 + 20 * DAY)], []).length, 0, 'outside the window');
  assert.equal(clusterSituationSignals([input('CALLGRID', 'a', ['campaign:c1']), input('CALLGRID', 'b', ['campaign:c1'])], []).length, 0, 'one domain');
});

test('clustering never connects on time alone: signals naming no record join nothing; plain measurements start nothing', () => {
  assert.equal(clusterSituationSignals([input('CALLGRID', 'a', []), input('PIPELINE', 'b', [])], []).length, 0);
  assert.equal(clusterSituationSignals([input('CALLGRID', 'a', ['campaign:c1'], T0, { kind: 'OPERATIONAL', knowledge: 'MEASURED' }), input('CAMPAIGNS', 'b', ['campaign:c1'])], []).length, 0);
});

test('clustering: an explicit entity link joins two different records; identity is stable and the fingerprint moves with the evidence', () => {
  const inputs = [input('CALLGRID', 'a', ['provider_member:callgrid:campaign:x']), input('WEBSITE', 'b', ['web_property:site'])];
  assert.equal(clusterSituationSignals(inputs, []).length, 0);
  const linked = clusterSituationSignals(inputs, [['provider_member:callgrid:campaign:x', 'web_property:site']]);
  assert.equal(linked.length, 1);
  const reversed = clusterSituationSignals([...inputs].reverse(), [['provider_member:callgrid:campaign:x', 'web_property:site']]);
  assert.equal(reversed[0]!.clusterBasis, linked[0]!.clusterBasis);
  assert.equal(reversed[0]!.fingerprintBasis, linked[0]!.fingerprintBasis);
  const changed = clusterSituationSignals([input('CALLGRID', 'a', ['provider_member:callgrid:campaign:x'], T0, { statement: 'a moved further.' }), inputs[1]!], [['provider_member:callgrid:campaign:x', 'web_property:site']]);
  assert.equal(changed[0]!.clusterBasis, linked[0]!.clusterBasis, 'same cluster');
  assert.notEqual(changed[0]!.fingerprintBasis, linked[0]!.fingerprintBasis, 'new evidence, new fingerprint');
});

test('visibility is the most restrictive evidence; the organization Case filter excludes private situations by value', () => {
  assert.equal(situationVisibility(['ORGANIZATION', 'PRINCIPAL']), 'PRINCIPAL');
  assert.equal(situationVisibility(['ORGANIZATION']), 'ORGANIZATION');
  assert.deepEqual(CASE_ORGANIZATION_WHERE, { NOT: { sourceSystem: PRIVATE_SITUATION_SOURCE } });
});
