'use server';

// Server actions for a creator's OWN TikTok connection.
//
// The organization and person always come from the signed session, and the seat from the
// CreatorProfile bound to that login (`requireCreator()`); the form carries nothing that names
// either. The service re-derives the seat before anything is written.
//
//   disconnectTikTokAction  delete Loop's copy of both tokens, withdraw what was read from the
//                           profile, then ask TikTok to revoke the access.

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { CREATOR_HREFS, requireCreator } from '../creator/creator-runtime';
import { tiktok, tiktokReturnPath } from './tiktok-runtime';

export async function disconnectTikTokAction(_formData: FormData): Promise<void> {
  const seat = await requireCreator();
  const outcome = await tiktok().disconnect({
    organizationId: seat.session.organizationId,
    userId: seat.session.userId,
    name: seat.session.name,
  });
  revalidatePath(CREATOR_HREFS.profile);
  revalidatePath(CREATOR_HREFS.home);
  revalidatePath(CREATOR_HREFS.analytics);
  redirect(tiktokReturnPath(outcome));
}

/** Refresh only this creator's authorized TikTok account, retaining the service's read throttle. */
export async function refreshTikTokAnalyticsAction(): Promise<void> {
  const seat = await requireCreator();
  let ok = false;
  try {
    const result = await tiktok().readOnVisit({ organizationId: seat.actor.organizationId, userId: seat.actor.userId });
    ok = result.ok;
  } catch { /* Provider/database failure must never be presented as a fresh report. */ }
  revalidatePath(CREATOR_HREFS.analytics);
  revalidatePath(CREATOR_HREFS.profile);
  redirect(`${CREATOR_HREFS.analytics}?platform=TIKTOK&source=ACCOUNT&tiktok_sync=${ok ? 'CHECKED' : 'FAILED'}`);
}
