// Cognitive identity repositories — Loop Cognitive Architecture (Increment 1).
//
// WHO/WHAT (CognitiveIdentity), in WHAT CAPACITY (IdentityRole), with WHAT
// supporting EVIDENCE (IdentityEvidence), linked reversibly to other identities
// (IdentityResolutionLink), and RELATED to others (IdentityRelationship).
//
// Tenancy discipline (non-negotiable): organizationId is ALWAYS the first
// argument and ALWAYS comes from authenticated server context — never from a
// client payload. Every read/mutation resolves the row WITHIN the organization
// first (findFirst({ where: { id, organizationId } })) and fails closed to
// null. Cross-org access is not-found, never a leak of another tenant's row.

import type {
  PrismaClient,
  CognitiveIdentity,
  IdentityRole,
  IdentityEvidence,
  IdentityResolutionLink,
  IdentityRelationship,
  CognitiveEntityType,
  CognitiveIdentityStatus,
  IdentityRoleType,
  IdentityEvidenceType,
  IdentityResolutionMethod,
  IdentityRelationshipType,
  ConsentBasis,
  DataPurpose,
  Prisma,
} from '@prisma/client';
import { hashIdentifier } from './hashing';

const DEFAULT_TAKE = 50;
const MAX_TAKE = 200;

function boundTake(take?: number): number {
  return Math.min(MAX_TAKE, Math.max(1, take ?? DEFAULT_TAKE));
}

// ---------------------------------------------------------------------------
// CognitiveIdentity
// ---------------------------------------------------------------------------

export interface CreateIdentityInput {
  entityType: CognitiveEntityType;
  canonicalKey: string;
  displayName?: string | null;
  status?: CognitiveIdentityStatus;
  metadata?: Record<string, unknown>;
}

