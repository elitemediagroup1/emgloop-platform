# Legacy Intake retirement plan — what changes, and what must never be deleted

**Status:** PLAN ONLY (2026-09-16). **Nothing here has been executed, and nothing here may be executed
without a separate Product authorization.** No production read was performed for this document: every
number below comes from the read-only audit already recorded in
`identity-evidence-resolution.md` §1 (production run 34986946619, 2026-09-15).

**The instinct this plan exists to refuse.** 24,579 of 24,590 Customer records are caller-ID ingestion
residue. The tempting conclusion is that they are junk and should be cleaned up. They are not junk: they
are the **attachment points** for calls, website events, conversations, bookings, orders and service
requests that really happened. Deleting one does not delete its interactions — Postgres sets their
`customerId` to NULL — so a "cleanup" would not remove data, it would **sever the only link between a
real call and the record it was filed against**, silently and irreversibly.

**So the goal is to change the projection, not erase the facts.**

---

## 1. Evidence base

| Fact | Measured (2026-09-15) |
|---|---|
| Customer records | 24,590 |
| CallGrid caller-ID ingestion residue | 24,579 (99.96%) |
| Records carrying a name | **2** |
| Records with no human-work evidence | 24,585 |
| Established Parties / evidence / resolution links / Party links | 0 / 0 / 0 / 0 |
| Calls attached on a last-seven-digit match only | 274 calls across 58 records |
| Attached calls whose caller number **differs** from the record's phone | 319 |

Two facts do most of the work here. **Records with a name: 2.** And **319 calls are attached to a record
whose phone number is not the caller's** — so the population is not merely thin, parts of it are
demonstrably misattached. Any plan that treats these rows as identities inherits those 319 mistakes.

---

## 2. Classification

Read-time only. Segments come from the merged `intakeProvenanceSegment` classifier, which the population
audit and the CRM read path already share — one definition, so a segment means the same thing in an
operations report and on a screen.

### A. Facts retained permanently — never deleted, never detached

Interactions · MarketplaceCalls and their provider-fact revisions · conversations and messages ·
bookings, orders, service requests · AuditLog · IntegrationEvents · Work OS records · CI observations
and findings · revenue and attribution facts.

**Including every fact attached to a residue record.** A call filed against the wrong Customer is still a
call that happened; the attachment is wrong, the fact is not.

### B. Legacy projections hidden from canonical People

The **entire** legacy Customer population, presented as **Intake Records** and never as People. Already
achieved by projection (C-04 wording, merged in #248): People means established PERSON Parties, Companies
means established COMPANY Parties, and neither reads this table. **No row is hidden, moved or marked** —
the projection simply asks a different authority.

### C. Eligible for governed establishment

**Candidates, not a queue, and emphatically not a batch.** A record becomes a Party only when an
authorized person decides it is one, one at a time, through `PartyService` + `CustomerPartyLinkService`.

Indicative shape of the candidate set (to be counted, not assumed, when a read is authorized):
- the **2** records carrying a name;
- records with human-work evidence (bookings, orders, service requests, operator notes) — the audit
  found 5 records with any;
- records an operator explicitly created, rather than ingestion.

**Order of magnitude: single or low double digits, out of 24,590.** That is the honest size of the
"could become a Person" set, and it is why mass conversion was never the answer.

### D. Requires human review

- The **58 records** holding 274 calls matched on the last seven digits only.
- The **319 calls** whose caller number differs from the record they are attached to.
- Any record whose facts span more than one apparent caller.

These need a person to say what happened. Loop must not guess, and this plan proposes **no automated
remediation** for them — a governed diagnostic that surfaces the mismatch is the most Loop may do.

### E. Demonstrably synthetic / test data

`SEED_OR_DEMO` by the shared classifier: `sic-demo-`, `demo-`, `e2e-`, `test-`, `qa-`, `hotfix-verify`
external-id prefixes.

**Eligible for eventual deletion — and still not deletable today**, for two reasons: the count is not
established (no authorized read), and even a demo record may hold real interactions attached by
ingestion. Any deletion proposal must first prove, per record, that every attached fact is also
synthetic. **HARD STOP:** deletion needs its own Product authorization and its own dispatched workflow.

### F. Must remain unresolved

Everything else — **~24,500 records**, anonymous-visitor and caller-ID residue with no name, no human
work, and no governed evidence. UNRESOLVED is a **legal, permanent, non-alarming state** (locked
principle). These records keep their facts, keep their provenance label, and are never converted,
merged, hidden or deleted. Most of this population will stay here forever, and that is the correct
outcome, not a backlog.

---

## 3. What this plan explicitly does not propose

No deletion · no backfill · no mass conversion · no automatic linking · no merging · no identity inferred
from a phone or email match · no hiding of any record · no mutation of any legacy row whatsoever.

The only state change any legacy record may ever undergo is an **explicit governed link** to an
established Party, performed by an authorized person, recorded with who and why, and reversible with a
reason — the path `CustomerPartyLinkService` already implements.

---

## 4. What would need authorization, and in what order

| Step | Needs | Nature |
|---|---|---|
| 1. Count segments C, D and E precisely | **Production read authorization** | Read-only, via the existing `read-people-population` workflow |
| 2. Ship a governed operator path to establish a Party and link an Intake Record | Already authorized (R3 run) | Writes, per record, by a person |
| 3. Surface the 58-record / 319-call mismatch as a governed diagnostic | Product decision on presentation | Read-only |
| 4. Propose deletion of segment E | Product authorization + per-record proof that attached facts are synthetic | **Destructive — hard stop** |

**Nothing beyond step 1 is proposed for the current run, and step 1 has not been requested.**
