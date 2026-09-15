// Identity evidence use policy, pure. Identity Slice 2.0 and PD-I2-01.
//
// No evidence is produced for a class whose policy is absent, UNSET, inactive,
// out of effect, malformed or not activated by a human OWNER or ADMIN under
// identityResolution:approve. Each refusal is proven against a policy that is
// otherwise allowed, so no test passes for the wrong reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVIDENCE_POLICY_UNSET,
  EVIDENCE_POLICY_REFUSALS,
  EVIDENCE_LEGAL_BASES,
  evidencePolicyDecision,
  mayProduceEvidence,
  type IdentityEvidenceUsePolicy,
  type EvidenceProductionFacts,
  type EvidencePolicyRefusal,
} from '../src/evidence-use-policy';
import * as policyModule from '../src/evidence-use-policy';
import { IDENTITY_EVIDENCE_CLASS_RULES } from '../src/identity-evidence';

const CALLER_ID = { kind: 'PHONE', mode: 'NETWORK_ASSERTED' } as const;

const POLICY: IdentityEvidenceUsePolicy = {
  evidenceClass: CALLER_ID,
  status: 'ACTIVE',
  version: 3,
  retention: { days: 90 },
  legalBasis: { basis: 'LEGITIMATE_INTEREST', reference: 'Records of processing, section 4' },
  requiresConsent: false,
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
  activation: { actorType: 'HUMAN', userId: 'user_owner', role: 'OWNER', authorizedAction: 'approve', at: '2026-09-30T12:00:00.000Z' },
};

const FACT: EvidenceProductionFacts = { evidenceClass: CALLER_ID, at: '2026-10-02T15:00:00.000Z', consentCaptured: false };

function refusal(policy: IdentityEvidenceUsePolicy | null | undefined, facts: EvidenceProductionFacts = FACT): EvidencePolicyRefusal | null {
  const d = evidencePolicyDecision(policy, facts);
  assert.equal(mayProduceEvidence(policy, facts), d.allowed);
  return d.allowed ? null : d.refusal;
}

function withPolicy(patch: Record<string, unknown>): IdentityEvidenceUsePolicy {
  return { ...POLICY, ...patch } as IdentityEvidenceUsePolicy;
}

test('baseline: a complete, active, human-activated policy in effect allows production and names its version', () => {
  assert.deepEqual(evidencePolicyDecision(POLICY, FACT), { allowed: true, policyVersion: 3 });
});

test('absent policy fails closed', () => {
  assert.equal(refusal(null), 'ABSENT');
  assert.equal(refusal(undefined), 'ABSENT');
});

test('UNSET retention or legal basis fails closed; a policy as first drafted produces nothing', () => {
  assert.equal(refusal(withPolicy({ retention: EVIDENCE_POLICY_UNSET })), 'RETENTION_UNSET');
  assert.equal(refusal(withPolicy({ legalBasis: EVIDENCE_POLICY_UNSET })), 'LEGAL_BASIS_UNSET');
  const drafted = withPolicy({ status: 'DRAFT', retention: 'UNSET', legalBasis: 'UNSET', activation: null });
  assert.equal(mayProduceEvidence(drafted, FACT), false);
});

test('inactive policy fails closed', () => {
  assert.equal(refusal(withPolicy({ status: 'DRAFT' })), 'NOT_ACTIVE');
  assert.equal(refusal(withPolicy({ status: 'INACTIVE' })), 'NOT_ACTIVE');
});

test('PD-I2-01: only a human OWNER or ADMIN holding approve activates; machine and AI never do', () => {
  const activation = POLICY.activation!;
  assert.equal(refusal(withPolicy({ activation: { ...activation, role: 'ADMIN' } })), null);
  const refused: Record<string, unknown>[] = [
    { actorType: 'MACHINE' },
    { actorType: 'AI' },
    { role: 'MANAGER' },
    { role: 'EMPLOYEE' },
    { role: 'AI_EMPLOYEE' },
    { role: 'owner' },
    { authorizedAction: 'update' },
    { authorizedAction: 'manage' },
    { userId: '' },
    { userId: '   ' },
    { at: 'yesterday' },
  ];
  for (const patch of refused) {
    assert.equal(refusal(withPolicy({ activation: { ...activation, ...patch } })), 'NOT_ACTIVATED_BY_AUTHORIZED_HUMAN', JSON.stringify(patch));
  }
  assert.equal(refusal(withPolicy({ activation: null })), 'NOT_ACTIVATED_BY_AUTHORIZED_HUMAN');
});

