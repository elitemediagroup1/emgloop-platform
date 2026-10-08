// Mail content intelligence -- the governance gate. Loop Intelligence Phase D, 2026-09-26.
//
// COUNTERPARTY CONTENT DECISION RECORDED 2026-10-08. The workspace owner approved Loop using AI to read
// the content of the owner's connected work Gmail conversations for private CRM/intelligence summaries
// and next-action suggestions, with bodies processed transiently and never stored by Loop. The recorded
// decision is docs/governance/mail-content-ai-2026-10-08.md. This is a product/governance record, not a
// legal opinion; deployment remains subject to the operator's applicable legal/compliance obligations.
//
// Mail content triage runs only when ALL hold:
//   1. the deployment names the exact recorded governance decision
//      (LOOP_MAIL_CONTENT_GOVERNANCE_DECISION); absent or any other value, NOTHING reads mail content
//      and the product does not even OFFER the consent;
//   2. the person granted their own MAIL content authorization (source_content_authorizations, GMAIL),
//      re-checked inside every digest write;
//   3. the task is activated (LOOP_AI_TASKS), a provider policy admits COMMUNICATION_CONTENT, and the
//      producer is activated (LOOP_INTELLIGENCE_PRODUCERS).
// The deterministic mail lanes (headers only) are unaffected by all of this: they already run.
//
// PURE.

export const MAIL_CONTENT_GOVERNANCE_ENV = 'LOOP_MAIL_CONTENT_GOVERNANCE_DECISION';

/** The recorded state of the question in this repository. Changing it is a documented decision, not a flag. */
export const MAIL_CONTENT_GOVERNANCE_STATUS = 'DECIDED' as const;
export const MAIL_CONTENT_GOVERNANCE_DECISION_REF =
  'counterparty-consent:2026-10-08:docs/governance/mail-content-ai-2026-10-08' as const;

export type MailContentGovernance = { readonly state: 'DECIDED'; readonly decisionRef: string } | { readonly state: 'UNDECIDED' };

/** The deployment must name this repository's exact recorded decision. Any other value fails closed. */
export function mailContentGovernance(raw: string | null | undefined): MailContentGovernance {
  const v = typeof raw === 'string' ? raw.trim() : '';
  return v === MAIL_CONTENT_GOVERNANCE_DECISION_REF
    ? { state: 'DECIDED', decisionRef: MAIL_CONTENT_GOVERNANCE_DECISION_REF }
    : { state: 'UNDECIDED' };
}
