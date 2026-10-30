'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { CREATOR_MAIL_SHARING_DECISION } from '@emgloop/shared';
import { requireEmgActor } from './creator-runtime';
import { creatorMailRepository, creatorMailSharingEnabled } from './creator-mail-runtime';
const field = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
function back(threadId: string, outcome: string): never {
  const href = `/app/mail/${encodeURIComponent(threadId)}`;
  revalidatePath(href);
  revalidatePath('/app/creator');
  revalidatePath('/app');
  redirect(`${href}?creatorUpdate=${encodeURIComponent(outcome)}`);
}
export async function shareCreatorMailAction(data: FormData): Promise<void> {
  const { actor, workspace } = await requireEmgActor();
  const thread = field(data, 'threadId');
  if (!thread || thread.length > 200) redirect('/app/mail');
  if (workspace !== 'ADMIN' || !creatorMailSharingEnabled()) back(thread, 'NOT_ALLOWED');
  const result = await creatorMailRepository().share({ organizationId: actor.organizationId, userId: actor.userId }, { threadProviderId: thread, creatorProfileId: field(data, 'creatorProfileId'), brandPartyId: field(data, 'brandPartyId'), confirmed: data.get('confirmed') === 'on', decisionRef: CREATOR_MAIL_SHARING_DECISION });
  back(thread, result);
}
export async function withdrawCreatorMailAction(data: FormData): Promise<void> {
  const { actor } = await requireEmgActor();
  const thread = field(data, 'threadId');
  if (!thread || thread.length > 200) redirect('/app/mail');
  const result = await creatorMailRepository().withdraw({ organizationId: actor.organizationId, userId: actor.userId }, field(data, 'shareId'));
  back(thread, result);
}
