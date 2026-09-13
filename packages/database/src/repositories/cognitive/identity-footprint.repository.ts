// Identity footprint -- CRM Phase Zero P0.2d, the read that must come first.
//
// COUNTS ONLY, ONE ORGANIZATION, WRITES NOTHING. Canonical Party schema alignment
// changes `cognitive_identities` -- a new uniqueness without `entityType`, and
// supersession columns. A constraint that assumes the dormant table is empty is a
// guess; this read replaces the guess with what is actually there: how many
// identity rows exist and of what type, how many would collide under
// (organizationId, canonicalKey), what satellites and cognitive records point at
// them, and whether any of those references resolve to no identity in the
// organization.
//
// No id, key, name, hash or value leaves this file -- every row is reduced to a
// count before it is returned.
//
// BOUNDED. Distinct-reference and duplicate-key questions need the ids in memory.
// Past `FOOTPRINT_ROW_BOUND` rows those answers are `null` -- UNKNOWN, reported as
// such -- rather than a partial number that looks like a whole one.

import {
  CognitiveEntityType,
  CognitiveIdentityStatus,
  IdentityEvidenceType,
  IdentityResolutionMethod,
  IdentityResolutionStatus,
} from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

export const FOOTPRINT_ROW_BOUND = 50_000;

/** The entity types the Party contract admits. Mirrors `@emgloop/shared` PARTY_TYPES. */
const PARTY_ENTITY_TYPES: readonly CognitiveEntityType[] = ['PERSON', 'COMPANY'];

export interface IdentityFootprint {
  identities: {
    total: number;
    partyTyped: number;
    archived: number;
    byEntityType: Record<CognitiveEntityType, number>;
    byStatus: Record<CognitiveIdentityStatus, number>;
    /** Canonical keys held by more than one row -- what a (organizationId, canonicalKey) unique would reject. */
    duplicateKeyGroups: number | null;
    duplicateKeyRows: number | null;
  };
  satellites: {
    roles: number;
    evidence: number;
    revokedEvidence: number;
    evidenceByType: Record<IdentityEvidenceType, number>;
    resolutionLinks: number;
    linksByStatus: Record<IdentityResolutionStatus, number>;
    linksByMethod: Record<IdentityResolutionMethod, number>;
    relationships: number;
  };
  references: {
    memoryEventsWithIdentity: number;
    knowledgeAssertions: number;
    activeStateRecords: number;
    outboxWithIdentity: number;
    hypothesesWithSubject: number;
    decisionsWithSubject: number;
  };
  /** Distinct identity ids referenced in this organization that resolve to no identity in it. */
  unresolvedReferences: number | null;
  /** True when any bounded answer above is UNKNOWN. */
  exceededBound: boolean;
}

type CountDelegate = { count(args: { where: Record<string, unknown> }): Promise<number> };

async function countBy<T extends string>(
  delegate: CountDelegate,
  organizationId: string,
  field: string,
  values: readonly T[],
): Promise<Record<T, number>> {
  const counts = await Promise.all(values.map((v) => delegate.count({ where: { organizationId, [field]: v } })));
  return Object.fromEntries(values.map((v, i) => [v, counts[i]!])) as Record<T, number>;
}

export class IdentityFootprintRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async footprint(organizationId: string): Promise<IdentityFootprint> {
    const p = this.prisma;
    const org = { organizationId };
    let exceededBound = false;

    const [total, archived, partyTyped, byEntityType, byStatus] = await Promise.all([
      p.cognitiveIdentity.count({ where: org }),
      p.cognitiveIdentity.count({ where: { ...org, archivedAt: { not: null } } }),
      p.cognitiveIdentity.count({ where: { ...org, entityType: { in: [...PARTY_ENTITY_TYPES] } } }),
      countBy(p.cognitiveIdentity, organizationId, 'entityType', Object.values(CognitiveEntityType)),
      countBy(p.cognitiveIdentity, organizationId, 'status', Object.values(CognitiveIdentityStatus)),
    ]);

    const [roles, evidence, revokedEvidence, evidenceByType, resolutionLinks, linksByStatus, linksByMethod, relationships] =
      await Promise.all([
        p.identityRole.count({ where: org }),
        p.identityEvidence.count({ where: org }),
        p.identityEvidence.count({ where: { ...org, revokedAt: { not: null } } }),
        countBy(p.identityEvidence, organizationId, 'evidenceType', Object.values(IdentityEvidenceType)),
        p.identityResolutionLink.count({ where: org }),
        countBy(p.identityResolutionLink, organizationId, 'status', Object.values(IdentityResolutionStatus)),
        countBy(p.identityResolutionLink, organizationId, 'method', Object.values(IdentityResolutionMethod)),
        p.identityRelationship.count({ where: org }),
      ]);

