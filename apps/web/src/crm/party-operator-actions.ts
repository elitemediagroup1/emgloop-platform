'use server';

// The operator surface's Party write path.
//
// IT ADDS NOTHING. `createPartyAction` and `establishPartyAction` (identity slice
// P1) already hold the whole governed authority; these wrappers exist only because a
// server-rendered form cannot read a returned value, so the outcome travels in a
// redirect instead. Every rule -- who may create, who may establish, which bases are
// governed, that an archived record cannot be established -- stays in `PartyService`.
//
// No contact value is read, no identity is matched, no Intake Record is touched, and
// nothing here creates a Party except when a person submitted a form asking for one.

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireCrmContext } from './crm-data';
import { createPartyAction, establishPartyAction } from './party-actions';

export async function operatorCreatePartyAction(formData: FormData): Promise<void> {
  // Guarded here AND inside the action it delegates to. The delegate is the real
  // authority; this call is why a reader of THIS file can see a guard without
  // following a chain, which is what the public-surface fence asks of every action.
  await requireCrmContext();
  const result = await createPartyAction(formData);
  revalidatePath('/crm/parties');
  const params = new URLSearchParams({ outcome: result.outcome });
  if ('reason' in result && result.reason) params.set('reason', result.reason);
  if ('partyId' in result) params.set('partyId', result.partyId);
  redirect(`/crm/parties?${params.toString()}`);
}

export async function operatorEstablishPartyAction(formData: FormData): Promise<void> {
  await requireCrmContext();
  const result = await establishPartyAction(formData);
  revalidatePath('/crm/parties');
  const params = new URLSearchParams({ outcome: result.outcome });
  if ('reason' in result && result.reason) params.set('reason', result.reason);
  if ('partyId' in result) params.set('partyId', result.partyId);
  redirect(`/crm/parties?${params.toString()}`);
}
