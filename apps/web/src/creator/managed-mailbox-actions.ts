'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSessionBinding } from '../auth/auth';
import { managedMailboxes } from '../google/google-runtime';
import { requireEmgActor, EMG_HREFS } from './creator-runtime';

const field = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
function back(profileId: string, outcome: string): never {
  const base = profileId ? EMG_HREFS.creator(profileId) : EMG_HREFS.creators;
  revalidatePath(base);
  redirect(`${base}?mailbox=${encodeURIComponent(outcome)}#mailboxes`);
}

export async function connectManagedMailboxAction(data: FormData): Promise<void> {
  const { workspace, actor } = await requireEmgActor();
  const profileId = field(data, 'profileId');
  if (workspace !== 'ADMIN' || profileId.length > 200) back('', 'NOT_ALLOWED');
  const bound = await getSessionBinding();
  if (
    !bound ||
    bound.session.userId !== actor.userId ||
    bound.session.organizationId !== actor.organizationId
  )
    back('', 'NOT_ALLOWED');
  let result;
  try {
    result = await managedMailboxes().service.begin(
      { organizationId: actor.organizationId, userId: actor.userId, sessionId: bound.sessionId },
      {
        creatorProfileId: profileId || null,
        expectedEmail: field(data, 'email'),
        confirmed: data.get('confirmed') === 'on',
      },
    );
  } catch {
    back(profileId, 'FAILED');
  }
  if ('url' in result) redirect(result.url);
  back(profileId, result.outcome);
}

export async function disconnectManagedMailboxAction(data: FormData): Promise<void> {
  const { workspace, actor } = await requireEmgActor();
  const profileId = field(data, 'profileId');
  if (workspace !== 'ADMIN' || profileId.length > 200 || data.get('confirmed') !== 'on')
    back('', 'NOT_ALLOWED');
  let outcome = 'FAILED';
  try {
    outcome = await managedMailboxes().service.repository.disconnect(
      { organizationId: actor.organizationId, userId: actor.userId },
      field(data, 'mailboxId'),
      new Date(),
    );
  } catch {
    /* No internal error, Google token or address in a redirect. */
  }
  back(profileId, outcome);
}
