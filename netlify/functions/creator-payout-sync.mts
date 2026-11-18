import {prisma,CreatorPayoutRepository,stripePayoutConfig,StripeGlobalPayoutsApi} from '@emgloop/database';
// Reconciles explicitly requested payouts only; never sends an unrequested withdrawal.
export default async()=>{const c=stripePayoutConfig();if(!c)return;try{const checked=await new CreatorPayoutRepository(prisma,c,new StripeGlobalPayoutsApi(c)).sweep();console.info('creator-payout-sync',{checked});}catch{throw Error('PAYOUT_SYNC_UNAVAILABLE');}};
export const config={schedule:'*/10 * * * *'};
