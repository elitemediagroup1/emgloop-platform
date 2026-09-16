# The governed operator surface

**Status: temporary engineering UI. It is not the product design.**
Charlie and Lexi hold the visual authority for Loop. Nothing in this document
describes their redesign, and none of it is implemented. This surface exists for one
reason and should be deleted when theirs lands.

## Why it exists

Loop had a Party authority and a Relationship authority, both governed, both tested,
and **neither had a caller**. Production held zero established Parties and zero
Relationships, so every canonical surface was empty *by construction* rather than
because the business had no customers. That is not a product loop; it is an
architecture with nobody able to reach it.

This surface is the smallest honest path from "the authority exists" to "an
authorized person can use it".

## What an authorized person can do

| # | Workflow | Where | Authority it calls |
|---|---|---|---|
| 1 | Create and establish a PERSON Party | `/crm/parties` | `PartyService.create` / `.establish` |
| 2 | Create and establish a COMPANY Party | `/crm/parties` | same |
| 3 | View a canonical Party | `/crm/parties/[id]` | `PartyRecordService.getRecord` |
| 4 | Tell a Party apart from a legacy Intake Record | both Party pages | read model + explicit wording |
| 5 | Create a Relationship from established Parties | `/crm/relationships/new` | `CrmRelationshipService.create` |
| 6 | Add permitted Participants | `/crm/relationships/[id]` | `.addParticipant` |
| 7 | View Relationship detail | `/crm/relationships/[id]` | `CrmRelationshipReadService.getRecord` |
| 8 | View Participants | `/crm/relationships/[id]` | same record |
| 9 | View Relationship history | `/crm/relationships/[id]` | same record, append-only |
| 10 | Lifecycle: end, reactivate, void, Participant changes | `/crm/relationships/[id]` | `.end` / `.reactivate` / `.void` / `.endParticipant` / `.voidParticipant` |
| 11 | See what the backend permits, rather than a UI guess | every page | server `capabilities` |
| 12 | See superseded, archived and refused states | `PartyRef`, outcome banners | Party Reference contract |

## The rules it holds

**Authorization is server-side, and the surface re-asks on every act.** Each page
calls `requirePermission` before it reads. Each page renders its forms from the
`capabilities` the server returned. Every submitted act is then authorized *again* by
the service. Hiding a button is not access control, so
`packages/database/test/operator-surface-authorization.test.ts` submits every act as
every role and asserts the refusal comes from the authority — and that a refused act
leaves no row, no event, no audit entry and no outbox row.

**Nothing is duplicated.** The web layer holds no establishment rule, no act table,
no Party resolution. A second copy would drift from the first and nobody would know
which one was authority.

**No identity is inferred.** There is no lookup by name, phone or email anywhere on
this surface. A Relationship form offers only Parties somebody already established.
A lookup that matched a contact value would be identity resolution performed by a
form, which is the thing this architecture exists to prevent.

**Refusals are shown, not smoothed over.** A superseded Party reference displays both
the stored id and the canonical one, and says the write was refused — the surface
never substitutes the canonical id on the operator's behalf. A duplicate Relationship
is reported and nothing is merged.

## Two blockers, and they are the same blocker

### Universal Activity is not on these pages

The A2 Activity read model supports four subjects: `ORGANIZATION`, `INTAKE_RECORD`,
`CASE`, `WORK_ITEM`. There is no `PARTY` and no `RELATIONSHIP`.

**Relationship detail: not possible without inventing authority.** No adapter holds
Relationship-attached rows. Adding a `RELATIONSHIP` subject would mean inventing an
attachment no source records. The Relationship's own append-only history is already
on the page, on the Relationship's own authority, which is the honest version of what
Universal Activity would have shown.

**Party detail: possible in principle, unreachable in practice.** The only reading
that invents no authority is per linked Intake Record — read that record's activity
as *the Intake Record's*, using the existing `INTAKE_RECORD` subject, never relabelled
as the Party's own. Presenting those items under a Party heading would make legacy
Intake-attached facts look like canonical Party activity merely because a link exists,
which is exactly the conflation the identity architecture forbids.

But **no code path in the product creates a `CustomerPartyLink` row.** The link
service exists and is tested; nothing that runs in production calls it. So
`linkedIntakeRecords` is empty for every Party, and the section would render nothing,
ever. A screen for a state the product cannot reach is the "button for a thing that
isn't built" anti-pattern.

### Intake → Party linking would violate the P0.2e web fence

Which is the same blocker, one level down. The fence in
`packages/database/test/customer-party-link.test.ts` asserts that **no file under
`apps/web/src`** mentions `CustomerPartyLink`, `customerPartyLink`, `.link( ORG` or
`party_linked`. Its test name says "ingestion, webhook and sync routes", but its scope
is the entire web application.

Any honest web implementation of linking imports `CustomerPartyLinkService`, whose
name trips the fence on the import line alone. **This was not implemented and the
fence was not weakened.** Deciding whether the web app may ever reach linking — and
if so, how the fence should be narrowed so it still stops ingestion — is a product and
architecture decision, not something to route around while building an operator
screen.

Unblocking Universal Activity on Party detail therefore starts with that decision,
not with the activity layer.

## Roles

Exercised role by role in `operator-surface-authorization.test.ts`. `T` is permitted.

| | OWNER | ADMIN | MANAGER | EMPLOYEE | AI_EMPLOYEE | READ_ONLY | unknown |
|---|---|---|---|---|---|---|---|
| View Party | T | T | T | T | | T | |
| Create Party | T | T | T | T | | | |
| Establish Party | T | T | | | | | |
| View Relationship | T | T | T | T | | T | |
| Create / add Participant / change Participant | T | T | T | T | | | |
| End / reactivate / end Participant | T | T | T | | | | |
| Void / void Participant | T | T | | | | | |

`AI_EMPLOYEE` is hard-denied at both authorities and no `Permission` row can grant it
either. An **unknown role** is refused everything, by two different mechanisms worth
knowing apart: `identityResolution` has no `READ_ONLY` fallback, so the Party surface
is closed; and although `relationships` *does* fall back to `READ_ONLY` in the matrix,
a role that is not a role derives no membership at all, and the read service requires
a granted membership before it consults the matrix. The nav will offer that person a
Relationships link and the page will refuse them — which is the right way round. Nav
visibility has never been authorization.
