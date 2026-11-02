'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireEmgActor, EMG_HREFS } from './creator-runtime';
import { managedCreatorMailRepository, managedCreatorMailService, creatorMailSharingEnabled } from './creator-mail-runtime';
const field = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
function back(profileId: string, outcome: string): never {
  const path = EMG_HREFS.creator(profileId);
  revalidatePath(path); revalidatePath('/app'); revalidatePath('/app/creator/opportunities');
  redirect(`${path}?capture=${encodeURIComponent(outcome)}#capture`);
}
export async function startCreatorCaptureAction(form: FormData): Promise<void> {
  const { actor, workspace } = await requireEmgActor();
  const profileId = field(form, 'profileId');
  if (!profileId || profileId.length > 200 || workspace !== 'ADMIN' || !creatorMailSharingEnabled() || form.get('confirmed') !== 'on') redirect(EMG_HREFS.creators);
  let outcome = 'FAILED';
  try {
    const principal = { organizationId: actor.organizationId, userId: actor.userId };
    outcome = await managedCreatorMailRepository().configure(principal, profileId, form.getAll('sourceId').map(String), new Date());
    if (outcome === 'STARTED') await managedCreatorMailService().pass(principal, profileId);
  } catch { /* Only closed outcome codes reach the browser. */ }
  back(profileId, outcome);
}
export async function advanceCreatorCaptureAction(form: FormData): Promise<void> {
  const { actor, workspace } = await requireEmgActor();
  const profileId = field(form, 'profileId');
  if (!profileId || profileId.length > 200 || workspace !== 'ADMIN' || !creatorMailSharingEnabled()) redirect(EMG_HREFS.creators);
  let outcome = 'CHECKED';
  try { await managedCreatorMailService().pass({ organizationId: actor.organizationId, userId: actor.userId }, profileId); }
  catch { outcome = 'FAILED'; }
  back(profileId, outcome);
}
export async function pauseCreatorCaptureAction(form: FormData): Promise<void> {
  const { actor, workspace } = await requireEmgActor();
  const profileId = field(form, 'profileId');
  if (!profileId || profileId.length > 200 || workspace !== 'ADMIN') redirect(EMG_HREFS.creators);
  const stopped = await managedCreatorMailRepository().pause({ organizationId: actor.organizationId, userId: actor.userId }, profileId);
  back(profileId, stopped ? 'PAUSED' : 'NOT_ALLOWED');
}
