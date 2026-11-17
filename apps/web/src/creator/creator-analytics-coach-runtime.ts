import 'server-only';
import { prisma, CreatorAnalyticsReviewRepository, CreatorAnalyticsReviewService } from '@emgloop/database';
import { governedGateway } from '../ai/governed-gateway';
export const creatorAnalyticsReviewRepository = () => new CreatorAnalyticsReviewRepository(prisma);
export const creatorAnalyticsReviewService = () => new CreatorAnalyticsReviewService(creatorAnalyticsReviewRepository(), governedGateway().gateway);
/** Do not claim the shared production cache from a preview whose AI task is intentionally off. */
export function creatorAnalyticsReviewActive(organizationId:string):boolean{
 const activation=governedGateway().env.activation;
 return activation.enabled&&activation.organizations.includes(organizationId)&&activation.tasks.includes('creator.analytics.reading')&&activation.providers.includes('openai');
}
