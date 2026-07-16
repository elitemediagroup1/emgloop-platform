// VerifiedKnowledgeRepository — Verified Knowledge Service (kg.v1).
//
// Persistence for the DISTINCT verified knowledge graph (vk_* tables). This is
// NOT the embedding / RAG document store. Loop stores and RETURNS verified
// objects + metadata verbatim; the producer's KDP remains the delivery authority
// (Loop applies NO admission / freshness / ranking / conflict / safety filtering).
//
// Tenancy: every read and write is scoped by (platform, property [, organizationId]).
// Scope filters are applied at the query level (WHERE), never after loading, so a
// request can never observe another platform/property/organization's knowledge.
//
// Imports are idempotent on (platform, property, idempotencyKey): the batch is
// hashed; a repeat with the same key + same payload returns the prior result;
// a repeat with the same key + a DIFFERENT payload is a conflict. History is
// append-only: updating an entity/claim appends a new version and bumps the
// current-version pointer without destroying prior versions.

import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import type {
  KnowledgeScope,
  KnowledgeClaimObject,
  KnowledgeEntityObject,
  KnowledgeSourceObject,
  KnowledgeImportBatch,
  KnowledgeImportResultCounts,
} from '@emgloop/shared';
import { KNOWLEDGE_CONTRACT_VERSION } from '@emgloop/shared';

// Normalized internal scope (property defaults to platform).
interface Scope {
  platform: string;
  property: string;
  organizationId: string | null;
}

export interface ImportOutcome {
  result: KnowledgeImportResultCounts;
  duplicate: boolean;
}

function normScope(s: KnowledgeScope): Scope {
  const platform = (s.platform || '').trim();
  const property = (s.property && s.property.trim()) || platform;
  return { platform, property, organizationId: s.organizationId ?? null };
}

function scopeWhere(s: Scope) {
  // organizationId is part of the isolation boundary only when supplied by the
  // caller; when null we scope by (platform, property) alone. We never widen.
  return s.organizationId
    ? { platform: s.platform, property: s.property, organizationId: s.organizationId }
    : { platform: s.platform, property: s.property };
}

function toIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function parseDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

function hashBatch(batch: unknown): string {
  return createHash('sha256').update(JSON.stringify(batch)).digest('hex');
}

// Stable string[] type helper for Prisma JSON columns.
type Json = Record<string, unknown>;

