// The creator domain (Creator Hub, 2026-09-22). See creator.repository.ts for what it owns.
import type { PrismaClient } from '@prisma/client';
import type { WorkRepository } from '../repositories/work.repository';
import { CreatorRepository } from './creator.repository';
import { CrmCommercialRepository } from './crm-commercial.repository';
import { CreatorProductionService } from './creator-production.service';
import { CreatorRecordService } from './creator-record.service';

export { CreatorRepository, versionLabel } from './creator.repository';
export { absentUntilMigrated } from './until-migrated';
export type {
  CreateCreatorProfileInput,
  CreateContentInput,
  BeginVersionInput,
  VersionReadyInput,
  RecordApprovalInput,
  RecordPublicationInput,
  CreateProductionInput,
  ContentWithLineage,
} from './creator.repository';
export { CrmCommercialRepository } from './crm-commercial.repository';
export type {
  CreateOpportunityInput,
  OpportunityTransitionInput,
  CreateCampaignInput,
  CampaignTransitionInput,
  DeclareDeliverableInput,
  CampaignWithDeliverables,
  OpportunityWithHistory,
} from './crm-commercial.repository';
export { CreatorProductionService, parseProductionStep, productionFacts, versionMarks } from './creator-production.service';
export type { CreatorActor, EmgActor, ProductionRefusal, ProductionResult } from './creator-production.service';
export { CreatorRecordService } from './creator-record.service';
export type { ContentNotice, NoticeRung } from '@emgloop/brain';
export type {
  Seat,
  PersonRef,
  VersionView,
  InstructionView,
  CommentView,
  StepView,
  ProductionView,
  ContextView,
  ContentRecordView,
  LibraryItem,
  CreatorTask,
  OpportunityView,
  CampaignView,
  DeliverableView,
  EarningsView,
  AnalyticsView,
} from './creator-record.service';

/** The creator domain, composed once over one Prisma client and the Work OS repository. */
export function createCreatorDomain(prisma: PrismaClient, work: WorkRepository) {
  const creator = new CreatorRepository(prisma);
  const commercial = new CrmCommercialRepository(prisma);
  return {
    creator,
    commercial,
    productions: new CreatorProductionService(prisma, creator, work, commercial),
    records: new CreatorRecordService(prisma, creator, work, commercial),
  };
}
export type CreatorDomain = ReturnType<typeof createCreatorDomain>;
