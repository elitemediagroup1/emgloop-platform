'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireCreator, CREATOR_HREFS } from './creator-runtime';
import { tiktok } from '../tiktok/tiktok-runtime';
import { ttoMediaService } from '../tiktok-business/runtime';
/** Refresh authorized readings only. The redirected GET reuses or generates the governed cached review. */
export async function refreshCreatorAnalyticsAction():Promise<void>{
 const seat=await requireCreator();
 const p={organizationId:seat.actor.organizationId,userId:seat.actor.userId};
 await Promise.allSettled([tiktok().readOnVisit(p),ttoMediaService().refresh(p,seat.profileId,true)]);
 revalidatePath(CREATOR_HREFS.analytics);revalidatePath(CREATOR_HREFS.profile);
 redirect(`${CREATOR_HREFS.analytics}?platform=TIKTOK`);
}
