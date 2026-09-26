// ENTITY LINKS: explicit, governed relationships between canonical entity references. Loop Intelligence
// PR 2 (the fabric), 2026-09-26. Migration 20261006000001_entity_links.
//
// WHAT A LINK IS. "This CallGrid buyer IS this Party" (SAME_AS), "this page is PART_OF this web property",
// "this market is LOCATED_IN that one", "this creator REPRESENTS this brand relationship". Intelligence
// uses links to see that two references name one business thing. A link merges nothing and changes no
// entity: identity resolution keeps its own authority over Parties.
//
// NEVER A MODEL'S GUESS. The basis is HUMAN_DECLARED (a person said so; who is recorded), RULE (a
// deterministic rule over Loop records; the rule id is the source) or IMPORTED (an import from a
// governed source). There is no MODEL basis, and nothing here does fuzzy matching.
//
// SCOPED LIKE DIGESTS, AND THE UNSAFE CALL IS NOT EXPRESSIBLE. A PRINCIPAL link is one person's and may
// name their private evidence (a conversation key); an ORGANIZATION link names nobody and may not
// reference a principal-only kind. Reads for a principal return that person's own links plus the
// organization's; reads for the organization return organization links only. Nobody reads another
// person's links. Cross-organization is not-found.
//
// REVERSAL IS A STAMP. `reverse` sets reversedAt/By; the row stays, so what Loop believed when remains
// readable, and a new active link for the same triple can then be declared.
//
// MERGE-SAFE: every method probes `entityLinksPresent` first and answers NOT_MIGRATED / empty before the
// migration has run.

import type { Prisma, PrismaClient } from '@prisma/client';
import { entityRefRefusal } from '@emgloop/shared';

import { membershipAuthority } from '../membership.repository';
import { workScope, type WorkPrincipal } from '../work-state/work-principal';
import { entityLinksPresent } from './intelligence-fabric-presence';

export const ENTITY_LINK_RELATIONS = ['SAME_AS', 'PART_OF', 'LOCATED_IN', 'REPRESENTS'] as const;
export type EntityLinkRelation = (typeof ENTITY_LINK_RELATIONS)[number];

export const ENTITY_LINK_BASES = ['HUMAN_DECLARED', 'RULE', 'IMPORTED'] as const;
export type EntityLinkBasis = (typeof ENTITY_LINK_BASES)[number];

export type EntityLinkOwner =
  | { readonly scope: 'PRINCIPAL'; readonly principal: WorkPrincipal }
  | { readonly scope: 'ORGANIZATION'; readonly organizationId: string };

export interface EntityLinkDeclaration {
  readonly fromRef: string;
  readonly toRef: string;
  readonly relation: EntityLinkRelation;
  readonly basis: EntityLinkBasis;
  /** A registry source id or a rule id: what established the link. */
  readonly source: string;
  readonly sourceRef?: string | null;
  /** Required for HUMAN_DECLARED, from the signed session. */
  readonly declaredByUserId?: string | null;
  readonly effectiveFrom: Date;
}

export interface EntityLinkRecord {
  readonly id: string;
  readonly scope: 'PRINCIPAL' | 'ORGANIZATION';
  readonly fromRef: string;
  readonly toRef: string;
  readonly relation: EntityLinkRelation;
  readonly basis: EntityLinkBasis;
  readonly source: string;
  readonly sourceRef: string | null;
  readonly effectiveFrom: Date;
  readonly reversedAt: Date | null;
}

export const ENTITY_LINK_REFUSALS = ['INVALID_INPUT', 'BAD_REF', 'PRIVATE_REF_IN_ORGANIZATION', 'SELF_LINK', 'NOT_AN_ACTIVE_MEMBER', 'ALREADY_LINKED', 'NOT_FOUND', 'NOT_MIGRATED'] as const;
export type EntityLinkRefusal = (typeof ENTITY_LINK_REFUSALS)[number];

export type EntityLinkOutcome = { readonly outcome: 'LINKED' | 'REVERSED'; readonly link: EntityLinkRecord } | { readonly outcome: 'REFUSED'; readonly refusal: EntityLinkRefusal };

const SOURCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const LINK_SELECT = Object.freeze({
  id: true,
  scope: true,
  fromRef: true,
  toRef: true,
  relation: true,
  basis: true,
  source: true,
  sourceRef: true,
  effectiveFrom: true,
  reversedAt: true,
} as const);
const READ_LIMIT_MAX = 200;

type Db = PrismaClient;

function recordOf(row: Prisma.EntityLinkGetPayload<{ select: typeof LINK_SELECT }>): EntityLinkRecord {
  return {
    id: row.id,
    scope: row.scope === 'ORGANIZATION' ? 'ORGANIZATION' : 'PRINCIPAL',
    fromRef: row.fromRef,
    toRef: row.toRef,
    relation: row.relation as EntityLinkRelation,
    basis: row.basis as EntityLinkBasis,
    source: row.source,
    sourceRef: row.sourceRef ?? null,
    effectiveFrom: row.effectiveFrom,
    reversedAt: row.reversedAt ?? null,
  };
}

function ownerWhere(owner: EntityLinkOwner) {
  return owner.scope === 'PRINCIPAL' ? { ...workScope(owner.principal), scope: 'PRINCIPAL' } : { organizationId: owner.organizationId, scope: 'ORGANIZATION', userId: null };
}

