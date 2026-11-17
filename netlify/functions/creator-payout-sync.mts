import { prisma,CreatorPayoutRepository,plaidConfig,PlaidApi } from '@emgloop/database';
// Reconciles recorded creator requests only; it never creates an unrequested withdrawal.
export default async()=>{const c=plaidConfig();if(!c)return;try{const checked=await new CreatorPayoutRepository(prisma,c,new PlaidApi(c)).sweep();console.info('creator-payout-sync',{checked});}catch{console.error('creator-payout-sync unavailable');throw Error('PAYOUT_SYNC_UNAVAILABLE');}};
export const config={schedule:'*/10 * * * *'};
