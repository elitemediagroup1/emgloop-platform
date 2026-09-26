// The catalog of intelligence producers the code knows. Loop Intelligence PR 2 (the fabric), 2026-09-26.
//
// Metadata only -- id, domain, scope, kind, task -- so a surface (the intelligence status page) can say
// which producers exist without importing a producer or reading any activation. Activation is the
// worker's (LOOP_INTELLIGENCE_PRODUCERS); a producer listed here but not activated never runs.
//
// Phase E: every domain producer. A test holds this list equal to what `loopProducers` assembles.

import type { IntelligenceDomain, IntelligenceSubjectKind } from '@emgloop/shared';

export interface IntelligenceProducerDescriptor {
  readonly id: string;
  readonly domain: IntelligenceDomain;
  readonly scope: 'PRINCIPAL' | 'ORGANIZATION';
  readonly subjectKinds: readonly IntelligenceSubjectKind[];
  readonly kind: 'RULE' | 'MODEL' | 'RULE_AND_MODEL';
  readonly taskId: string | null;
}

const d = (id: string, domain: IntelligenceDomain, scope: 'PRINCIPAL' | 'ORGANIZATION', taskId: string | null, subjectKinds: readonly IntelligenceSubjectKind[] = ['DOMAIN'], kind?: 'MODEL'): IntelligenceProducerDescriptor =>
  Object.freeze({ id, domain, scope, subjectKinds, kind: kind ?? (taskId ? ('RULE_AND_MODEL' as const) : ('RULE' as const)), taskId });

export const INTELLIGENCE_PRODUCER_CATALOG: readonly IntelligenceProducerDescriptor[] = Object.freeze([
  d('calendar.domain@1', 'CALENDAR', 'PRINCIPAL', 'calendar.domain.reading'),
  d('callgrid.domain@1', 'CALLGRID', 'ORGANIZATION', 'callgrid.domain.reading'),
  d('campaigns.domain@1', 'CAMPAIGNS', 'ORGANIZATION', 'campaigns.domain.reading'),
  d('pipeline.domain@1', 'PIPELINE', 'ORGANIZATION', 'pipeline.domain.reading'),
  d('crm.domain@1', 'CRM', 'ORGANIZATION', 'crm.domain.reading'),
  d('creators.domain@1', 'CREATORS', 'ORGANIZATION', 'creators.domain.reading'),
  d('work.domain@1', 'WORK', 'ORGANIZATION', 'work.domain.reading'),
  d('work.mine@1', 'WORK', 'PRINCIPAL', null),
  d('website.domain@1', 'WEBSITE', 'ORGANIZATION', 'website.domain.reading'),
  // Mail: hosted where the person's Gmail can be read through (the runner), and gated on the governance decision.
  d('mail.thread@1', 'MAIL', 'PRINCIPAL', 'mail.content.triage', ['THREAD'], 'MODEL'),
  d('mail.domain@1', 'MAIL', 'PRINCIPAL', 'mail.domain.reading'),
]);
