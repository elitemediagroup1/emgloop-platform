'use server';

// Relationship and Participant write actions -- the operator surface's write path.
//
// EVERY ONE OF THESE IS A THIN WRAPPER. It resolves the session, reads strings out
// of a FormData, and calls `CrmRelationshipService`. Nothing here authorizes,
// validates a vocabulary, resolves a Party, writes an event, an audit row or an
// outbox row -- all of that is the service's, and duplicating any of it in the web
// layer would create a second authority that drifts from the first.
//
// THE ORGANIZATION AND THE ACTOR COME ONLY FROM THE SIGNED SESSION. No form field
// names either, and there is nothing a browser can send that changes whose act this
// is.
//
// A SUPERSEDED PARTY IS NEVER SUBSTITUTED. When the service refuses one it returns
// the canonical id; the redirect carries it so the operator can see it and retry on
// purpose. Loop does not retry for them.
//
// THE CLOCK IS THE SERVER'S. `occurredAt` is stamped here, from the server, never
// from a form: a browser-supplied occurrence time is a browser-supplied fact.

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { CrmRelationshipService, prisma } from '@emgloop/database';
import type { CrmParticipantRole, CrmRelationshipSide } from '@emgloop/shared';

import { requireCrmContext } from './crm-data';
import { field, outcomeQuery } from './relationship-forms';

const relationships = new CrmRelationshipService(prisma);

async function actor() {
  const ctx = await requireCrmContext();
  return { organizationId: ctx.organizationId, userId: ctx.userId, actorName: ctx.session.name };
}

export async function createRelationshipAction(formData: FormData): Promise<void> {
  const who = await actor();
  const kind = field(formData, 'kind');
  // Two sides at most; an OWN kind declares one, and the service refuses a shape
  // its kind does not describe.
  const sides = (['COUNTERPARTY', 'A', 'B'] as const)
    .map((side) => ({
      side: side as CrmRelationshipSide,
      partyId: field(formData, `party_${side}`),
      role: field(formData, `role_${side}`) as CrmParticipantRole,
    }))
    .filter((s) => s.partyId !== '');

  const result = await relationships.create(who, { kind, sides, occurredAt: new Date() });
  revalidatePath('/crm/relationships');
  if (result.outcome === 'RECORDED') {
    redirect(`/crm/relationships/${result.value.relationship.id}?outcome=RECORDED`);
  }
  redirect(`/crm/relationships/new?${outcomeQuery(result)}`);
}

export async function endRelationshipAction(formData: FormData): Promise<void> {
  const who = await actor();
  const id = field(formData, 'relationshipId');
  const result = await relationships.end(who, id, { reason: field(formData, 'reason'), occurredAt: new Date() });
  redirect(`/crm/relationships/${id}?${outcomeQuery(result)}`);
}

export async function reactivateRelationshipAction(formData: FormData): Promise<void> {
  const who = await actor();
  const id = field(formData, 'relationshipId');
  const result = await relationships.reactivate(who, id, { occurredAt: new Date() });
  redirect(`/crm/relationships/${id}?${outcomeQuery(result)}`);
}

export async function voidRelationshipAction(formData: FormData): Promise<void> {
  const who = await actor();
  const id = field(formData, 'relationshipId');
  const result = await relationships.void(who, id, { reason: field(formData, 'reason'), occurredAt: new Date() });
  redirect(`/crm/relationships/${id}?${outcomeQuery(result)}`);
}

export async function addParticipantAction(formData: FormData): Promise<void> {
  const who = await actor();
  const relationshipId = field(formData, 'relationshipId');
  const result = await relationships.addParticipant(who, {
    relationshipId,
    partyId: field(formData, 'partyId'),
    role: field(formData, 'role') as CrmParticipantRole,
    actsForSide: field(formData, 'actsForSide') as CrmRelationshipSide,
    occurredAt: new Date(),
  });
  redirect(`/crm/relationships/${relationshipId}?${outcomeQuery(result)}`);
}

export async function endParticipantAction(formData: FormData): Promise<void> {
  const who = await actor();
  const relationshipId = field(formData, 'relationshipId');
  const result = await relationships.endParticipant(who, field(formData, 'participantId'), {
    reason: field(formData, 'reason'),
    occurredAt: new Date(),
  });
  redirect(`/crm/relationships/${relationshipId}?${outcomeQuery(result)}`);
}

export async function voidParticipantAction(formData: FormData): Promise<void> {
  const who = await actor();
  const relationshipId = field(formData, 'relationshipId');
  const result = await relationships.voidParticipant(who, field(formData, 'participantId'), {
    reason: field(formData, 'reason'),
    occurredAt: new Date(),
  });
  redirect(`/crm/relationships/${relationshipId}?${outcomeQuery(result)}`);
}