test('a malformed policy fails closed', () => {
  const invalid: Record<string, unknown>[] = [
    { version: 0 },
    { version: 1.5 },
    { version: Number.NaN },
    { retention: { days: 0 } },
    { retention: { days: -30 } },
    { retention: { days: 7.5 } },
    { retention: null },
    { legalBasis: { basis: 'NONE', reference: 'x' } },
    { legalBasis: { basis: 'CONSENT', reference: '  ' } },
    { legalBasis: null },
    { requiresConsent: 'yes' },
    { status: 'LIVE' },
    { effectiveFrom: 'not an instant' },
    { effectiveTo: '2026-10-01T00:00:00.000Z' },
    { effectiveTo: '2026-09-01T00:00:00.000Z' },
  ];
  for (const patch of invalid) {
    assert.equal(refusal(withPolicy(patch)), 'INVALID', JSON.stringify(patch));
  }
  assert.equal(refusal(POLICY, { ...FACT, at: '' }), 'INVALID');
});

test('the policy must be for this exact class, an approved one, with producing authority', () => {
  assert.equal(refusal(POLICY, { ...FACT, evidenceClass: { kind: 'PHONE', mode: 'SUBJECT_PROVIDED' } }), 'CLASS_MISMATCH');
  assert.equal(refusal(withPolicy({ evidenceClass: { kind: 'EMAIL', mode: 'SUBJECT_PROVIDED' } })), 'CLASS_MISMATCH');
  assert.equal(refusal(withPolicy({ evidenceClass: null })), 'CLASS_MISMATCH');
  const unapproved = { kind: 'PHONE', mode: 'OPERATOR_RECORDED' } as const;
  assert.equal(refusal(withPolicy({ evidenceClass: unapproved }), { ...FACT, evidenceClass: unapproved }), 'CLASS_NOT_APPROVED');
  for (const r of IDENTITY_EVIDENCE_CLASS_RULES.filter((x) => !x.available)) {
    const c = { kind: r.kind, mode: r.mode };
    assert.equal(refusal(withPolicy({ evidenceClass: c }), { ...FACT, evidenceClass: c }), 'CLASS_UNAVAILABLE', `${r.kind}/${r.mode}`);
  }
  for (const r of IDENTITY_EVIDENCE_CLASS_RULES.filter((x) => x.available)) {
    const c = { kind: r.kind, mode: r.mode };
    assert.equal(refusal(withPolicy({ evidenceClass: c }), { ...FACT, evidenceClass: c }), null, `${r.kind}/${r.mode}`);
  }
});

test('production only inside the effective window', () => {
  assert.equal(refusal(POLICY, { ...FACT, at: '2026-09-30T23:59:59.999Z' }), 'NOT_IN_EFFECT');
  assert.equal(refusal(POLICY, { ...FACT, at: '2026-10-01T00:00:00.000Z' }), null);
  const bounded = withPolicy({ effectiveTo: '2026-11-01T00:00:00.000Z' });
  assert.equal(refusal(bounded, { ...FACT, at: '2026-10-31T23:59:59.999Z' }), null);
  assert.equal(refusal(bounded, { ...FACT, at: '2026-11-01T00:00:00.000Z' }), 'NOT_IN_EFFECT');
});

test('a policy that requires consent needs the fact to have captured it', () => {
  const consenting = withPolicy({ requiresConsent: true });
  assert.equal(refusal(consenting), 'CONSENT_NOT_CAPTURED');
  assert.equal(refusal(consenting, { ...FACT, consentCaptured: true }), null);
});

test('nothing defaults a legal basis or ships a ready-made policy', () => {
  assert.ok(!(EVIDENCE_LEGAL_BASES as readonly string[]).includes('NONE'));
  assert.deepEqual([...EVIDENCE_POLICY_REFUSALS].sort(), [
    'ABSENT', 'CLASS_MISMATCH', 'CLASS_NOT_APPROVED', 'CLASS_UNAVAILABLE', 'CONSENT_NOT_CAPTURED', 'INVALID',
    'LEGAL_BASIS_UNSET', 'NOT_ACTIVATED_BY_AUTHORIZED_HUMAN', 'NOT_ACTIVE', 'NOT_IN_EFFECT', 'RETENTION_UNSET',
  ]);
  for (const [name, value] of Object.entries(policyModule)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      assert.equal(mayProduceEvidence(value as IdentityEvidenceUsePolicy, FACT), false, `${name} must not be a usable policy`);
    }
  }
});
