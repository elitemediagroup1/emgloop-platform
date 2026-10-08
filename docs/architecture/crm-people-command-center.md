# CRM People command center (CRM slice 6)

**Status:** built on branch `feat/crm-people-command-center` (2026-10-08). Migration
`20261013000000_crm_people_command_center` is additive and **not applied to production**. The backfill
has **not** been run against production. See §9 for the gates.

This record describes what is built. It does not describe plans.

---

## 1. What it is

People (`/app/crm/people`) is the outreach command center for established PERSON Parties. Each row shows:

- who the person is: name, title, company context and creator context;
- where the conversation stands: state, cadence step, last touch;
- what is next: next action and its due date;
- whether they replied, and a summary line.

Identity state ("Established") is secondary metadata. Above the list, an executive summary carries real
counts. Filters, presets, search and paging run on the server.

A Person record (`/app/crm/people/[partyId]`) adds:

- an outreach panel: current state, next action, cadence, last outreach and last inbound, upcoming meeting;
- a context panel: title, company, creator, source status and origin;
- a chronological timeline, where every entry carries its source and time.

**Possible New People** (`/app/crm/people/discover`) is a private review queue. It lists addresses from the
viewer's own mail that the CRM does not hold, and adding one is always a human act.

## 2. Three kinds of thing, never blended

| Kind | Where it lives | Written by | Shared? |
|---|---|---|---|
| **Fact** — a recorded title, note, source status, last-contacted time, creator or company context, origin | `crm_subject_context_facts` | the backfill (`IMPORTED`) or a person (`OPERATOR_RECORDED`) | yes, with everyone who may see People |
| **Fact** — a send, a reply, a meeting | the viewer's own `work_messages` / `work_events` (Daily Loop) | Gmail / Calendar sync | **no**, only the viewer |
| **Derived state** — cadence position, next touch and due date, AWAITING_REPLY, REPLIED_NEEDS_RESPONSE, REVIEW_REQUIRED, MEETING_SCHEDULED, ACTIVE_CONVERSATION | nowhere: computed on every read (`deriveCrmOutreach`) | rules | per viewer |
| **Human interpretation** — conversation state, next action | `crm_outreach_states` (the projection) and `crm_outreach_events` (append-only) | a person, through `CrmOutreachService` | yes |

- Each row's state carries its **basis**: `HUMAN`, `GMAIL`, `CALENDAR`, `IMPORT` or `NONE`. The screen
  says which.
- A conversation state is **never** an Opportunity stage. It never moves one and never creates one.
- **INTERESTED, NEGOTIATING, ON_HOLD, CIRCLE_BACK, PASSED and CLOSED exist only when a person set them.**
  No rule derives them.

## 3. Whose mail: the isolation rule

Mail and calendar facts are **private to the mailbox owner**
(`daily-loop-employee-intelligence.md` §20.1). That holds for OWNER and ADMIN too. So the command center
combines two things at read time, **for one viewer**:

1. **Shared CRM facts:** context facts, the human state and next action, and the Contact Points' recorded
   last human contact.
2. **The viewer's own** correspondents, messages and events, read through `WorkOutreachRepository`. Every
   method of that repository takes a `WorkPrincipal`; there is no organization-only read.

Consequences, stated plainly:

- **Two people see the same row with different reply facts.** Matt's sends never shape Charlie's view.
- Summary counts over mail-derived states (awaiting reply, replies needing response, touched this week,
  new replies) are **the viewer's own**, and the page says so.
- **No organization-wide view of who replied to whom exists.** Building one would aggregate mail-derived
  data across people, which §20.2a forbids without its own architecture record. If an organization-wide
  view is wanted, its route is a §32.6 shared conclusion that a person deliberately records (for example
  a human-set state). It is never a copy of mail facts.
- **Reply content is never copied.** A timeline mail entry links to `/app/mail/<threadId>`, the viewer's
  own thread, which reads the body through on demand under their own Google connection. Subjects appear
  only in the viewer's own timeline and queue.

## 4. Exact linking (no fuzzy, no AI)

`linkCorrespondents` (`packages/database/src/crm-outreach/crm-outreach-mail-link.ts`) links a mail address
to a Party only by exact equality, in four steps:

1. Normalize the viewer's stored correspondent address as a Contact Point value
   (`normalizeCrmContactPointValue`).
2. Hash it under the Contact Point namespace with the organization's key (`crmContactPointValueHash`).
3. Compare it with the organization's **current** EMAIL Contact Points (`matchIndex`, which never reads a
   value).
4. Map each match:

   - **INDIVIDUAL on a PERSON:** the Person's mail.
   - **ROLE_INBOX / UNATTRIBUTED on a COMPANY:** the Company's mail. **It is never a Person's**, and no
     Person is fabricated from it.
   - **Held by two Parties:** `AMBIGUOUS`, linked to neither.

Nothing else links mail to a Party: no name, no domain, no similarity, no model.

**The key must match.** Contact Points record the fingerprint of the key their hash was taken under. A
runtime holding another key reports `keyMismatchedPoints` on the page instead of silently linking nothing.

