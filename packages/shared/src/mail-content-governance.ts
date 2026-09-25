// Mail content intelligence -- the governance gate. Loop Intelligence Phase D, 2026-09-26.
//
// THE COUNTERPARTY QUESTION IS UNRESOLVED. Reading a person's mail CONTENT with a model means reading what
// OTHER people wrote to them. The person's own consent (a MAIL content authorization) covers the person;
// whether it is enough for their correspondents -- and under which terms -- is a legal/product decision
// that has NOT been made (recorded UNRESOLVED in docs/runbooks/connections-aws-production.md, "Counterparty
// consent"). Until it is, Mail content AI must not run anywhere, however it is configured.
//
// SO THE CODE IS COMPLETE AND THE GATE IS CLOSED. Mail content triage runs only when ALL hold:
//   1. the deployment names the recorded governance decision (LOOP_MAIL_CONTENT_GOVERNANCE_DECISION, a
//      reference to the written decision, e.g. `counterparty-consent:2026-10-15:<doc-ref>`) -- absent or
//      malformed, NOTHING reads mail content and the product does not even OFFER the consent;
//   2. the person granted their own MAIL content authorization (source_content_authorizations, GMAIL),
//      re-checked inside every digest write;
//   3. the task is activated (LOOP_AI_TASKS), a provider policy admits COMMUNICATION_CONTENT, and the
//      producer is activated (LOOP_INTELLIGENCE_PRODUCERS).
// The deterministic mail lanes (headers only) are unaffected by all of this: they already run.
//
// PURE.

export const MAIL_CONTENT_GOVERNANCE_ENV = 'LOOP_MAIL_CONTENT_GOVERNANCE_DECISION';

/** The recorded state of the question in this repository. Changing it is a documented decision, not a flag. */
export const MAIL_CONTENT_GOVERNANCE_STATUS = 'UNRESOLVED' as const;

const DECISION_REF = /^counterparty-consent:\d{4}-\d{2}-\d{2}:[A-Za-z0-9._\/-]{3,120}$/;

export type MailContentGovernance = { readonly state: 'DECIDED'; readonly decisionRef: string } | { readonly state: 'UNDECIDED' };

/** The deployment's governance reading. Anything but a well-formed decision reference is UNDECIDED. */
export function mailContentGovernance(raw: string | null | undefined): MailContentGovernance {
  const v = typeof raw === 'string' ? raw.trim() : '';
  return DECISION_REF.test(v) ? { state: 'DECIDED', decisionRef: v } : { state: 'UNDECIDED' };
}
