'use server';
import { ttoMediaService } from '../tiktok-business/runtime';
import { revalidatePath } from 'next/cache';
import { requireCreator } from './creator-runtime';
import { creatorMailSharingEnabled, managedCreatorMailRepository } from './creator-mail-runtime';
export async function refreshCreatorUpdates(): Promise<{ ok: boolean }> {
  const seat = await requireCreator();
  const p = { organizationId: seat.actor.organizationId, userId: seat.actor.userId };
  const [mail, media] = await Promise.allSettled([
    creatorMailSharingEnabled() ? managedCreatorMailRepository().requestRefresh(p, seat.profileId, new Date(), true) : Promise.resolve(false),
    ttoMediaService().refresh(p, seat.profileId, true),
  ]);
  revalidatePath('/app'); revalidatePath('/app/creator/opportunities');
  return { ok: (mail.status === 'fulfilled' && mail.value) || (media.status === 'fulfilled' && ['SYNCED','NOT_DUE'].includes(media.value)) };
}