Calendar meetings link through the same correspondent hashes: an event whose `attendeeHashes` holds one of
a Person's linked addresses is a meeting with that Person.

- **Limitation:** an attendee the viewer has never emailed is not a correspondent, so that meeting does not
  link.
- **A meeting never creates a Relationship, a Participant or an Opportunity.**

## 5. Message qualification and the cadence

`qualifyCrmMessage` (shared) uses stored metadata only.

| Qualification | Rule |
|---|---|
| `QUALIFYING_SEND` | the viewer sent it, the person is a direct (**To**) recipient, and it is not DRAFT, SPAM or TRASH |
| `HUMAN_REPLY` | it came from the person's own address, and no rule below applies |
| `AUTOMATED` | SPAM or TRASH; normalized Gmail automation evidence (Auto-Submitted, List-Id/List-Unsubscribe, Precedence bulk/list/junk); an automated sender local part (no-reply, mailer-daemon, notifications, …); or a subject that **starts** like an auto-reply, out-of-office, bounce, delivery or read receipt |
| `UNCERTAIN` | from the person, but Gmail filed it in a bulk tab. Never counted as a reply; surfaces `REVIEW_REQUIRED` |
| `NOT_OUTREACH` | the person was only copied (Cc), or the message is a draft |

Gmail sync requests automation/list headers as metadata and reduces them immediately to one safe
classification (`AUTO_SUBMITTED`, `MAILING_LIST`, or `BULK`). Raw header values are never persisted.
Therefore an ordinary-subject OOO carrying `Auto-Submitted` cannot stop cadence.

**The cadence (locked):**

1. Initial send.
2. Three touches 3 days apart.
3. Three touches 7 days apart.
4. Three touches 14 days apart.
5. Then monthly (the same UTC day and time one month later, clamped to month end) for as long as no reply
   arrives.

Every interval runs from the **actual** time of the previous qualifying send, so a late touch moves
everything after it. A `HUMAN_REPLY` after the first send stops the cadence; an `AUTOMATED` one does not.
A human-set state also stops it (`stoppedBy: HUMAN_STATE`).

Due buckets (`OVERDUE`, `TODAY`, `UPCOMING`) use the viewer's calendar day in their own zone.

**Resolution order** (`deriveCrmOutreach`, each rule tested on its own):

1. A human reply newer than the last send **and** newer than any human-set state:
   `REPLIED_NEEDS_RESPONSE`.
2. A human-set state: that state.
3. An `UNCERTAIN` inbound newer than the last send: `REVIEW_REQUIRED (UNCERTAIN_INBOUND)`.
4. An upcoming meeting with the person on the viewer's calendar: `MEETING_SCHEDULED`.
5. A human reply, answered: `ACTIVE_CONVERSATION`.
6. Qualifying sends: `AWAITING_REPLY`, with the cadence.
7. Only an imported last-contacted time: `REVIEW_REQUIRED (IMPORTED_HISTORY_ONLY)`. The cadence position
   is **UNKNOWN**; it is never guessed from the import.
8. Mail readable but empty: `NO_OUTREACH`. Mail unreadable: `UNKNOWN`. It is never shown as NO_OUTREACH.

**Freshness:**

- "No reply observed through \<last completed read\>" is stated whether the read is fresh or stale, and a
  stale read is marked "Gmail data stale".
- With no readable Gmail, the page says "Gmail data unavailable" and makes no claim.

In production the scheduled cycle fires every few hours while staleness starts after 30 minutes, so
"stale" is the usual state between cycles. Visiting Mail refreshes it.

## 6. Recorded context and notes

- **Operator notes, titles and next actions** go through `CrmOutreachService`. Act grants come from
  `CRM_OUTREACH_ACT_ROLES`, behind the coarse `identityResolution:view` gate (the gate People and Contact
  Points use):

  | Act | Roles |
  |---|---|
  | VIEW | all human roles |
  | SET_STATE, SET_NEXT_ACTION, RECORD_NOTE | EMPLOYEE and above |
  | RETRACT_FACT, BACKFILL_CONTEXT | OWNER and ADMIN |

  AI_EMPLOYEE and CREATOR hold nothing.
- **Typed text carrying a contact value is refused** (`CARRIES_CONTACT_VALUE`). A note readable by everyone
  who sees People must not become a side door to a Contact Point's value, which has its own VIEW_VALUE rule.
- **Imported text is redacted:** address- and number-shaped runs are replaced with
  `[contact value withheld]` and counted.
- **Audit and outbox rows carry ids, kinds, states and booleans** ("a next action was set"). They never
  carry words. The outbox subject type is `CRM_OUTREACH`.
- **A retracted fact stays in the history**, marked retracted.

## 7. The historical-context backfill

The slice 5 import deliberately kept no title or note in provenance. The backfill
(`CrmContextBackfillService`; CLI `backfill-context-dry-run` / `backfill-context-apply`; workflow modes of
the same names) reads **that APPLY run's own source** again. It enforces:

- **Pinned source:** the source's SHA-256 must equal the run's `sourceSha256`. Otherwise
  `SOURCE_MISMATCH`.
