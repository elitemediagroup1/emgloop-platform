// Sprint 27F — Business Process Engine · Process Registry
// ---------------------------------------------------------------------------
// The provider-neutral REGISTRY that owns Process Definitions — the platform layer
// that makes a business process a first-class DATA asset instead of engine code.
// Buyer Onboarding, Vendor Onboarding, Creator Campaign, Invoice Approval, … are all
// authored LATER as Registry entries; the engine never grows a branch per process.
//
// The Registry owns, and ONLY owns:
//   • discovery          — find definitions / versions / the active one
//   • versioning         — monotonic version per (organization, key)
//   • publishing         — freeze a draft into an immutable version
//   • activation         — promote a published version to the one new instances use
//   • retirement         — withdraw a version from normal use (history intact)
//   • validation         — a definition is a well-formed PhaseDefinition[] document
//   • organization availability — which versions an org may instantiate
//
// The Registry NEVER owns runtime, instances, transitions, readiness, work, or
// execution. Those belong to the Runtime (BusinessProcessRepository), which CONSUMES
// definitions from here. Definitions remain PURE DATA.
//
// Lifecycle (frozen with Matt, Sprint 27F):
//   draft → published → active → superseded → retired
//   • draft      — mutable; a new draft of the same version replaces it; not instantiable.
//   • published  — frozen/immutable; a change is a NEW version, never an edit.
//   • active     — the single instantiable version for (org, key); AT MOST ONE.
//   • superseded — a newer version was activated; NO new instances, but existing
//                  pinned instances continue to run normally.
//   • retired    — withdrawn from normal use; history and pinned instances intact.
// Every instance pins the EXACT version it was created from and never auto-migrates;
// the Runtime always reads the pinned definition by id, regardless of its status.
//
// Multi-tenant: definitions are organization-scoped. organizationId is the first
// argument to every method; single rows resolve with findFirst({ id, organizationId })
// and fail closed — a cross-org id is not-found, never forbidden, never a leak.
// ---------------------------------------------------------------------------

import type { Prisma, PrismaClient, ProcessDefinition } from '@prisma/client';

import {
  type BusinessObjectiveReference,
  type BusinessProcessDefinition,
  type PhaseDefinition,
} from './business-process.contracts';

type Tx = Prisma.TransactionClient | PrismaClient;

// The definition lifecycle states, in order. Owned solely by the Registry.
export const DEFINITION_STATUSES = [
  'draft',
  'published',
  'active',
  'superseded',
  'retired',
] as const;
export type DefinitionStatus = (typeof DEFINITION_STATUSES)[number];

class NotFoundError extends Error {}
function notFound(what: string, id: string): never {
  throw new NotFoundError(`${what} not found: ${id}`);
}

// ---------------------------------------------------------------------------
// Public input / filter shapes
// ---------------------------------------------------------------------------
export interface CreateDefinitionInput {
  organizationId: string;
  key: string;
  name: string;
  objective: BusinessObjectiveReference;
  subjectType: string;
  phases: PhaseDefinition[];
  allowBackward?: boolean;
  allowRestart?: boolean;
  metadata?: Record<string, unknown>;
  createdByUserId?: string | null;
}

export interface DefinitionListFilter {
  key?: string;
  status?: DefinitionStatus;
}

// ---------------------------------------------------------------------------
// Contract mapper — the one place a Prisma row becomes the PR A contract shape.
// Exported so the Runtime maps pinned definitions without re-implementing it.
// ---------------------------------------------------------------------------
export function toDefinitionContract(row: ProcessDefinition): BusinessProcessDefinition {
  return {
    key: row.key,
    name: row.name,
    version: row.version,
    objective: { key: row.objectiveKey, label: row.objectiveLabel },
    subjectType: row.subjectType,
    phases: (row.phases as unknown as PhaseDefinition[]) ?? [],
    allowBackward: row.allowBackward,
    allowRestart: row.allowRestart,
  };
}

export class ProcessRegistry {
  constructor(private readonly prisma: PrismaClient) {}

  // ================================================================
  // Authoring & versioning
  // ================================================================

