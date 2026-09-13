// Loop Cognitive Architecture — repository sub-barrel (Increment 1).
//
// One import surface for the canonical cognitive persistence layer. Every
// repository is organization-scoped (organizationId is always the first
// argument, always from authenticated server context) and fails closed to null
// on cross-org access. These are server-only; never expose them to client
// components.

import type { PrismaClient } from '@prisma/client';

import {
  CognitiveIdentityRepository,
  IdentityRoleRepository,
  IdentityEvidenceRepository,
  IdentityResolutionLinkRepository,
  IdentityRelationshipRepository,
} from './identity.repository';
import { PartyRepository } from './party.repository';
import { MemoryEventRepository } from './memory.repository';
import { KnowledgeAssertionRepository } from './knowledge.repository';
import { DataGovernancePolicyRepository } from './governance.repository';
import { ActiveStateRepository, StateChangeOutboxRepository } from './active-state.repository';
import { StateChangeDeliveryRepository } from './delivery.repository';
import { StateChangeSubscriptionRepository } from './subscription.repository';
import { IntelligenceHypothesisRepository } from './hypothesis.repository';
import { CognitiveDecisionRepository } from './decision.repository';
import { CognitiveProcessingAttemptRepository } from './processing-attempt.repository';

export {
  CognitiveIdentityRepository,
  IdentityRoleRepository,
  IdentityEvidenceRepository,
  IdentityResolutionLinkRepository,
  IdentityRelationshipRepository,
} from './identity.repository';
export type {
  CreateIdentityInput,
  AddRoleInput,
  RecordEvidenceInput,
  ProposeLinkInput,
  CreateRelationshipInput,
} from './identity.repository';
export { PartyRepository } from './party.repository';
export type { PartyView } from './party.repository';
export { MemoryEventRepository } from './memory.repository';
export type { AppendMemoryInput } from './memory.repository';
export { KnowledgeAssertionRepository } from './knowledge.repository';
export type { CreateAssertionInput } from './knowledge.repository';
export { DataGovernancePolicyRepository } from './governance.repository';
export type { CreatePolicyInput } from './governance.repository';
export {
  ActiveStateRepository,
  StateChangeOutboxRepository,
} from './active-state.repository';
export type {
  ApplyStateChangeInput,
  ApplyStateChangeResult,
  StateEvidenceInput,
  EnqueueOutboxInput,
} from './active-state.repository';
export { StateChangeDeliveryRepository } from './delivery.repository';
export type {
  EnsureDeliveryInput,
  DeliveryRetryOptions,
} from './delivery.repository';
export { StateChangeSubscriptionRepository, stateKeyMatches } from './subscription.repository';
export type { CreateSubscriptionInput } from './subscription.repository';
export { IntelligenceHypothesisRepository } from './hypothesis.repository';
export type { ProposeHypothesisInput } from './hypothesis.repository';
export { CognitiveDecisionRepository } from './decision.repository';
export type { RecordDecisionInput } from './decision.repository';
export { CognitiveProcessingAttemptRepository } from './processing-attempt.repository';
export type { StartAttemptInput, FailAttemptInput } from './processing-attempt.repository';
export {
  hashIdentifier,
  normalizeIdentifier,
} from './hashing';
// CRM P0.2d: counts-only read of what exists before Party schema alignment.
export { IdentityFootprintRepository, FOOTPRINT_ROW_BOUND } from './identity-footprint.repository';
export type { IdentityFootprint } from './identity-footprint.repository';

/** The full cognitive persistence layer, constructed over one PrismaClient. */
export interface CognitiveRepositories {
  identities: CognitiveIdentityRepository;
  identityRoles: IdentityRoleRepository;
  identityEvidence: IdentityEvidenceRepository;
  identityResolutionLinks: IdentityResolutionLinkRepository;
  identityRelationships: IdentityRelationshipRepository;
  /** Party reads over the identities above. Owns no table. */
  parties: PartyRepository;
  memoryEvents: MemoryEventRepository;
  knowledgeAssertions: KnowledgeAssertionRepository;
  governancePolicies: DataGovernancePolicyRepository;
  activeState: ActiveStateRepository;
  stateChangeOutbox: StateChangeOutboxRepository;
  stateChangeDeliveries: StateChangeDeliveryRepository;
  subscriptions: StateChangeSubscriptionRepository;
  hypotheses: IntelligenceHypothesisRepository;
  decisions: CognitiveDecisionRepository;
  processingAttempts: CognitiveProcessingAttemptRepository;
}

export function createCognitiveRepositories(prisma: PrismaClient): CognitiveRepositories {
  return {
    identities: new CognitiveIdentityRepository(prisma),
    identityRoles: new IdentityRoleRepository(prisma),
    identityEvidence: new IdentityEvidenceRepository(prisma),
    identityResolutionLinks: new IdentityResolutionLinkRepository(prisma),
    identityRelationships: new IdentityRelationshipRepository(prisma),
    parties: new PartyRepository(prisma),
    memoryEvents: new MemoryEventRepository(prisma),
    knowledgeAssertions: new KnowledgeAssertionRepository(prisma),
    governancePolicies: new DataGovernancePolicyRepository(prisma),
    activeState: new ActiveStateRepository(prisma),
    stateChangeOutbox: new StateChangeOutboxRepository(prisma),
    stateChangeDeliveries: new StateChangeDeliveryRepository(prisma),
    subscriptions: new StateChangeSubscriptionRepository(prisma),
    hypotheses: new IntelligenceHypothesisRepository(prisma),
    decisions: new CognitiveDecisionRepository(prisma),
    processingAttempts: new CognitiveProcessingAttemptRepository(prisma),
  };
}