- **Exact row matching:** each row is matched to its entry by line, source row key **and** the keyed row
  fingerprint the import recorded. A changed row is skipped (`ROW_CHANGED`). If every row mismatches,
  `FINGERPRINT_KEY_MISMATCH` (a different identifier key).
- **Applied subjects only:** only entries the APPLY actually applied (`appliedAt`) are used, and only their
  recorded Person or Company. Superseded subjects resolve to the canonical one; unavailable ones are
  skipped.
- **Facts written:**
  - TITLE (Person only).
  - NOTE and SOURCE_STATUS (verbatim, redacted, **unknown time**).
  - SOURCE_LAST_CONTACTED (DATE or INSTANT precision).
  - CREATOR_CONTEXT (the reviewed alias text and its creator Party).
  - COMPANY_CONTEXT (the governed Company the row attached to, as a context link).
- **Never written:** a Party, Contact Point, Opportunity, Relationship, Participant, affiliation or
  identity evidence. The Party import is never re-run.
- **Dry run first:** writes nothing; prints counts and a `planDigest`. APPLY re-plans and refuses unless
  the digest equals the reviewed one (`PLAN_CHANGED`). Facts are keyed by content per subject, so a rerun
  records nothing new, and a retry after a failure completes the rest.
- **Production:** only the `CRM Outreach Import` workflow on `main` with the typed confirmation
  `backfill <first 12 of the plan digest>`, which sets `CRM_CONTEXT_BACKFILL_PRODUCTION=commissioned-v1`
  for that step only. Any other path is refused (`PRODUCTION_NOT_COMMISSIONED` / `TARGET_REFUSED`).
- **Output** is counts, codes, ids and digests: printable in a workflow log.

## 8. Possible New People

`decideCrmDiscovery` (shared) applies fixed rules. The first exclusion that applies wins:

1. OWN_ADDRESS
2. INTERNAL: a member's address, or one of the organization's own non-public domains. A colleague on
   gmail.com does not make gmail.com internal.
3. ALREADY_IN_CRM: an exact Contact Point holds it.
4. DISMISSED
5. SUPPRESSED (in Mail)
6. AUTOMATED_SENDER
7. ROLE_OR_LIST_MAILBOX: info@, support@, …-request@
8. NO_DIRECT_EXCHANGE: neither a direct qualifying send nor a human inbound exists.
9. ONLY_AUTOMATED_MAIL

An address that survives these rules is surfaced with its reasons: `YOU_EMAILED_THEM`, `THEY_REPLIED`
when they did, or `THEY_CONTACTED_YOU` for a legitimate inbound-first contact. Inbound-first candidates
remain review-only; they never auto-create a Person.

**Add to People** (`CrmPeopleDiscoveryService.add`):

- **Only the viewer's own correspondent hash comes from the form.** The address is re-read from the
  viewer's own mail at click time.
- **The exact state is re-checked:**
  - an INDIVIDUAL holder: `ALREADY_EXISTS`, opening that Person;
  - a Company ROLE_INBOX / UNATTRIBUTED holder: `REATTRIBUTION_REQUIRED`. It is never converted.
- **Then, in one transaction:**
  - `PartyService.create` (PERSON) and `establish` (MANUAL, which needs `identityResolution:approve`);
  - `CrmContactPointService.add` (EMAIL, INDIVIDUAL, OPERATOR_RECORDED);
  - an ORIGIN fact, "Human-approved from Gmail discovery".
- **No Company, Opportunity, Relationship, Participant or affiliation is created.** The name is what the
  person typed or confirmed (from the mail's display name), **never** derived from the address.
- **After adding,** the Person's history appears at once, because the address now links exactly.

**Dismiss / restore** (IGNORE, NOT_A_PERSON, INTERNAL, AUTOMATED, NOT_RELEVANT) is a private,
reversible preference:

- It is stored in `crm_discovery_dismissals` per (organization, user, correspondent hash), on a composite
  FK to the membership.
- It is erased with the person's work state at offboarding (`ERASED_WORK_TABLES`), and it is not audited.

No model takes part in anything here. The optional AI summary in the brief is **not built**.

## 9. Gates

| Gate | State |
|---|---|
| IMPLEMENTED | yes (this branch) |
| TESTED | locally: shared, database (Postgres), web, operations, workflow guard |
| PR REVIEWED / MERGED | no |
| MIGRATION DEPLOYED | no (`Deploy Prisma Migrations`, Matt) |
| BACKFILL DRY RUN / APPROVED / APPLIED | no / no / no |
| GMAIL INGESTION VERIFIED | the production Gmail cycle runs for `servicesinmycity-demo` (2026-10-08 00:59Z: 3 of 3 synced); linkage to People is not verified in production |
| CALENDAR INGESTION VERIFIED | the production Calendar cycle runs; meeting linkage is not verified in production |
| UI DEPLOYED / UI VERIFIED / SLICE PROVEN | no / no / no |

Procedure: `docs/runbooks/crm-outreach-import.md` Part 6.