/** Everything wrong with a declaration for this owner, before the database is asked. */
export function entityLinkDeclarationRefusal(owner: EntityLinkOwner, d: EntityLinkDeclaration): EntityLinkRefusal | null {
  if (!(ENTITY_LINK_RELATIONS as readonly string[]).includes(d.relation)) return 'INVALID_INPUT';
  if (!(ENTITY_LINK_BASES as readonly string[]).includes(d.basis)) return 'INVALID_INPUT';
  if (typeof d.source !== 'string' || !SOURCE.test(d.source)) return 'INVALID_INPUT';
  if (d.sourceRef != null && (typeof d.sourceRef !== 'string' || d.sourceRef.length < 1 || d.sourceRef.length > 256)) return 'INVALID_INPUT';
  if (!(d.effectiveFrom instanceof Date) || Number.isNaN(d.effectiveFrom.getTime())) return 'INVALID_INPUT';
  if (d.basis === 'HUMAN_DECLARED' && !d.declaredByUserId) return 'INVALID_INPUT';
  if (d.fromRef === d.toRef) return 'SELF_LINK';
  for (const ref of [d.fromRef, d.toRef]) {
    const refusal = entityRefRefusal(ref, owner.scope);
    if (refusal === 'PRINCIPAL_ONLY_KIND') return 'PRIVATE_REF_IN_ORGANIZATION';
    if (refusal) return 'BAD_REF';
  }
  return null;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown })?.code === 'P2002';
}

export class EntityLinkRepository {
  constructor(private readonly db: Db) {}

  /** Declare an active link. One active link per (owner, from, relation, to): a second is ALREADY_LINKED. */
  async declare(owner: EntityLinkOwner, declaration: EntityLinkDeclaration): Promise<EntityLinkOutcome> {
    const refusal = entityLinkDeclarationRefusal(owner, declaration);
    if (refusal) return { outcome: 'REFUSED', refusal };
    if (!(await entityLinksPresent(this.db))) return { outcome: 'REFUSED', refusal: 'NOT_MIGRATED' };
    const where = ownerWhere(owner);
    try {
      return await this.db.$transaction(async (tx) => {
        if (owner.scope === 'PRINCIPAL') {
          const standing = await membershipAuthority(tx, owner.principal.organizationId, owner.principal.userId, declaration.effectiveFrom);
          if (!standing.granted) return { outcome: 'REFUSED' as const, refusal: 'NOT_AN_ACTIVE_MEMBER' as const };
        }
        const existing = await tx.entityLink.findFirst({
          where: { ...where, fromRef: declaration.fromRef, relation: declaration.relation, toRef: declaration.toRef, reversedAt: null },
          select: { id: true },
        });
        if (existing) return { outcome: 'REFUSED' as const, refusal: 'ALREADY_LINKED' as const };
        const created = await tx.entityLink.create({
          data: {
            ...where,
            fromRef: declaration.fromRef,
            toRef: declaration.toRef,
            relation: declaration.relation,
            basis: declaration.basis,
            source: declaration.source,
            sourceRef: declaration.sourceRef ?? null,
            declaredByUserId: declaration.declaredByUserId ?? null,
            effectiveFrom: declaration.effectiveFrom,
          },
          select: LINK_SELECT,
        });
        return { outcome: 'LINKED' as const, link: recordOf(created) };
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { outcome: 'REFUSED', refusal: 'ALREADY_LINKED' };
      throw err;
    }
  }

  /** Reverse an active link this owner holds. Another owner's link is NOT_FOUND. */
  async reverse(owner: EntityLinkOwner, linkId: string, by: { readonly userId: string | null; readonly at: Date }): Promise<EntityLinkOutcome> {
    if (!linkId) return { outcome: 'REFUSED', refusal: 'NOT_FOUND' };
    if (!(await entityLinksPresent(this.db))) return { outcome: 'REFUSED', refusal: 'NOT_MIGRATED' };
    const where = ownerWhere(owner);
    const { count } = await this.db.entityLink.updateMany({
      where: { ...where, id: linkId, reversedAt: null, effectiveFrom: { lte: by.at } },
      data: { reversedAt: by.at, reversedByUserId: by.userId },
    });
    if (count === 0) return { outcome: 'REFUSED', refusal: 'NOT_FOUND' };
    const row = await this.db.entityLink.findFirst({ where: { ...where, id: linkId }, select: LINK_SELECT });
    return row ? { outcome: 'REVERSED', link: recordOf(row) } : { outcome: 'REFUSED', refusal: 'NOT_FOUND' };
  }

  /**
   * The ACTIVE links touching any of `refs`, as this owner may see them: a PRINCIPAL sees their own
   * links and the organization's; the ORGANIZATION sees its own only. Bounded.
   */
  async linksFor(owner: EntityLinkOwner, refs: readonly string[], options: { readonly limit?: number } = {}): Promise<EntityLinkRecord[]> {
    const wanted = [...new Set(refs)].filter((r) => entityRefRefusal(r, owner.scope) === null).slice(0, 64);
    if (wanted.length === 0) return [];
    if (!(await entityLinksPresent(this.db))) return [];
    const visible =
      owner.scope === 'PRINCIPAL'
        ? { OR: [ownerWhere(owner), { organizationId: owner.principal.organizationId, scope: 'ORGANIZATION', userId: null }] }
        : ownerWhere(owner);
    const rows = await this.db.entityLink.findMany({
      where: { AND: [visible, { reversedAt: null }, { OR: [{ fromRef: { in: wanted } }, { toRef: { in: wanted } }] }] },
      orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
      take: Math.max(1, Math.min(options.limit ?? 100, READ_LIMIT_MAX)),
      select: LINK_SELECT,
    });
    return rows.map(recordOf);
  }
}
