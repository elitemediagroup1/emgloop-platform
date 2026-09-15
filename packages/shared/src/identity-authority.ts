// Identity authority -- which act needs which grant, and who may never perform it.
//
// Identity Slice 2.0, a pure contract. The decision record is
// docs/architecture/identity-evidence-resolution.md (section 6 and PD-I2-01 to
// PD-I2-03). The grants themselves are the existing `IDENTITY_RESOLUTION_GRANTS`
// in `iam.repository.ts`; this file maps every identity act onto one of their
// actions and does not grant anything. A database test holds the two in agreement.
//
// THREE ACTIONS, THREE WEIGHTS.
//   create   record what someone observed, or propose; creates an UNESTABLISHED
//            Party at most.
//   update   decide a proposal: confirm, reject or reverse an attribution; set,
//            dismiss or revoke a flag. NEVER an establishment basis (PD-I2-03).
//   approve  the consequential boundary: establish a Party, link Intake to a
//            Party, confirm same-Party and supersede, activate a policy.
//
// PROPOSAL AND CONFIRMATION STAY SEPARATE. A MANAGER may not confirm their own
// attribution proposal (PD-I2-03). OWNER and ADMIN stay under the approved
// authority model. Any other role holding `update` through a Permission row fails
// closed, as MANAGER does.
//
// NO AI, AND NO MACHINE THAT DECIDES. AI_EMPLOYEE writes no identity state of any
// kind. A machine performs exactly two acts: proposing an identifier flag, and
// extracting evidence from new facts under an ACTIVE class policy. Neither
// attributes, confirms, links or establishes. Read-time hints are not acts and
// appear nowhere here.
//
// PURE. No clock, no I/O.

export const IDENTITY_RESOLUTION_ACTIONS = ['view', 'create', 'update', 'approve'] as const;
export type IdentityResolutionAction = (typeof IDENTITY_RESOLUTION_ACTIONS)[number];

export const IDENTITY_ACTOR_TYPES = ['HUMAN', 'MACHINE', 'AI'] as const;
export type IdentityActorType = (typeof IDENTITY_ACTOR_TYPES)[number];

export const IDENTITY_ACTS = [
  'VIEW_IDENTITY_STATE',
  'RECORD_OPERATOR_IDENTIFICATION',
  'PROPOSE_ATTRIBUTION',
  'PROPOSE_CONTINUITY_ATTRIBUTION',
  'CREATE_UNESTABLISHED_PARTY',
  'CONFIRM_ATTRIBUTION',
  'REJECT_ATTRIBUTION',
  'REVERSE_ATTRIBUTION',
  'PROPOSE_IDENTIFIER_FLAG',
  'SET_IDENTIFIER_FLAG',
  'DISMISS_IDENTIFIER_FLAG',
  'REVOKE_IDENTIFIER_FLAG',
  'ESTABLISH_PARTY',
  'LINK_INTAKE_TO_PARTY',
  'REVERSE_INTAKE_LINK',
  'CONFIRM_SAME_PARTY',
  'ACTIVATE_EVIDENCE_USE_POLICY',
  'ACTIVATE_MACHINE_POLICY',
  'EXTRACT_EVIDENCE',
] as const;
export type IdentityAct = (typeof IDENTITY_ACTS)[number];

export interface IdentityActRule {
  readonly act: IdentityAct;
  /**
   * The `identityResolution` action a human actor must hold. Null only for the
   * two machine acts, which no grant can authorize a person or AI to perform.
   */
  readonly requiredAction: IdentityResolutionAction | null;
  readonly actorTypes: readonly IdentityActorType[];
  /** A written reason is required, and kept. */
  readonly reasonRequired: boolean;
  /** The act makes a Party canonical identity or treats two as one. */
  readonly establishesIdentity: boolean;
  /** The act decides a proposal someone made; self-decision rules apply. */
  readonly decidesProposal: boolean;
  /** Earlier history survives the act (reversal, dismissal, revocation, supersession). */
  readonly preservesHistory: boolean;
}

const HUMAN: readonly IdentityActorType[] = ['HUMAN'];
const MACHINE: readonly IdentityActorType[] = ['MACHINE'];

function rule(
  act: IdentityAct,
  requiredAction: IdentityResolutionAction | null,
  actorTypes: readonly IdentityActorType[],
  flags: Partial<Pick<IdentityActRule, 'reasonRequired' | 'establishesIdentity' | 'decidesProposal' | 'preservesHistory'>> = {},
): IdentityActRule {
  return Object.freeze({
    act,
    requiredAction,
    actorTypes: Object.freeze([...actorTypes]),
    reasonRequired: flags.reasonRequired ?? false,
    establishesIdentity: flags.establishesIdentity ?? false,
    decidesProposal: flags.decidesProposal ?? false,
    preservesHistory: flags.preservesHistory ?? false,
  });
}