export class CognitiveIdentityRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(organizationId: string, input: CreateIdentityInput): Promise<CognitiveIdentity> {
    return this.prisma.cognitiveIdentity.create({
      data: {
        organizationId,
        entityType: input.entityType,
        canonicalKey: input.canonicalKey,
        displayName: input.displayName ?? null,
        status: input.status ?? 'ANONYMOUS',
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  /** Resolve within org, fail closed to null. Cross-org id → null. */
  findById(organizationId: string, id: string): Promise<CognitiveIdentity | null> {
    return this.prisma.cognitiveIdentity.findFirst({ where: { id, organizationId } });
  }

  findByCanonicalKey(
    organizationId: string,
    entityType: CognitiveEntityType,
    canonicalKey: string,
  ): Promise<CognitiveIdentity | null> {
    return this.prisma.cognitiveIdentity.findFirst({
      where: { organizationId, entityType, canonicalKey },
    });
  }

  /**
   * Idempotent resolve-or-create by the (org, entityType, canonicalKey) unique.
   * The processor's terminal fallback when no evidence resolves an existing
   * identity — creates an ANONYMOUS identity by default.
   */
  async resolveOrCreate(
    organizationId: string,
    input: CreateIdentityInput,
  ): Promise<CognitiveIdentity> {
    const existing = await this.findByCanonicalKey(
      organizationId,
      input.entityType,
      input.canonicalKey,
    );
    if (existing) return existing;
    return this.create(organizationId, input);
  }

  /** Update a scalar subset; resolves within org first, returns null if absent. */
  async update(
    organizationId: string,
    id: string,
    fields: Partial<Pick<CognitiveIdentity, 'displayName' | 'status'>> & {
      metadata?: Record<string, unknown>;
    },
  ): Promise<CognitiveIdentity | null> {
    const found = await this.findById(organizationId, id);
    if (!found) return null;
    return this.prisma.cognitiveIdentity.update({
      where: { id: found.id },
      data: {
        ...(fields.displayName !== undefined ? { displayName: fields.displayName } : {}),
        ...(fields.status !== undefined ? { status: fields.status } : {}),
        ...(fields.metadata !== undefined
          ? { metadata: fields.metadata as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  async archive(organizationId: string, id: string): Promise<CognitiveIdentity | null> {
    const found = await this.findById(organizationId, id);
    if (!found) return null;
    return this.prisma.cognitiveIdentity.update({
      where: { id: found.id },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
  }

  list(
    organizationId: string,
    opts: { entityType?: CognitiveEntityType; status?: CognitiveIdentityStatus; take?: number } = {},
  ): Promise<CognitiveIdentity[]> {
    return this.prisma.cognitiveIdentity.findMany({
      where: {
        organizationId,
        ...(opts.entityType ? { entityType: opts.entityType } : {}),
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: boundTake(opts.take),
    });
  }
}

// ---------------------------------------------------------------------------
// IdentityRole — multiple overlapping roles per identity are allowed.
// ---------------------------------------------------------------------------

export interface AddRoleInput {
  identityId: string;
  roleType: IdentityRoleType;
  sourceEventId?: string | null;
  effectiveFrom?: Date;
  metadata?: Record<string, unknown>;
}

export class IdentityRoleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Add a role. Roles may overlap: assigning CONSUMER does not deactivate an
   * existing LEAD, and never mutates the identity's entity type. Idempotent on
   * an already-ACTIVE role of the same type (returns the existing row).
   */
  async addRole(organizationId: string, input: AddRoleInput): Promise<IdentityRole> {
    const active = await this.prisma.identityRole.findFirst({
      where: {
        organizationId,
        identityId: input.identityId,
        roleType: input.roleType,
        status: 'ACTIVE',
      },
    });
    if (active) return active;
    return this.prisma.identityRole.create({
      data: {
        organizationId,
        identityId: input.identityId,
        roleType: input.roleType,
        status: 'ACTIVE',
        sourceEventId: input.sourceEventId ?? null,
        effectiveFrom: input.effectiveFrom ?? new Date(),
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async deactivateRole(organizationId: string, id: string): Promise<IdentityRole | null> {
    const found = await this.prisma.identityRole.findFirst({ where: { id, organizationId } });
    if (!found) return null;
    return this.prisma.identityRole.update({
      where: { id: found.id },
      data: { status: 'INACTIVE', effectiveTo: new Date() },
    });
  }

  listForIdentity(
    organizationId: string,
    identityId: string,
    opts: { activeOnly?: boolean } = {},
  ): Promise<IdentityRole[]> {
    return this.prisma.identityRole.findMany({
      where: {
        organizationId,
        identityId,
        ...(opts.activeOnly ? { status: 'ACTIVE' } : {}),
      },
      orderBy: { effectiveFrom: 'desc' },
    });
  }
}

// ---------------------------------------------------------------------------
// IdentityEvidence — raw identifiers are hashed, never stored.
// ---------------------------------------------------------------------------

export interface RecordEvidenceInput {
  identityId: string;
  evidenceType: IdentityEvidenceType;
  /** Raw value (email/phone/etc). Hashed on the way in; never persisted raw. */
  rawValue: string;
  source?: string | null;
  confidence?: number | null;
  consentBasis?: ConsentBasis;
  permittedPurposes?: DataPurpose[];
  observedAt?: Date;
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export class IdentityEvidenceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  record(organizationId: string, input: RecordEvidenceInput): Promise<IdentityEvidence> {
    const normalizedValueHash = hashIdentifier(organizationId, input.evidenceType, input.rawValue);
    return this.prisma.identityEvidence.create({
      data: {
        organizationId,
        identityId: input.identityId,
        evidenceType: input.evidenceType,
        normalizedValueHash,
        source: input.source ?? null,
        confidence: input.confidence ?? null,
        consentBasis: input.consentBasis ?? 'NONE',
        permittedPurposes: input.permittedPurposes ?? [],
        observedAt: input.observedAt ?? new Date(),
        expiresAt: input.expiresAt ?? null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Resolve an identity by a re-derived evidence hash, scoped to the org. Only
   * non-revoked, non-expired evidence resolves. Returns the identityId or null.
   */
  async findIdentityIdByValue(
    organizationId: string,
    evidenceType: IdentityEvidenceType,
    rawValue: string,
    now: Date = new Date(),
  ): Promise<string | null> {
    const normalizedValueHash = hashIdentifier(organizationId, evidenceType, rawValue);
    const row = await this.prisma.identityEvidence.findFirst({
      where: {
        organizationId,
        evidenceType,
        normalizedValueHash,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { observedAt: 'desc' },
    });
    return row?.identityId ?? null;
  }

  async revoke(organizationId: string, id: string): Promise<IdentityEvidence | null> {
    const found = await this.prisma.identityEvidence.findFirst({ where: { id, organizationId } });
    if (!found) return null;
    return this.prisma.identityEvidence.update({
      where: { id: found.id },
      data: { revokedAt: new Date() },
    });
  }

  listForIdentity(organizationId: string, identityId: string): Promise<IdentityEvidence[]> {
    return this.prisma.identityEvidence.findMany({
      where: { organizationId, identityId },
      orderBy: { observedAt: 'desc' },
    });
  }
}

// ---------------------------------------------------------------------------
// IdentityResolutionLink — reversible; confirmed links are never hard-deleted.
// ---------------------------------------------------------------------------

export interface ProposeLinkInput {
  sourceIdentityId: string;
  targetIdentityId: string;
  method: IdentityResolutionMethod;
  confidence?: number | null;
  evidenceSummary?: Record<string, unknown>;
  consentBasis?: ConsentBasis;
  permittedPurposes?: DataPurpose[];
  establishedBy?: string | null;
}

export class IdentityResolutionLinkRepository {
  constructor(private readonly prisma: PrismaClient) {}

  propose(organizationId: string, input: ProposeLinkInput): Promise<IdentityResolutionLink> {
    return this.prisma.identityResolutionLink.create({
      data: {
        organizationId,
        sourceIdentityId: input.sourceIdentityId,
        targetIdentityId: input.targetIdentityId,
        method: input.method,
        confidence: input.confidence ?? null,
        status: 'PROPOSED',
        evidenceSummary: (input.evidenceSummary ?? {}) as Prisma.InputJsonValue,
        consentBasis: input.consentBasis ?? 'NONE',
        permittedPurposes: input.permittedPurposes ?? [],
        establishedBy: input.establishedBy ?? null,
      },
    });
  }

  async confirm(organizationId: string, id: string): Promise<IdentityResolutionLink | null> {
    const found = await this.prisma.identityResolutionLink.findFirst({
      where: { id, organizationId },
    });
    if (!found || found.status === 'REVERSED') return found ?? null;
    return this.prisma.identityResolutionLink.update({
      where: { id: found.id },
      data: { status: 'CONFIRMED' },
    });
  }

  /** Reverse a link. Never deletes — records who/why and flips status. */
  async reverse(
    organizationId: string,
    id: string,
    args: { reversedBy?: string | null; reason?: string | null },
  ): Promise<IdentityResolutionLink | null> {
    const found = await this.prisma.identityResolutionLink.findFirst({
      where: { id, organizationId },
    });
    if (!found) return null;
    return this.prisma.identityResolutionLink.update({
      where: { id: found.id },
      data: {
        status: 'REVERSED',
        reversedAt: new Date(),
        reversedBy: args.reversedBy ?? null,
        reversalReason: args.reason ?? null,
      },
    });
  }

  listForIdentity(organizationId: string, identityId: string): Promise<IdentityResolutionLink[]> {
    return this.prisma.identityResolutionLink.findMany({
      where: {
        organizationId,
        OR: [{ sourceIdentityId: identityId }, { targetIdentityId: identityId }],
      },
      orderBy: { establishedAt: 'desc' },
    });
  }
}

// ---------------------------------------------------------------------------
// IdentityRelationship — explicit direction (from → to), typed meaning.
// ---------------------------------------------------------------------------

export interface CreateRelationshipInput {
  fromIdentityId: string;
  toIdentityId: string;
  relationshipType: IdentityRelationshipType;
  confidence?: number | null;
  sourceEventId?: string | null;
  permittedPurposes?: DataPurpose[];
  metadata?: Record<string, unknown>;
}

export class IdentityRelationshipRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(organizationId: string, input: CreateRelationshipInput): Promise<IdentityRelationship> {
    return this.prisma.identityRelationship.create({
      data: {
        organizationId,
        fromIdentityId: input.fromIdentityId,
        toIdentityId: input.toIdentityId,
        relationshipType: input.relationshipType,
        confidence: input.confidence ?? null,
        sourceEventId: input.sourceEventId ?? null,
        permittedPurposes: input.permittedPurposes ?? [],
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async deactivate(organizationId: string, id: string): Promise<IdentityRelationship | null> {
    const found = await this.prisma.identityRelationship.findFirst({
      where: { id, organizationId },
    });
    if (!found) return null;
    return this.prisma.identityRelationship.update({
      where: { id: found.id },
      data: { status: 'INACTIVE', effectiveTo: new Date() },
    });
  }

  listForIdentity(organizationId: string, identityId: string): Promise<IdentityRelationship[]> {
    return this.prisma.identityRelationship.findMany({
      where: {
        organizationId,
        OR: [{ fromIdentityId: identityId }, { toIdentityId: identityId }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
  }
}
