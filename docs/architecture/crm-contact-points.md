# CRM Contact Points — decision record (PD-F-05)

**Status:** Product approved 2026-10-06 (Matt). **Built** (§3–§9): contract `packages/shared/src/crm-contact-point.ts`,
`CrmContactPointRepository` / `CrmContactPointService`, migration `20261010000000_crm_contact_points`, and a
read-only Contact points panel on the Person record. **Not built:** a write UI, a Company record page, the
importer (§10), suppression, reactivation, attribution of an UNATTRIBUTED value, and any purge. The migration
reaches production only through the manual migration workflow; until then the Person panel says Contact
Points are not available. **Audience:** engineers
building on Parties, the CRM UI track, and anyone writing an importer.

A CRM Contact Point is a business email address or phone number that an authorized person recorded
or imported for a Party, so EMG staff can reach that Party. It is an operational CRM record and not
identity.

## 1. What Product decided

| # | Decision (2026-10-06) |
|---|---|
| 1 | PD-F-05 is approved as a **separate CRM Contact Point authority**. Imported or operator-recorded business email addresses and phone numbers may be stored, including the normalized raw value, so authorized people can see them. |
| 2 | **A Contact Point is not IdentityEvidence.** It does not establish identity. It does not raise an identity tier, create IdentityEvidence or prove a PERSON ↔ COMPANY affiliation. It does not authorize Party establishment by its value alone. It is never VERIFIED because it was imported or recorded. |
| 3 | The IdentityEvidence rule is unchanged: EMAIL/PHONE `OPERATOR_RECORDED` is still not an approved identity-evidence class (`identity-evidence-resolution.md` §5). |
| 4 | **No legal conclusion is encoded.** The record carries provenance (basis, recorder, time, source reference), purpose (business contact) and state. |
| 5 | **Retention:** an active Contact Point is kept for 36 months after the latest human outreach or interaction associated with it, unless it is retired, voided or suppressed sooner, or a stricter policy applies. Suppression, unsubscribe and undeliverable fingerprints may outlive the raw value to prevent accidental re-contact. The period must be able to become configurable per organization or policy without rewriting a Contact Point's identity. **No automatic purge in the first slice.** This policy never applies to IdentityEvidence. |
| 6 | **Classification:** `INDIVIDUAL` (a known person's address, on a PERSON), `ROLE_INBOX` (a genuine shared or team address, on a COMPANY) and `UNATTRIBUTED` (it looks individual but no governed person attribution exists, so it sits on a COMPANY). Moving an UNATTRIBUTED value to a PERSON later is a governed human act, never a silent conversion. |
| 7 | **Grants:** READ_ONLY sees kind, classification and state but never the value. EMPLOYEE and above may see values and add. MANAGER and above may retire or mark undeliverable. OWNER/ADMIN may void. AI_EMPLOYEE is hard denied the values and every write act. |
| 8 | **Exact matching only** (§7). Names are never a matching key. No fuzzy matching. |
| 9 | Raw values never appear in audit metadata, events, outbox payloads or logs. No AI or Brain context selector may receive a raw value, or `internalNotes` that carries contact data. |
| 10 | A job title is not a Contact Point attribute. |

## 2. Why a separate authority

The identity architecture keeps raw contact values out of evidence: evidence is hash-only, and its
classes need an active use policy before anything is produced. Contact Points answer a different
question: *how do EMG staff reach this Party?* That question needs the readable value and a lifecycle
(bounces, people leaving).

Keeping the two apart means a recorded address can never become identity by being stored. A Contact
Point cannot raise a tier, attribute a fact or establish a Party.

The existing precedent is `WorkCorrespondent`, which keeps a hash for matching and the readable form
beside it.

## 3. Vocabulary (pure contract, `@emgloop/shared` `crm-contact-point.ts`)

| Term | Values |
|---|---|
| Kind | `EMAIL`, `PHONE` |
| Classification | `INDIVIDUAL` (PERSON only) · `ROLE_INBOX` (COMPANY only) · `UNATTRIBUTED` (COMPANY only) |
| Purpose | `BUSINESS_CONTACT` |
| Basis | `OPERATOR_RECORDED` · `IMPORTED` (requires an opaque source reference that carries no contact value) |
| State | `ACTIVE` · `UNDELIVERABLE` · `RETIRED` · `VOIDED` |

**Normalization:**
- An email is trimmed and lower-cased, and must be a single address with a domain.
- A phone is accepted only in international form: `+` and 8–15 digits once spaces, dots, dashes and
  parentheses are removed. Loop does not guess a country code, so a number without one is refused.

**The value is immutable.** A wrong value is voided or retired, and the correct one is added as a new
Contact Point.

## 4. Lifecycle

| From | To | Event | Who | Reason |
|---|---|---|---|---|
| — | ACTIVE | `CONTACT_POINT_ADDED` | EMPLOYEE+ | — |
| ACTIVE | UNDELIVERABLE | `CONTACT_POINT_MARKED_UNDELIVERABLE` | MANAGER+ | required |
| ACTIVE, UNDELIVERABLE | RETIRED | `CONTACT_POINT_RETIRED` | MANAGER+ | required |
| ACTIVE, UNDELIVERABLE, RETIRED | VOIDED | `CONTACT_POINT_VOIDED` | OWNER/ADMIN | required |

Every act appends an event in the same transaction as the change, and the row's state is the projection
of that log. Nothing is deleted.

- **UNDELIVERABLE** is a deliverability observation (a bounce, "address not found"). It is not verification.
- **RETIRED** means it was true and has stopped (the person left).
- **VOIDED** means it was never true (entered in error).

There is no reactivation and no suppression act yet; neither has been approved.

**A reason must never carry a contact value.** A reason containing an address or a long digit run is
refused, so the event log cannot become a second copy of the values.

## 5. Uniqueness and conflict

- **At most one current Contact Point per (organization, Party, kind, value).** "Current" means ACTIVE
  or UNDELIVERABLE. A RETIRED or VOIDED row releases the key, so re-adding a value after retirement
  writes a new row and keeps the old one.
- **The same value on two Parties is allowed and is a conflict.** It is detected at read time from the
  current rows: there is no stored flag to drift. A conflicting value never matches anything (§7).

## 6. Party association

- **Who it attaches to:** a Contact Point attaches to a Party through the Party Reference contract, which
  requires an **established, non-superseded, non-archived** PERSON or COMPANY in the same organization.
  A superseded id is refused and the canonical id is returned; it is never silently swapped.
- **Party type is recorded, never asserted:** the Party type is the one the Party authority reported at
  write time.
- **Classification must fit the Party type** (§3).
- **Never a Customer:** a Contact Point never attaches to a Customer (Intake Record).

## 7. Exact matching (the only matching an importer may do)

A writer may reuse an existing Party only when the value's hash matches exactly one current Contact
Point, and all of these hold:
- it is in the same organization;
- it is ACTIVE;
- no other Party currently holds the value;
- it is on an established, non-superseded Party;
- that Party is of the required type.

| Finding | Outcome |
|---|---|
| Exactly one qualifying match | `MATCH` with the Party id |
| No current Contact Point | `NO_MATCH`. The writer may create a Party only where the row is otherwise approved for creation. |
| Two or more Parties hold the value | `CONFLICT`: human review |
| The holder is the wrong Party type | `TYPE_MISMATCH`: human review |
| The holder is superseded, unestablished or archived | `PARTY_NOT_REFERENCEABLE`: human review |
| The only match is UNDELIVERABLE | `INACTIVE_MATCH`: human review. This prevents a silent duplicate. |

Matching compares keyed hashes inside one organization. The hashes are HMACs salted by organization and
namespaced to Contact Points, so they never compare with IdentityEvidence hashes. Names are never read.

## 8. Authorization

- **Act table:** `CRM_CONTACT_POINT_ACT_ROLES` lists the acts `VIEW_SUMMARY`, `VIEW_VALUE`, `ADD`,
  `MARK_UNDELIVERABLE`, `RETIRE`, `VOID` and `MATCH`, with the grants of §1.7. `MATCH` is EMPLOYEE+:
  it returns a Party id, never a value.
- **Who may act:** only a HUMAN actor, with an ACTIVE membership in the organization, holding the coarse
  `identityResolution:view` gate (the gate Party records already use), and permitted by the act table.
- **AI_EMPLOYEE is refused** before the table is consulted.
- **No Permission row can widen an act:** none is consulted.

## 9. Privacy and retention

- **What is written where:**
  - **Audit rows:** ids, kind, classification, basis, states and whether a reason was given.
  - **Outbox events:** subject `CONTACT_POINT` and domain `COMMUNICATION`; the payload holds ids, kind,
    classification and states.
  - **Neither** ever holds the value or its hash.
- **Reads:**
  - The repository's default read model omits the value.
  - A single method returns values, and only the governed service calls it, after `VIEW_VALUE`.
- **AI fence:** a source fence asserts that no AI runtime, Brain or intelligence context code reads Contact
  Points or `internalNotes`.
- **Retention:** each row records the policy it was kept under (`crm.contact_point.retention.v1`: 36
  months after the anchor). The anchor is the latest recorded human contact, or the time the point was
  added when none is recorded.
  - The retain-until date is computed, never stored, so a later per-organization policy changes a key,
    not the rows.
  - A nullable `valueErasedAt` lets a future purge remove the raw value and keep the fingerprint, so
    suppression survives. That purge is not built.

## 10. Rules for the brand-outreach directory import (approved 2026-10-06; importer not built)

These bind the future importer.

- **Route classification first.** Every directory route is classified before any import.
  - Personal-mail routes (e.g. `gmail.com`), EMG internal domains and creator personal domains are
    refused as brand Companies.
  - Brand, agency and parent-company routes become COMPANY Parties only when explicitly classified as such.
  - An ambiguous route is never classified from its domain; the dry run lists it for review.
- **Establishment.** Approved Companies and valid named People are established with basis `MANUAL`,
  attributed to Matt's operator act. This is not authority to establish every route.
- **Unnamed contacts.** No PERSON Party is created for an unnamed address.
  - An unnamed individual-looking address attaches to the COMPANY as `UNATTRIBUTED`.
  - A shared or team address attaches as `ROLE_INBOX`.
  - A named person's address attaches to the PERSON as `INDIVIDUAL`.
- **No AFFILIATION from this source.** Email domain, route, heading, title text and the 6 October role check
  are each insufficient. Titles and their sources are preserved for later human review in an appropriate
  governed authority, never in a Contact Point.
- **Directory statuses are not Opportunity stages.** These are outreach and contact-state information:
  - Not due
  - Historical
  - Other hold
  - Human reply–hold
  - Excluded
  - Pending draft

  Opportunity creation and initial stage need a separate explicit mapping decision.
- **Nothing is creator-visible.** Everything imported is internal, and no creator-visible field is set.
- **Production source.** A private S3 object in the production AWS account, read with GitHub OIDC
  short-lived credentials. A dry run comes before any write. A production write needs a separate
  explicit confirmation. Contact values never appear in workflow logs.

## 11. Decisions log

| Date | Decision |
|---|---|
| 2026-10-06 | PD-F-05 approved as a separate CRM Contact Point authority (§1). Contact Point ≠ IdentityEvidence; the OPERATOR_RECORDED evidence rule is unchanged. 36-month retention after the latest human contact, no purge yet. Classifications INDIVIDUAL / ROLE_INBOX / UNATTRIBUTED. Grants as §1.7. Exact matching as §7. Directory import rules as §10. |
