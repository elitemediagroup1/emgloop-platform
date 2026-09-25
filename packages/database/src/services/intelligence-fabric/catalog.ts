// The catalog of intelligence producers the code knows. Loop Intelligence PR 2 (the fabric), 2026-09-26.
//
// Metadata only -- id, domain, scope, kind, task -- so a surface (the intelligence status page) can say
// which producers exist without importing a producer or reading any activation. Activation is the
// worker's (LOOP_INTELLIGENCE_PRODUCERS); a producer listed here but not activated never runs.
//
// PR 2 ships the fabric and NO domain producer, so the catalog is empty.

import type { IntelligenceDomain, IntelligenceSubjectKind } from '@emgloop/shared';

export interface IntelligenceProducerDescriptor {
  readonly id: string;
  readonly domain: IntelligenceDomain;
  readonly scope: 'PRINCIPAL' | 'ORGANIZATION';
  readonly subjectKinds: readonly IntelligenceSubjectKind[];
  readonly kind: 'RULE' | 'MODEL' | 'RULE_AND_MODEL';
  readonly taskId: string | null;
}

export const INTELLIGENCE_PRODUCER_CATALOG: readonly IntelligenceProducerDescriptor[] = Object.freeze([]);
