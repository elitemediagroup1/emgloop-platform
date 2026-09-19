// Daily Loop work state (DL-1): the employee-private store.
//
// Every repository here takes a `WorkPrincipal` -- organization AND user -- as the first
// argument of every method that touches an employee's rows. There is no org-only read path,
// and `work-principal.ts` explains why that is a type rather than a convention.
//
// The one exception is deliberate and carries no employee data: `effectiveRetention`, which
// answers "how long does this organization keep each CATEGORY of row". A test pins both the
// rule and its single exception.

export { workScope, type WorkPrincipal } from './work-principal';
export { WorkSourceRepository, type WorkCursorRecord, type WorkSyncRunRecord } from './work-source.repository';
export {
  WorkGraphRepository,
  type CorrespondentSeen,
  type ThreadFacts,
  type ThreadClassification,
  type MessageFacts,
  type EventFacts,
  type DocumentFacts,
} from './work-graph.repository';
export { WorkItemRepository, type WorkItemDetection, type WorkItemRecord } from './work-item.repository';
export { WorkBriefRepository, type BriefComposition } from './work-brief.repository';
export { WorkPreferencesRepository, type WorkPreferences, type EffectiveRetention } from './work-preferences.repository';
export { WorkDraftRepository, type DraftContent, type SendAttempt } from './work-draft.repository';
export { WorkFootprintRepository, type WorkFootprint } from './work-footprint.repository';
