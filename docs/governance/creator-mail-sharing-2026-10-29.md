# Creator brand-email publication decision — October 29, 2026

Matt requested that managed creators see summaries of EMG's brand/agency conversations on their
behalf, grouped by brand. He selected **Automatic summaries** after a mailbox owner links a thread.
He clarified that Matt and Charlie configure Gmail in the backend, creators supply social handles,
and slight delay is acceptable for this surface while employee operational data must remain real time.

This records that product decision. It does not record Charlie's mailbox consent, approve access to
any unconnected account, or claim production activation. The exact deployment decision reference is
`creator-mail-sharing:2026-10-29:v1` (`LOOP_CREATOR_MAIL_SHARING_DECISION`). Unset or different is OFF.
The separate `creator.brand.update` AI task also requires activation and a recorded provider policy.

## The publication boundary

Daily Loop Mail, its private summaries, and its read APIs remain private. This is the explicitly
shared capability contemplated by daily-loop-employee-intelligence.md §20.2a, not an extension of
that private digest's audience. No organization-wide private mail query or admin mailbox bypass is added.

An active OWNER/ADMIN/MANAGER, in their own signed session, chooses a stored thread belonging to
their own connected Gmail, an existing creator profile with an active CREATOR login, and an established
Company for the brand or agency. They explicitly authorize ongoing minimized publication for that
one thread. The creator recipient is snapshotted, so changing a profile's bound login does not move
old mail summaries to a new person. One owner's thread cannot be assigned to multiple creators;
changing scope requires withdrawal and a new authorization. New email threads require their own link.

That audited authorization is the worker's narrow capability to read the selected thread as its owner.
It does not authorize reading a mailbox selected by a creator's request parameter. The worker discovers
routing records from the explicit sharing queue, not employee mailboxes. The owner must still have an
active consistent membership, read authority, their own Gmail read grant and MAIL content consent.
Consent ID and timestamp are captured so reauthorization cannot silently revive an old share.

## What is published

A dedicated task, template and validated output contract produce a short update, a stage, a documented
next step and private evidence citations. Its result belongs to RELATIONSHIPS / CREATOR_BRAND_THREAD,
never EMPLOYEE_INTELLIGENCE (which still promises private results). It is a non-authoritative AI
interpretation, not a CRM transition, agreement, work assignment or sent message.

The creator read returns only published prose, stage, the authorized company label, and reading/source
check timestamps. It returns no mailbox owner identifier, email address, subject, body, private thread
identifier, raw citation or provider credential. Source bodies are transient and never stored here.
Only that creator's currently bound, active login can read it. Multiple explicitly shared conversations
are grouped under the same canonical brand; this is not a second AI synthesis across private mailboxes.

No prices, commissions, margins, private contact details, internal assessments or other creators' details
are intended for publication. The prompt requires withholding uncertain relevance, mixed-creator or
internal-only discussions. The validator refuses money/contact patterns, copied quotations, unsupported
numbers/dates and invalid citations. These checks reduce risk; semantic relevance and confidentiality
classification remain model judgments and are not a guarantee. The sharing control discloses that AI
can be wrong and that internal-only/mixed-creator threads must not be authorized.

## Withdrawal, retention and freshness

- Owner withdrawal removes the stored summary and invalidates its lease atomically. An in-flight answer
  cannot land after that withdrawal. MAIL consent revoke deletes the owner's shares in its transaction.
- Read and write recheck current consent, membership, Google connection, company standing and recipient
  binding. Disconnection, permission denial or offboarding blocks access immediately at that check.
  Invalid scopes are deleted by the next worker pass. Owner work-thread erasure also cascades the share.
- Only a current paraphrase is retained, not a mail archive. A source older than 30 days is not displayed
  or regenerated. The existing six-hour AWS retention sweep clears expired text. Link/audit identifiers
  may remain as authorization provenance. No summary/body is put in audit or application logs.
- Each linked thread is due roughly every five minutes; the AWS worker scans the queue every minute.
  Bounded passes, leases, quotas, provider failures and budgets can extend that delay. Changes cause a
  governed AI call; unchanged evidence, including an unchanged withheld result, does not.
- The UI stamps the actual source/check/generation times, labels earlier readings, and refreshes the
  stored view once a minute while visible. A missing update never means no outreach occurred.

## Mailbox coverage

The first implementation uses the existing per-person Google connections. Matt authorizes Matt's
threads; Charlie authorizes Charlie's. One account currently holds one Google connection. Connecting
additional managed creator EMG inboxes independently is not implemented here; do not overwrite an
existing connection or claim that possession of an email address gives Loop access to its mailbox.