  // Create a new DRAFT. The version is the next monotonic integer for (org, key), so
  // authoring "v2" of a process is just another createDefinition — never an edit.
  async createDefinition(input: CreateDefinitionInput): Promise<ProcessDefinition> {
    validateDefinition(input);
    const latest = await this.prisma.processDefinition.findFirst({
      where: { organizationId: input.organizationId, key: input.key },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;
    return this.prisma.processDefinition.create({
      data: {
        organizationId: input.organizationId,
        key: input.key,
        version,
        name: input.name,
        status: 'draft',
        objectiveKey: input.objective.key,
        objectiveLabel: input.objective.label ?? null,
        subjectType: input.subjectType,
        allowBackward: input.allowBackward ?? false,
        allowRestart: input.allowRestart ?? false,
        phases: input.phases as unknown as Prisma.InputJsonValue,
        ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
        createdByUserId: input.createdByUserId ?? null,
      },
    });
  }

  // ================================================================
  // Lifecycle transitions (draft → published → active → superseded → retired)
  // ================================================================

  // Freeze a draft into an immutable published version. Re-validates the frozen
  // document (defense in depth). Only a draft may be published.
  async publishDefinition(organizationId: string, definitionId: string): Promise<ProcessDefinition> {
    const existing = await this.resolveOwned(organizationId, definitionId);
    if (existing.status !== 'draft') {
      throw new Error(`Only a draft can be published (definition is '${existing.status}')`);
    }
    validatePhases(existing.phases as unknown as PhaseDefinition[]);
    return this.prisma.processDefinition.update({
      where: { id: existing.id },
      data: { status: 'published', publishedAt: new Date() },
    });
  }

  // Promote a published version to ACTIVE — the single version new instances use for
  // this (org, key). Any currently-active version of the same key is SUPERSEDED in the
  // same transaction (no new instances; its pinned instances keep running). Only a
  // published version may be activated; a retired one cannot be resurrected.
  async activateDefinition(organizationId: string, definitionId: string): Promise<ProcessDefinition> {
    const existing = await this.resolveOwned(organizationId, definitionId);
    if (existing.status === 'active') {
      throw new Error('Process definition is already active');
    }
    if (existing.status !== 'published') {
      throw new Error(`Only a published definition can be activated (definition is '${existing.status}')`);
    }
    const now = new Date();
    return this.prisma.$transaction(async (tx: Tx) => {
      // Supersede the current active version of this key, if any.
      const current = await tx.processDefinition.findFirst({
        where: { organizationId, key: existing.key, status: 'active' },
      });
      if (current && current.id !== existing.id) {
        await tx.processDefinition.update({
          where: { id: current.id },
          data: { status: 'superseded', supersededAt: now },
        });
      }
      return tx.processDefinition.update({
        where: { id: existing.id },
        data: { status: 'active', activatedAt: now },
      });
    });
  }

  // Withdraw a version from normal use. A published, active, or superseded version may
  // be retired; a draft cannot (discard it by publishing a replacement instead).
  // History and any instances already pinned to it remain intact and keep running.
  async retireDefinition(organizationId: string, definitionId: string): Promise<ProcessDefinition> {
    const existing = await this.resolveOwned(organizationId, definitionId);
    if (existing.status === 'retired') {
      throw new Error('Process definition is already retired');
    }
    if (existing.status === 'draft') {
      throw new Error('A draft cannot be retired — publish a replacement instead');
    }
    return this.prisma.processDefinition.update({
      where: { id: existing.id },
      data: { status: 'retired', retiredAt: new Date() },
    });
  }

  // ================================================================
  // Discovery (all reads are organization-scoped, fail-closed to null)
  // ================================================================

  async getDefinitionById(organizationId: string, definitionId: string): Promise<ProcessDefinition | null> {
    return this.prisma.processDefinition.findFirst({ where: { id: definitionId, organizationId } });
  }

  async getDefinition(organizationId: string, key: string, version: number): Promise<ProcessDefinition | null> {
    return this.prisma.processDefinition.findFirst({ where: { organizationId, key, version } });
  }

  // The single ACTIVE version for a key — what a new instance of this process uses.
  async getActiveDefinition(organizationId: string, key: string): Promise<ProcessDefinition | null> {
    return this.prisma.processDefinition.findFirst({ where: { organizationId, key, status: 'active' } });
  }

  // Discovery listing, newest version first. Optionally filter by key and/or status.
  async listDefinitions(
    organizationId: string,
    filter: DefinitionListFilter = {},
  ): Promise<ProcessDefinition[]> {
    return this.prisma.processDefinition.findMany({
      where: {
        organizationId,
        ...(filter.key ? { key: filter.key } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: [{ key: 'asc' }, { version: 'desc' }],
    });
  }

  // ================================================================
  // Organization availability — the Registry's answer to "may a NEW instance start
  // from this definition?" This is the ONLY authority the Runtime consults to
  // instantiate; the Runtime never inspects status itself.
  // ================================================================

  // Returns the definition row ONLY when it is active (instantiable) for this org;
  // null when absent, cross-org, or in any non-active state. The Runtime turns a null
  // into a refusal to create an instance.
  async resolveForInstantiation(
    organizationId: string,
    definitionId: string,
  ): Promise<ProcessDefinition | null> {
    const row = await this.getDefinitionById(organizationId, definitionId);
    if (!row || row.status !== 'active') return null;
    return row;
  }

  // Convenience: the active definition CONTRACT for a key (for callers that reason over
  // the PR A shape rather than the Prisma row).
  async getActiveDefinitionContract(
    organizationId: string,
    key: string,
  ): Promise<BusinessProcessDefinition | null> {
    const row = await this.getActiveDefinition(organizationId, key);
    return row ? toDefinitionContract(row) : null;
  }

  // ----------------------------------------------------------------
  private async resolveOwned(organizationId: string, definitionId: string): Promise<ProcessDefinition> {
    const existing = await this.prisma.processDefinition.findFirst({
      where: { id: definitionId, organizationId },
    });
    if (!existing) notFound('Process definition', definitionId);
    return existing;
  }
}

// ---------------------------------------------------------------------------
// Validation (pure) — a definition must be a well-formed PhaseDefinition[] document.
// ---------------------------------------------------------------------------
export function validateDefinition(input: CreateDefinitionInput): void {
  if (!input.key) throw new Error('A process definition requires a key');
  if (!input.name) throw new Error('A process definition requires a name');
  if (!input.objective?.key) throw new Error('A process definition requires an objective key');
  if (!input.subjectType) throw new Error('A process definition requires a subject type');
  validatePhases(input.phases);
}

export function validatePhases(phases: PhaseDefinition[]): void {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error('A process definition requires at least one phase');
  }
  const keys = new Set<string>();
  const positions = new Set<number>();
  for (const p of phases) {
    if (!p.key) throw new Error('Every phase requires a key');
    if (keys.has(p.key)) throw new Error(`Duplicate phase key: ${p.key}`);
    if (typeof p.position !== 'number') throw new Error(`Phase ${p.key} requires a numeric position`);
    if (positions.has(p.position)) throw new Error(`Duplicate phase position: ${p.position}`);
    if (!p.ownerResponsibilityKey) throw new Error(`Phase ${p.key} requires an owner responsibility key`);
    keys.add(p.key);
    positions.add(p.position);
  }
}
