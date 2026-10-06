// CRM Opportunity authority -- who may do what to an Opportunity (PD-F-11, approved 2026-10-06).
//
// The decision is recorded in docs/architecture/commercial-opportunity-campaign.md §6 and
// docs/product/foundation-handoff.md §8, approved AS WRITTEN:
//   - view: all human workspace roles;
//   - create/update (stage, forecast, close; and the Opportunity's details): EMPLOYEE+;
//   - reopen a closed Opportunity: MANAGER+;
//   - void: OWNER/ADMIN;
//   - AI_EMPLOYEE hard-denied writes and view.
// PD-F-11 says the grants "mirror PD-F-04". For acts PD-F-11 does not name, this table takes
// PD-F-04's counterparts verbatim (`CRM_RELATIONSHIP_ACT_ROLES`); that is a reading, not a new
// decision:
//   - CHANGE_OWNER and ADD_PARTICIPANT: EMPLOYEE+;
//   - END_PARTICIPANT: MANAGER+;
//   - VOID_PARTICIPANT: OWNER/ADMIN.
//
// OWNERSHIP IS ACCOUNTABILITY, NOT ACCESS. `CrmOpportunity.ownerUserId` names who is accountable.
// It grants nothing, restricts nothing and hides nothing: every role in VIEW sees an owned
// Opportunity, and every role holding an act may perform it whoever the owner is.
// `createdByUserId` stays creation provenance, a different fact.
//
// PURE. No clock, no I/O.

export const CRM_OPPORTUNITY_ACTS = [
  'VIEW',
  'CREATE',
  /** Stage, forecast and close, the Opportunity's details, and its creator-facing designation. */
  'UPDATE',
  'CHANGE_OWNER',
  'ADD_PARTICIPANT',
  'END_PARTICIPANT',
  'VOID_PARTICIPANT',
  'REOPEN',
  'VOID',
] as const;
export type CrmOpportunityAct = (typeof CRM_OPPORTUNITY_ACTS)[number];

const HUMAN_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'] as const;
const EMPLOYEE_AND_ABOVE = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'] as const;
const MANAGER_AND_ABOVE = ['OWNER', 'ADMIN', 'MANAGER'] as const;
const OWNER_ADMIN = ['OWNER', 'ADMIN'] as const;

/** The approved grants. AI_EMPLOYEE and CREATOR appear nowhere. */
export const CRM_OPPORTUNITY_ACT_ROLES: Readonly<Record<CrmOpportunityAct, readonly string[]>> = Object.freeze({
  VIEW: HUMAN_ROLES,
  CREATE: EMPLOYEE_AND_ABOVE,
  UPDATE: EMPLOYEE_AND_ABOVE,
  CHANGE_OWNER: EMPLOYEE_AND_ABOVE,
  ADD_PARTICIPANT: EMPLOYEE_AND_ABOVE,
  END_PARTICIPANT: MANAGER_AND_ABOVE,
  VOID_PARTICIPANT: OWNER_ADMIN,
  REOPEN: MANAGER_AND_ABOVE,
  VOID: OWNER_ADMIN,
});

/** Denied before the table is consulted, whatever a future edit of the table says. */
export const CRM_OPPORTUNITY_FORBIDDEN_ROLES: readonly string[] = Object.freeze(['AI_EMPLOYEE']);

/** Fails closed three ways: a person, a role that is not forbidden, a role the act grants. */
export function crmOpportunityActPermitted(request: { readonly act: string; readonly role: string; readonly actorType: string }): boolean {
  if (request.actorType !== 'HUMAN') return false;
  if (CRM_OPPORTUNITY_FORBIDDEN_ROLES.includes(request.role)) return false;
  const roles = (CRM_OPPORTUNITY_ACT_ROLES as Readonly<Record<string, readonly string[]>>)[request.act];
  return Array.isArray(roles) && roles.includes(request.role);
}

/**
 * Who may be named the accountable owner: a member who may actually work the Opportunity
 * (holds UPDATE). A READ_ONLY seat, an AI employee or a creator login cannot be accountable for
 * a pursuit they cannot act on.
 */
export function crmOpportunityOwnerEligible(role: string): boolean {
  return crmOpportunityActPermitted({ act: 'UPDATE', role, actorType: 'HUMAN' });
}
