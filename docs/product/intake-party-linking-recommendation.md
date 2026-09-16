# Intake Record → Party linking — recommendation

**Status: recommendation only, 2026-09-16. Nothing here is built, and the P0.2e fence is unchanged.**
Building it needs the Product decision in §1.

## 1. The decision still to take

Today no product path creates a `CustomerPartyLink`.
- **The service exists and is governed.** `CustomerPartyLinkService` link, reverse and history require
  `identityResolution:approve`, so only OWNER and ADMIN may link. AI_EMPLOYEE is hard-denied.
- **The web app is fenced off from linking entirely.** `packages/database/test/customer-party-link.test.ts`
  forbids any file under `apps/web/src` from even naming it.

**That scope is deliberate, not an accident of the test's name.** The fence arrived with the service in
#225, whose rule 9 reads "No screens" and whose commit message says "No ingestion, webhook, sync route
**or screen** reaches it". So allowing a screen changes a locked rule. It is a Product decision, not a
refactor.

**The records disagree about whether that decision was taken:**
- `docs/product/legacy-intake-retirement-plan.md` step 2 says "Ship a governed operator path to establish
  a Party and link an Intake Record — Already authorized (R3 run)".
- `docs/product/ui-track-handoff.md` §3 and `governed-operator-surface.md` say it is not taken.

**Please decide one way, and the losing record will be corrected.**

## 2. The workflow, if approved

1. **Review.** A person opens an Intake Record (`/crm/customers/[id]`, `customers:view`).
2. **Find or establish the Party.** They either pick an **established** Party from the People/Companies
   lists, or create and establish one through the existing governed actions (OWNER/ADMIN for
   establishment). There is **no lookup by name, phone or email**, and nothing is suggested.
3. **Link.** They press "Link to this Party", choose a basis (MANUAL or EXPLICIT_LINK, **required**, no
   default), and submit.
4. **The service decides:**
   - authorization first;
   - the record must be in the organization;
   - the Intake Record must not be merged;
   - the Party must be established, not archived, and not superseded (a superseded Party is refused with
     its canonical id, never swapped);
   - there must be no conflicting active link.

   It writes one row and one audit entry.
5. **Provenance survives.** The Intake Record keeps its provenance segment and its own history. The link is
   context, and the Party's activity does not absorb the record's calls merely because a link exists.
6. **Reversal.** OWNER/ADMIN may reverse with a written reason. The row keeps who and why, and relinking
   writes a new row.

Nothing about this is automatic. It is one person's act on one record, and bulk linking is out of scope
(identity record, rule 8).

## 3. Where the action lives

- **Exactly one new file:** `apps/web/src/crm/intake-link-actions.ts`, a `'use server'` module beside
  `party-actions.ts`.
  - Each export calls `requireCrmContext()` first.
  - It passes `ctx.organizationId` and `ctx.userId`, with `actorName: ctx.session.name`, to
    `CustomerPartyLinkService`.
  - It returns a result.
- **Never** under `app/api`, never a route handler, never beside `crm/webhook-runtime.ts` or
  `crm/live-org.ts`. `src/crm/` also holds ingestion helpers, so a directory-wide exemption would be
  unsafe.
- **First, a read model in `packages/database`** for the Intake Record's identity state. It would carry
  `partyLink` and `availableActions` (computed with `canLink`), as the foundation handoff's
  `IntakeRecordV1` already specifies. Otherwise the page needs a second web file that names the service.

## 4. The narrowest fence revision

In `customer-party-link.test.ts`:

1. **Exempt exactly one path, by equality:** `apps/web/src/crm/intake-link-actions.ts`.
   - Not a directory, prefix or glob.
   - Assert the file exists, so the exemption cannot outlive it.
   - The exemption covers only `CustomerPartyLink|customerPartyLink`. `party_linked` and `.link(ORG` stay
     forbidden even there, because the service writes the audit.
2. **Keep every other `apps/web/src` file under the current rule**, still without comment stripping.
3. **Widen the ingestion side** from `ingestion.service.ts` alone to the full `INGESTION_PATH` list in
   `ingestion-identity-boundary.test.ts`.
4. **Add an importer allowlist.** The current rule matches names, not importers:
   - Only non-route, non-client files under `apps/web/src/app/crm/` may import `intake-link-actions`.
   - No file under `app/api/`, no `route.ts`, and no file mentioning `LIVE_ORG_SLUG`, `webhook-runtime` or
     `live-org` may import it.
5. **Constrain the module's shape:**
   - it starts with `'use server'`;
   - it imports `CustomerPartyLinkService` from `@emgloop/database` only;
   - every export calls `requireCrmContext()` before the service;
   - it takes no `organizationId`, `userId`, `role` or `systemRole` from the form;
   - it has no bulk constructs (`for`, `.map(`, `forEach`, `Promise.all`);
   - it reads no contact values;
   - the basis is explicit.
6. **Rename the test** to its real scope: "only the governed intake-link action can reach linking;
   ingestion, webhook, sync and API paths cannot".

## 5. The tests that would prove it

- The revised fence, with mutations that must each fail it:
  - a second `src/crm` file naming the service;
  - the action imported from `app/api/webhooks/callgrid/route.ts`;
  - `requireCrmContext` removed;
  - an organization read from the form;
  - a directory-wide allowlist.
- Link and reverse submitted as OWNER, ADMIN, MANAGER, EMPLOYEE, READ_ONLY, AI_EMPLOYEE, an unknown role
  and a disabled member.
  - Only OWNER and ADMIN succeed.
  - A refusal leaves no link row and no audit row.
  - This mirrors `operator-surface-authorization.test.ts`.
- The existing public-surface guard scan, which picks up the new `'use server'` file automatically.
- A session-only authority test, modeled on `party-actions.test.tsx`.
- The 16 existing service tests, unchanged.
