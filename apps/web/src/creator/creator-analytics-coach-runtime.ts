import 'server-only';
import { prisma, CreatorAnalyticsReviewRepository, CreatorAnalyticsReviewService } from '@emgloop/database';
import { governedGateway } from '../ai/governed-gateway';
export const creatorAnalyticsReviewRepository = () => new CreatorAnalyticsReviewRepository(prisma);
export const creatorAnalyticsReviewService = () => new CreatorAnalyticsReviewService(creatorAnalyticsReviewRepository(), governedGateway().gateway);
