# Mail-content AI governance decision — 2026-10-08

## Decision

The workspace owner approved Loop using AI to read the content of the owner's connected work Gmail
conversations for private CRM/intelligence summaries and next-action suggestions.

The deployment reference for this decision is:

`counterparty-consent:2026-10-08:docs/governance/mail-content-ai-2026-10-08`

## Scope

This decision permits the existing governed Mail-content intelligence path to process message bodies
transiently for the mailbox owner who separately opts in.

It does **not** authorize Loop to:

- store Gmail message bodies in CRM, `work_messages`, audit logs, outbox payloads, or AI provenance;
- expose one employee's Mail intelligence to another employee;
- create or alter a Person, Company, Relationship, Opportunity, Participant, affiliation, cadence event,
  or human-set CRM state from model output;
- send, reply to, delete, or modify email automatically.

The model may produce only the minimized private outputs already defined by the Mail intelligence
contracts: a conversation reading, supported obligations/signals, and the downstream private Mail-domain
reading.

## Retention and revocation

Message bodies are read through the mailbox owner's existing Google connection for the model call and are
then dropped. The minimized private Mail intelligence reading follows the existing 30-day retention rule.

The mailbox owner must still authorize Mail-content processing separately. Revocation stops future
processing and withdraws that person's derived Mail digests under the existing revoke path.

## Deployment gates that remain mandatory

This repository decision does not itself start processing. Production still requires all of the existing
independent gates:

1. the deployment sets `LOOP_MAIL_CONTENT_GOVERNANCE_DECISION` to the **exact** reference above;
2. `mail.thread@1` / `mail.domain@1` producers are activated;
3. the Mail AI tasks are activated;
4. a provider policy admits `COMMUNICATION_CONTENT`;
5. the mailbox owner explicitly turns on Mail reading;
6. the internal Mail intelligence endpoint/workflow is authenticated and enabled.

Any missing gate fails closed.

## Record

This records the owner's explicit product/governance approval given on 2026-10-08. It is not legal advice
or a representation that a particular jurisdiction requires no additional notice, consent, contractual
term, or compliance review. The deployment operator remains responsible for applicable legal and policy
requirements.
