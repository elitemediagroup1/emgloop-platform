'use server';

// Party write actions -- identity slice P1.
//
// The governed write surface for canonical identity. Before this, `PartyService`
// had no production caller, so no Party could ever be created or established and
// People, Companies and every Relationship stayed empty by construction.
//
//   createPartyAction     identityResolution:create   OWNER, ADMIN, MANAGER, EMPLOYEE
//                         A PERSON or COMPANY record now exists. It is NOT established.
//   establishPartyAction  identityResolution:approve  OWNER, ADMIN
//                         Basis MANUAL or EXPLICIT_LINK, stated explicitly.
//
// The organization and the actor come only from the signed session. Authorization
// is `PartyService`'s: it checks before it looks, so a person without authority
// learns nothing. AI_EMPLOYEE holds neither action and no Permission row can grant
// one. Nothing here reads a contact value, matches identity, or creates an Intake
// Record, a Relationship or anything else.
//
// These actions return a result instead of redirecting, so the UI track can
// compose them into whatever flow it designs. No page renders them yet.

import { PartyService, prisma } from '@emgloop/database';
import { requireCrmContext } from './crm-data';
import {
  parseCreatePartyForm,
  parseEstablishPartyForm,
  toPartyActionResult,
  type PartyActionResult,
} from './party-forms';

const parties = new PartyService(prisma);

export async function createPartyAction(formData: FormData): Promise<PartyActionResult> {
  const ctx = await requireCrmContext();
  const input = parseCreatePartyForm(formData);
  return toPartyActionResult(
    await parties.create(ctx.organizationId, ctx.userId, input, { actorName: ctx.session.name }),
  );
}

export async function establishPartyAction(formData: FormData): Promise<PartyActionResult> {
  const ctx = await requireCrmContext();
  const input = parseEstablishPartyForm(formData);
  if (!input) return { outcome: 'INVALID', reason: 'MISSING_FIELD' };
  return toPartyActionResult(
    await parties.establish(ctx.organizationId, ctx.userId, input.partyId, input.basis, { actorName: ctx.session.name }),
  );
}
