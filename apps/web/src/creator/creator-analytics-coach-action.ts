'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireCreator, CREATOR_HREFS } from './creator-runtime';
import { creatorAnalyticsReviewService } from './creator-analytics-coach-runtime';
export async function reviewCreatorPerformance(form:FormData):Promise<void>{
  const seat=await requireCreator();
  // Source is a presentation choice, never account, creator or tenant authority.
  const source=form.get('source')==='ACCOUNT'?'ACCOUNT':'TIKTOK_ONE';
  const result=await creatorAnalyticsReviewService().review({organizationId:seat.actor.organizationId,userId:seat.actor.userId},source);
  revalidatePath(CREATOR_HREFS.analytics);
  redirect(`${CREATOR_HREFS.analytics}?platform=TIKTOK&source=${source}&coach=${result}`);
}