export class VerifiedKnowledgeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ---- Reads --------------------------------------------------------------

  /** Sources linked to a target (entity/claim/relationship) within scope. */
  private async sourcesForTarget(
    s: Scope,
    targetType: 'entity' | 'claim' | 'relationship',
    targetKey: string,
  ): Promise<KnowledgeSourceObject[]> {
    const links = await this.prisma.verifiedKnowledgeProvenance.findMany({
      where: { ...scopeWhere(s), targetType, targetKey },
      include: { source: true },
    });
    return links.map((l) => this.sourceToObject(l.source));
  }

  private sourceToObject(src: {
    sourceKey: string; tier: number | null; kind: string | null; url: string | null;
    accessed: Date | null; quote: string | null; capturedBy: string | null;
  }): KnowledgeSourceObject {
    return {
      id: src.sourceKey,
      tier: src.tier,
      kind: src.kind,
      url: src.url,
      accessed: toIso(src.accessed),
      quote: src.quote,
      captured_by: src.capturedBy,
    };
  }

  private async claimToObject(s: Scope, claim: {
    claimKey: string; subject: string; predicate: string; value: unknown;
    confidence: string | null; verification: string | null; safetyCritical: boolean;
    validFrom: Date | null; validUntil: Date | null; expires: Date | null;
    reviewBy: Date | null; note: string | null; currentVersion: number;
  }): Promise<KnowledgeClaimObject> {
    return {
      id: claim.claimKey,
      subject: claim.subject,
      predicate: claim.predicate,
      value: claim.value,
      confidence: claim.confidence,
      verification: claim.verification,
      safety_critical: claim.safetyCritical,
      valid_from: toIso(claim.validFrom),
      valid_until: toIso(claim.validUntil),
      expires: toIso(claim.expires),
      review_by: toIso(claim.reviewBy),
      note: claim.note,
      version: claim.currentVersion,
      sources: await this.sourcesForTarget(s, 'claim', claim.claimKey),
    };
  }

  /** Query stored claims for a subject (+ optional predicate). No delivery filtering. */
  async queryClaims(
    scope: KnowledgeScope,
    subject: string,
    predicate?: string | null,
  ): Promise<KnowledgeClaimObject[]> {
    const s = normScope(scope);
    const rows = await this.prisma.verifiedKnowledgeClaim.findMany({
      where: { ...scopeWhere(s), subject, ...(predicate ? { predicate } : {}) },
      orderBy: { predicate: 'asc' },
    });
    return Promise.all(rows.map((r) => this.claimToObject(s, r)));
  }

  /** Single claim by stable key within scope, or null. */
  async getClaim(scope: KnowledgeScope, claimKey: string): Promise<KnowledgeClaimObject | null> {
    const s = normScope(scope);
    const row = await this.prisma.verifiedKnowledgeClaim.findFirst({
      where: { ...scopeWhere(s), claimKey },
    });
    return row ? this.claimToObject(s, row) : null;
  }

  /** Single entity by stable key within scope, or null. */
  async getEntity(scope: KnowledgeScope, entityKey: string): Promise<KnowledgeEntityObject | null> {
    const s = normScope(scope);
    const row = await this.prisma.verifiedKnowledgeEntity.findFirst({
      where: { ...scopeWhere(s), entityKey },
    });
    if (!row) return null;
    return {
      id: row.entityKey,
      type: row.type,
      name: row.name,
      aliases: row.aliases ?? [],
      status: row.status,
      confidence: row.confidence,
      verification: row.verification,
      safety_critical: row.safetyCritical,
      attributes: (row.attributes as Json) ?? {},
      sources: await this.sourcesForTarget(s, 'entity', row.entityKey),
    };
  }

  /** Scoped counts for health / verification. */
  async stats(scope: KnowledgeScope): Promise<{ entities: number; claims: number; relationships: number; sources: number }> {
    const s = normScope(scope);
    const where = scopeWhere(s);
    const [entities, claims, relationships, sources] = await Promise.all([
      this.prisma.verifiedKnowledgeEntity.count({ where }),
      this.prisma.verifiedKnowledgeClaim.count({ where }),
      this.prisma.verifiedKnowledgeRelationship.count({ where }),
      this.prisma.verifiedKnowledgeSource.count({ where }),
    ]);
    return { entities, claims, relationships, sources };
  }

  /** Readiness: confirm the vk_* schema is queryable. Throws if not. */
  async schemaReady(): Promise<boolean> {
    // A trivial scoped count proves the table + migration exist and Neon is reachable.
    await this.prisma.verifiedKnowledgeImportBatch.count({ where: { platform: '__readiness__' } });
    return true;
  }

  // ---- Import (idempotent, versioned, provenance-preserving) --------------

  /**
   * Apply one batch atomically inside a single Prisma transaction. Idempotent on
   * (platform, property, idempotencyKey). Returns { duplicate: true } with the
   * prior counts if the same key + identical payload was already applied; throws
   * IdempotencyConflict if the same key was used with a DIFFERENT payload.
   */
  async importBatch(
    scope: KnowledgeScope,
    idempotencyKey: string,
    batch: KnowledgeImportBatch,
    traceId?: string | null,
  ): Promise<ImportOutcome> {
    const s = normScope(scope);
    const payloadHash = hashBatch(batch);

    // Idempotency pre-check (outside the txn is fine: the unique index is the
    // race backstop and identical payloads converge to the same result).
    const prior = await this.prisma.verifiedKnowledgeImportBatch.findFirst({
      where: { platform: s.platform, property: s.property, idempotencyKey },
    });
    if (prior) {
      if (prior.payloadHash !== payloadHash) {
        const e = new Error('idempotency key reused with a different payload');
        (e as { code?: string }).code = 'IDEMPOTENCY_CONFLICT';
        throw e;
      }
      return {
        duplicate: true,
        result: { inserted: prior.inserted, updated: prior.updated, skipped: prior.skipped, failed: prior.failed },
      };
    }

    const counts: KnowledgeImportResultCounts = { inserted: 0, updated: 0, skipped: 0, failed: 0 };

    try {
      await this.prisma.$transaction(async (tx) => {
        // 1) Sources (upsert by scope+sourceKey).
        for (const src of batch.sources ?? []) {
          const existing = await tx.verifiedKnowledgeSource.findUnique({
            where: { platform_property_sourceKey: { platform: s.platform, property: s.property, sourceKey: src.id } },
          });
          const data = {
            platform: s.platform, property: s.property, organizationId: s.organizationId,
            sourceKey: src.id, tier: src.tier ?? null, kind: src.kind ?? null,
            url: src.url ?? null, accessed: parseDate(src.accessed), quote: src.quote ?? null,
            capturedBy: src.captured_by ?? null,
          };
          if (existing) { await tx.verifiedKnowledgeSource.update({ where: { id: existing.id }, data }); counts.updated++; }
          else { await tx.verifiedKnowledgeSource.create({ data }); counts.inserted++; }
        }

        // 2) Entities (append version on change; upsert current pointer).
        for (const ent of batch.entities ?? []) {
          const existing = await tx.verifiedKnowledgeEntity.findUnique({
            where: { platform_property_entityKey: { platform: s.platform, property: s.property, entityKey: ent.id } },
          });
          const shape = {
            type: ent.type, name: ent.name ?? null, aliases: ent.aliases ?? [],
            status: ent.status ?? null, confidence: (ent.confidence as string) ?? null,
            verification: (ent.verification as string) ?? null, safetyCritical: !!ent.safety_critical,
            attributes: (ent.attributes ?? {}) as object,
          };
          if (!existing) {
            const created = await tx.verifiedKnowledgeEntity.create({
              data: { platform: s.platform, property: s.property, organizationId: s.organizationId, entityKey: ent.id, currentVersion: 1, ...shape },
            });
            await tx.verifiedKnowledgeEntityVersion.create({ data: { entityId: created.id, version: 1, ...shape } });
            counts.inserted++;
          } else {
            const nextVersion = existing.currentVersion + 1;
            await tx.verifiedKnowledgeEntityVersion.create({ data: { entityId: existing.id, version: nextVersion, ...shape } });
            await tx.verifiedKnowledgeEntity.update({ where: { id: existing.id }, data: { currentVersion: nextVersion, ...shape } });
            counts.updated++;
          }
        }

        // 3) Claims (append version on change; upsert current pointer).
        for (const clm of batch.claims ?? []) {
          const existing = await tx.verifiedKnowledgeClaim.findUnique({
            where: { platform_property_claimKey: { platform: s.platform, property: s.property, claimKey: clm.id } },
          });
          const shape = {
            subject: clm.subject, predicate: clm.predicate, value: (clm.value ?? {}) as object,
            confidence: (clm.confidence as string) ?? null, verification: (clm.verification as string) ?? null,
            safetyCritical: !!clm.safety_critical, validFrom: parseDate(clm.valid_from),
            validUntil: parseDate(clm.valid_until), expires: parseDate(clm.expires),
            reviewBy: parseDate(clm.review_by), note: clm.note ?? null,
          };
          if (!existing) {
            const created = await tx.verifiedKnowledgeClaim.create({
              data: { platform: s.platform, property: s.property, organizationId: s.organizationId, claimKey: clm.id, currentVersion: 1, ...shape },
            });
            await tx.verifiedKnowledgeClaimVersion.create({ data: { claimId: created.id, version: 1, ...shape } });
            counts.inserted++;
          } else {
            const nextVersion = existing.currentVersion + 1;
            await tx.verifiedKnowledgeClaimVersion.create({ data: { claimId: existing.id, version: nextVersion, ...shape } });
            await tx.verifiedKnowledgeClaim.update({ where: { id: existing.id }, data: { currentVersion: nextVersion, ...shape } });
            counts.updated++;
          }
        }

        // 4) Relationships (upsert by scope+edgeKey; append version pointer).
        for (const rel of batch.relationships ?? []) {
          const edgeKey = (rel as { edge: string; from: string; to: string }).edge + ':' + rel.from + ':' + rel.to;
          const existing = await tx.verifiedKnowledgeRelationship.findUnique({
            where: { platform_property_edgeKey: { platform: s.platform, property: s.property, edgeKey } },
          });
          const data = {
            platform: s.platform, property: s.property, organizationId: s.organizationId, edgeKey,
            edge: rel.edge, fromKey: rel.from, toKey: rel.to, confidence: (rel.confidence as string) ?? null,
          };
          if (existing) {
            await tx.verifiedKnowledgeRelationship.update({ where: { id: existing.id }, data: { ...data, currentVersion: existing.currentVersion + 1 } });
            counts.updated++;
          } else {
            await tx.verifiedKnowledgeRelationship.create({ data });
            counts.inserted++;
          }
        }

        // 5) Provenance links (source -> target). Idempotent on the unique index.
        const provLinks: Array<{ sourceId: string; targetType: string; targetKey: string }> = [
          ...((batch.entity_sources ?? []).map((l) => ({ sourceId: l.sourceId, targetType: 'entity', targetKey: l.entityId }))),
          ...((batch.claim_sources ?? []).map((l) => ({ sourceId: l.sourceId, targetType: 'claim', targetKey: l.claimId }))),
        ];
        for (const link of provLinks) {
          const src = await tx.verifiedKnowledgeSource.findUnique({
            where: { platform_property_sourceKey: { platform: s.platform, property: s.property, sourceKey: link.sourceId } },
          });
          if (!src) { counts.failed++; throw new Error('provenance references unknown source: ' + link.sourceId); }
          const existing = await tx.verifiedKnowledgeProvenance.findUnique({
            where: { sourceId_targetType_targetKey: { sourceId: src.id, targetType: link.targetType, targetKey: link.targetKey } },
          });
          if (existing) { counts.skipped++; }
          else {
            await tx.verifiedKnowledgeProvenance.create({
              data: { platform: s.platform, property: s.property, organizationId: s.organizationId, sourceId: src.id, targetType: link.targetType, targetKey: link.targetKey },
            });
          }
        }

        // 6) Record the import batch (idempotency + audit) inside the same txn.
        await tx.verifiedKnowledgeImportBatch.create({
          data: {
            platform: s.platform, property: s.property, organizationId: s.organizationId,
            idempotencyKey, contractVersion: batch.contract_version || KNOWLEDGE_CONTRACT_VERSION,
            payloadHash, status: 'completed',
            inserted: counts.inserted, updated: counts.updated, skipped: counts.skipped, failed: counts.failed,
            traceId: traceId ?? null,
          },
        });
      });
    } catch (err: unknown) {
      // Unique-race on the idempotency key: another identical request won. Return
      // that prior result as a duplicate rather than an error.
      if ((err as { code?: string }).code === 'P2002') {
        const won = await this.prisma.verifiedKnowledgeImportBatch.findFirst({
          where: { platform: s.platform, property: s.property, idempotencyKey },
        });
        if (won && won.payloadHash === payloadHash) {
          return { duplicate: true, result: { inserted: won.inserted, updated: won.updated, skipped: won.skipped, failed: won.failed } };
        }
      }
      throw err;
    }

    return { duplicate: false, result: counts };
  }
}
