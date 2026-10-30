import 'server-only';
import { CreatorBrandMailRepository, CreatorBrandMailService, gmailMailReadThrough, prisma } from '@emgloop/database';
import { CREATOR_MAIL_SHARING_DECISION } from '@emgloop/shared';
import { governedGateway } from '../ai/governed-gateway';
import { GMAIL_CONFIG } from '../daily-loop/mail';
export function creatorMailSharingEnabled(): boolean {
  return process.env.LOOP_CREATOR_MAIL_SHARING_DECISION === CREATOR_MAIL_SHARING_DECISION;
}
export function creatorMailRepository() { return new CreatorBrandMailRepository(prisma); }
export function creatorMailService() {
  return new CreatorBrandMailService({ repository: creatorMailRepository(), runtime: governedGateway().gateway, readThread: gmailMailReadThrough(prisma, GMAIL_CONFIG(), { excludeLabels: ['SPAM', 'TRASH', 'DRAFT'] }), now: () => new Date() });
}
