'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSessionBinding } from '../auth/auth';
import { CREATOR_HREFS, requireCreator } from '../creator/creator-runtime';
import { metaRepository, metaReturnPath, metaService, metaAnalyticsService } from './meta-runtime';
export async function selectMetaAccountAction(form: FormData): Promise<void> {
  const seat = await requireCreator();
  const bound = await getSessionBinding();
  let outcome = 'FAILED';
  if (bound) {
    try { outcome = await metaService().select({ organizationId: seat.actor.organizationId, userId: seat.actor.userId, creatorProfileId: seat.profileId }, bound.sessionId, String(form.get('pageId') ?? '')) ? 'CONNECTED' : 'INVALID_REQUEST'; }
    catch { outcome = 'ACCOUNT_UNAVAILABLE'; }
  }
  revalidatePath(CREATOR_HREFS.profile);
  redirect(metaReturnPath(outcome));
}
export async function disconnectMetaAction(): Promise<void> {
  const seat = await requireCreator();
  await metaRepository().disconnect({ organizationId: seat.actor.organizationId, userId: seat.actor.userId, creatorProfileId: seat.profileId });
  revalidatePath(CREATOR_HREFS.profile); revalidatePath(CREATOR_HREFS.analytics);
  redirect(metaReturnPath('DISCONNECTED'));
}
export async function refreshMetaAction(): Promise<void> {
  const seat = await requireCreator();
  const outcome = await metaService().sync({ organizationId: seat.actor.organizationId, userId: seat.actor.userId, creatorProfileId: seat.profileId });
  revalidatePath(CREATOR_HREFS.analytics); revalidatePath(CREATOR_HREFS.profile);
  redirect(`${CREATOR_HREFS.analytics}?${new URLSearchParams({ meta: outcome })}`);
}

export async function analyzeMetaAction(): Promise<void> {
  const seat = await requireCreator();
  const outcome = await metaAnalyticsService().analyze({ organizationId: seat.actor.organizationId, userId: seat.actor.userId, creatorProfileId: seat.profileId });
  revalidatePath(CREATOR_HREFS.analytics);
  redirect(`${CREATOR_HREFS.analytics}?${new URLSearchParams({ meta: outcome })}`);
}