export const IDENTITY_ACT_RULES: Readonly<Record<IdentityAct, IdentityActRule>> = Object.freeze({
  // Identity state, evidence summaries (never raw values) and suggestions.
  VIEW_IDENTITY_STATE: rule('VIEW_IDENTITY_STATE', 'view', HUMAN),

  RECORD_OPERATOR_IDENTIFICATION: rule('RECORD_OPERATOR_IDENTIFICATION', 'create', HUMAN),
  PROPOSE_ATTRIBUTION: rule('PROPOSE_ATTRIBUTION', 'create', HUMAN),
  PROPOSE_CONTINUITY_ATTRIBUTION: rule('PROPOSE_CONTINUITY_ATTRIBUTION', 'create', HUMAN),
  // `PartyService.create`: a Party record, never an established one.
  CREATE_UNESTABLISHED_PARTY: rule('CREATE_UNESTABLISHED_PARTY', 'create', HUMAN),

  CONFIRM_ATTRIBUTION: rule('CONFIRM_ATTRIBUTION', 'update', HUMAN, { decidesProposal: true }),
  REJECT_ATTRIBUTION: rule('REJECT_ATTRIBUTION', 'update', HUMAN, { decidesProposal: true, reasonRequired: true }),
  // PD-I2-02: the confirmation is kept; the reversal is recorded beside it.
  REVERSE_ATTRIBUTION: rule('REVERSE_ATTRIBUTION', 'update', HUMAN, { reasonRequired: true, preservesHistory: true }),

  PROPOSE_IDENTIFIER_FLAG: rule('PROPOSE_IDENTIFIER_FLAG', null, MACHINE),
  SET_IDENTIFIER_FLAG: rule('SET_IDENTIFIER_FLAG', 'update', HUMAN),
  DISMISS_IDENTIFIER_FLAG: rule('DISMISS_IDENTIFIER_FLAG', 'update', HUMAN, { decidesProposal: true, reasonRequired: true, preservesHistory: true }),
  REVOKE_IDENTIFIER_FLAG: rule('REVOKE_IDENTIFIER_FLAG', 'update', HUMAN, { reasonRequired: true, preservesHistory: true }),

  // `PartyService.establish`.
  ESTABLISH_PARTY: rule('ESTABLISH_PARTY', 'approve', HUMAN, { establishesIdentity: true }),
  // `CustomerPartyLinkService`: an Intake record refers to an established Party.
  LINK_INTAKE_TO_PARTY: rule('LINK_INTAKE_TO_PARTY', 'approve', HUMAN),
  REVERSE_INTAKE_LINK: rule('REVERSE_INTAKE_LINK', 'approve', HUMAN, { reasonRequired: true, preservesHistory: true }),
  // P1 is P2: the superseded Party resolves forward; nothing pointing at it is rewritten.
  CONFIRM_SAME_PARTY: rule('CONFIRM_SAME_PARTY', 'approve', HUMAN, { establishesIdentity: true, reasonRequired: true, preservesHistory: true }),

  // PD-I2-01.
  ACTIVATE_EVIDENCE_USE_POLICY: rule('ACTIVATE_EVIDENCE_USE_POLICY', 'approve', HUMAN),
  // Machine attribution is deferred; the act exists so its authority is already fixed.
  ACTIVATE_MACHINE_POLICY: rule('ACTIVATE_MACHINE_POLICY', 'approve', HUMAN),

  // A system projection over new facts, gated by an ACTIVE class use policy.
  EXTRACT_EVIDENCE: rule('EXTRACT_EVIDENCE', null, MACHINE),
});

export function identityActRule(act: IdentityAct): IdentityActRule {
  return IDENTITY_ACT_RULES[act];
}

/** Whether an actor of this type may ever perform the act. AI never may. Unknown acts fail closed. */
export function identityActorTypePermitted(act: string, actorType: string): boolean {
  if (actorType === 'AI') return false;
  const r = (IDENTITY_ACT_RULES as Readonly<Record<string, IdentityActRule>>)[act];
  return r !== undefined && (r.actorTypes as readonly string[]).includes(actorType);
}

/**
 * The only action that may establish identity, link Intake to a Party or confirm
 * same-Party. `update` never is, whatever it confirms.
 */
export const IDENTITY_ESTABLISHING_ACTION: IdentityResolutionAction = 'approve';

/** Roles whose approved authority lets them confirm an attribution they proposed. */
const SELF_CONFIRMING_ROLES: readonly string[] = ['OWNER', 'ADMIN'];

export interface ProposalDecisionFacts {
  readonly act: IdentityAct;
  readonly deciderUserId: string;
  readonly deciderRole: string;
  readonly proposerUserId: string | null;
}

/**
 * Whether this person may decide this proposal, as far as separation of proposal
 * and decision goes. Grants are checked separately. A machine-made proposal
 * (null proposer) has no self to separate from.
 */
export function mayDecideProposal(facts: ProposalDecisionFacts): boolean {
  const r = IDENTITY_ACT_RULES[facts.act];
  if (!r || !r.decidesProposal) return false;
  if (typeof facts.deciderUserId !== 'string' || facts.deciderUserId.trim().length === 0) return false;
  const own = facts.proposerUserId !== null && facts.proposerUserId === facts.deciderUserId;
  if (!own) return true;
  // PD-I2-03 covers confirmation. Rejecting or dismissing your own proposal withdraws it.
  if (facts.act !== 'CONFIRM_ATTRIBUTION') return true;
  return SELF_CONFIRMING_ROLES.includes(facts.deciderRole);
}
