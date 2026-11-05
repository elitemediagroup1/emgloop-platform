'use server';
import { revalidatePath } from 'next/cache';
import { requireCreator } from './creator-runtime';
import { creatorMailSharingEnabled, managedCreatorMailRepository } from './creator-mail-runtime';
export async function refreshCreatorUpdates(): Promise<{ ok: boolean }> {
  const seat = await requireCreator();
  if (!creatorMailSharingEnabled()) return { ok: false };
  // Profile and organization are derived exclusively from the authenticated creator seat.
  const ok = await managedCreatorMailRepository().requestRefresh({ organizationId: seat.actor.organizationId, userId: seat.actor.userId }, seat.profileId, new Date(), true);
  revalidatePath('/app'); revalidatePath('/app/creator/opportunities');
  return { ok };
}