    const [memoryEventsWithIdentity, knowledgeAssertions, activeStateRecords, outboxWithIdentity, hypothesesWithSubject, decisionsWithSubject] =
      await Promise.all([
        p.memoryEvent.count({
          where: {
            ...org,
            OR: [{ actorIdentityId: { not: null } }, { subjectIdentityId: { not: null } }, { objectIdentityId: { not: null } }],
          },
        }),
        p.knowledgeAssertion.count({ where: org }),
        p.activeStateRecord.count({ where: org }),
        p.stateChangeOutbox.count({ where: { ...org, identityId: { not: null } } }),
        p.intelligenceHypothesis.count({ where: { ...org, subjectIdentityId: { not: null } } }),
        p.cognitiveDecision.count({ where: { ...org, subjectIdentityId: { not: null } } }),
      ]);

    // ---- Bounded questions: duplicate keys and unresolved references --------
    let duplicateKeyGroups: number | null = null;
    let duplicateKeyRows: number | null = null;
    const identityRows = await p.cognitiveIdentity.findMany({
      where: org,
      select: { id: true, canonicalKey: true },
      take: FOOTPRINT_ROW_BOUND + 1,
    });
    const identitiesBounded = identityRows.length <= FOOTPRINT_ROW_BOUND;
    if (identitiesBounded) {
      const perKey = new Map<string, number>();
      for (const r of identityRows) perKey.set(r.canonicalKey, (perKey.get(r.canonicalKey) ?? 0) + 1);
      const dup = [...perKey.values()].filter((n) => n > 1);
      duplicateKeyGroups = dup.length;
      duplicateKeyRows = dup.reduce((a, n) => a + n, 0);
    } else {
      exceededBound = true;
    }

    const referenced = new Set<string>();
    let referencesBounded = true;
    const collect = async (rows: Array<Record<string, string | null>>, field: string) => {
      if (rows.length > FOOTPRINT_ROW_BOUND) referencesBounded = false;
      for (const r of rows) {
        const v = r[field];
        if (typeof v === 'string') referenced.add(v);
      }
    };
    const distinct = (delegate: any, field: string, required: boolean) =>
      delegate.findMany({
        where: required ? org : { ...org, [field]: { not: null } },
        select: { [field]: true },
        distinct: [field],
        take: FOOTPRINT_ROW_BOUND + 1,
      }) as Promise<Array<Record<string, string | null>>>;

    const sources: Array<[any, string, boolean]> = [
      [p.identityRole, 'identityId', true],
      [p.identityEvidence, 'identityId', true],
      [p.identityResolutionLink, 'sourceIdentityId', true],
      [p.identityResolutionLink, 'targetIdentityId', true],
      [p.identityRelationship, 'fromIdentityId', true],
      [p.identityRelationship, 'toIdentityId', true],
      [p.memoryEvent, 'actorIdentityId', false],
      [p.memoryEvent, 'subjectIdentityId', false],
      [p.memoryEvent, 'objectIdentityId', false],
      [p.knowledgeAssertion, 'subjectIdentityId', true],
      [p.knowledgeAssertion, 'sourceIdentityId', false],
      [p.knowledgeAssertion, 'ownerIdentityId', false],
      [p.activeStateRecord, 'identityId', true],
      [p.stateChangeOutbox, 'identityId', false],
      [p.intelligenceHypothesis, 'subjectIdentityId', false],
      [p.cognitiveDecision, 'subjectIdentityId', false],
    ];
    for (const [delegate, field, required] of sources) {
      await collect(await distinct(delegate, field, required), field);
    }

    let unresolvedReferences: number | null = null;
    if (identitiesBounded && referencesBounded && referenced.size <= FOOTPRINT_ROW_BOUND) {
      const known = new Set(identityRows.map((r) => r.id));
      unresolvedReferences = [...referenced].filter((id) => !known.has(id)).length;
    } else {
      exceededBound = true;
    }

    return {
      identities: { total, partyTyped, archived, byEntityType, byStatus, duplicateKeyGroups, duplicateKeyRows },
      satellites: { roles, evidence, revokedEvidence, evidenceByType, resolutionLinks, linksByStatus, linksByMethod, relationships },
      references: {
        memoryEventsWithIdentity,
        knowledgeAssertions,
        activeStateRecords,
        outboxWithIdentity,
        hypothesesWithSubject,
        decisionsWithSubject,
      },
      unresolvedReferences,
      exceededBound,
    };
  }
}
