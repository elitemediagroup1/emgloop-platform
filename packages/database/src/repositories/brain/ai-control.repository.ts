// Stored AI controls: the append-only log and its current view. Slice B4.
//
// Architecture: docs/architecture/brain-execution-infrastructure.md §17, the contract in
// packages/shared/src/ai/ai-controls.ts, and docs/architecture/brain-persistence.md §7.
//
// RECORDED AUTHORITY, NOT CONFIGURATION. Nothing here reads an environment variable, and
// nothing copies one in. A control is appended by a person acting in their organization
// (ORGANIZATION, or a TASK within it) or by a reviewed operations run (GLOBAL, PROVIDER,
// MODEL, or a platform-wide TASK). Combining these records with each deployment's
// environment floor is the reader's job in B5: both must allow, and any KILLED stops.
//
// APPEND-ONLY, VERSIONED, NEVER STALE. Each change names the version it read
// (`aiControlAppendDecision`). The log row and the current view are written in one
// transaction; the view's foreign key points at its log row, and the log's
// (controlKey, version) key settles a race between two writers.
//
// PROVIDER POLICIES (G2, 2026-09-24) are stored here too, under scope PROVIDER_POLICY with a
// `ceiling`: the highest sensitivity class a provider may receive. They are recorded only by a
// reviewed operations run or a named person (`recordProviderPolicy`), read platform-wide by the
// gateway (`providerPolicies`), and NEVER returned by `currentFor` -- a policy is not a switch, and
// the Brain's effective-controls reader must not see one.
//
// AN ORGANIZATION SEES PLATFORM CONTROLS AND ITS OWN -- never another organization's.
// Who may record an organization's controls (OWNER or ADMIN) is decided by the Brain
// API's IAM check in B5; this repository requires only that the person is an active
// member of that organization.

import type { AiControl as AiControlRow, PrismaClient } from '@prisma/client';
import {
  AI_CONTROL_SCOPES,
  AI_CONTROL_STATES,
  AI_PROVIDER_POLICY_SCOPE,
  AI_SENSITIVITY_CLASSES,
  AI_STORED_CONTROL_SCOPES,
  aiProviderPoliciesOf,
  aiControlAppendDecision,
  aiControlKey,
  aiControlRefusals,
  type AiControlActor,
  type AiControlEntry,
  type AiControlRefusal,
  type AiControlScope,
  type AiControlState,
  type AiControlTarget,
  type AiProviderPolicy,
  type AiSensitivityClass,
  type AiStoredControlScope,
} from '@emgloop/shared';

import { BrainRecordUnreadable, isUniqueViolation } from './brain-records';

export type AiControlRecordOutcome =
  | { readonly ok: true; readonly result: 'APPENDED' | 'UNCHANGED'; readonly entry: AiControlEntry }
  | { readonly ok: false; readonly refusal: AiControlRefusal | 'STALE' | 'SCOPE_NOT_ALLOWED' | 'ACTOR_NOT_ACTIVE_MEMBER' };

export interface AiControlChange {
  readonly state: AiControlState;
  readonly reason: string;
  /** The version the writer read: 0 for a control with no history. */
  readonly expectedVersion: number;
  readonly now?: Date;
  /** PROVIDER_POLICY only. */
  readonly ceiling?: AiSensitivityClass | null;
}

const ORGANIZATION_SCOPES: readonly AiControlScope[] = ['ORGANIZATION', 'TASK'];
const PLATFORM_SCOPES: readonly AiControlScope[] = ['GLOBAL', 'PROVIDER', 'MODEL', 'TASK'];

function entryOf(row: AiControlRow): AiControlEntry {
  const scope = row.scope as AiStoredControlScope;
  const state = row.state as AiControlState;
  if (!(AI_STORED_CONTROL_SCOPES as readonly string[]).includes(scope)) throw new BrainRecordUnreadable('control scope');
  if (!(AI_CONTROL_STATES as readonly string[]).includes(state)) throw new BrainRecordUnreadable('control state');
  const ceiling = (row as { ceiling?: string | null }).ceiling ?? null;
  if (ceiling !== null && !(AI_SENSITIVITY_CLASSES as readonly string[]).includes(ceiling)) throw new BrainRecordUnreadable('control ceiling');
  if (scope === AI_PROVIDER_POLICY_SCOPE && state === 'ACTIVE' && ceiling === null) throw new BrainRecordUnreadable('control ceiling');
  let actor: AiControlActor;
  if (row.actorKind === 'HUMAN') actor = { kind: 'HUMAN', userId: row.actorUserId ?? '' };
  else if (row.actorKind === 'OPERATIONS' && row.actorReference) actor = { kind: 'OPERATIONS', reference: row.actorReference };
  else throw new BrainRecordUnreadable('control actor');
  return {
    target: { scope, organizationId: row.organizationId, value: row.value },
    state,
    version: row.version,
    reason: row.reason,
    actor,
    recordedAtMs: row.recordedAt.getTime(),
    ...(scope === AI_PROVIDER_POLICY_SCOPE ? { ceiling: ceiling as AiSensitivityClass | null } : {}),
  };
}

export class AiControlRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Record a control for one organization: the organization itself, or one task within
   * it. The target organization is always `organizationId`; a request cannot name
   * another.
   */
  async recordOrganizationControl(
    organizationId: string,
    request: AiControlChange & { readonly scope: 'ORGANIZATION' | 'TASK'; readonly taskId?: string; readonly actorUserId: string },
  ): Promise<AiControlRecordOutcome> {
    if (!ORGANIZATION_SCOPES.includes(request.scope)) return { ok: false, refusal: 'SCOPE_NOT_ALLOWED' };
    const target: AiControlTarget = {
      scope: request.scope,
      organizationId,
      value: request.scope === 'ORGANIZATION' ? organizationId : (request.taskId ?? null),
    };
    const member = await this.prisma.organizationMembership.findFirst({
      where: { organizationId, userId: request.actorUserId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!member) return { ok: false, refusal: 'ACTOR_NOT_ACTIVE_MEMBER' };
    return this.append(target, request, { kind: 'HUMAN', userId: request.actorUserId });
  }

  /**
   * Record a platform control from a reviewed operations run (workflow_dispatch with a
   * typed confirmation, as migrations are). No product path calls this.
   */
  async recordPlatformControl(
    request: AiControlChange & { readonly scope: 'GLOBAL' | 'PROVIDER' | 'MODEL' | 'TASK'; readonly value: string | null; readonly operationsReference: string },
  ): Promise<AiControlRecordOutcome> {
    if (!PLATFORM_SCOPES.includes(request.scope)) return { ok: false, refusal: 'SCOPE_NOT_ALLOWED' };
    const target: AiControlTarget = { scope: request.scope, organizationId: null, value: request.value };
    return this.append(target, request, { kind: 'OPERATIONS', reference: request.operationsReference });
  }

  /**
   * G2. Record one provider's data-class policy: the highest sensitivity class Loop may send it,
   * ACTIVE, or KILLED (the ceiling may be kept or omitted). A reviewed operations run records it
   * (`record-ai-provider-policy` workflow, actor OPERATIONS), or a named person (actor HUMAN) --
   * no product path calls this. Versioned like every control: the writer names the version it
   * read, a moved control is STALE, and recording what is already current appends nothing.
   */
  async recordProviderPolicy(
    request: Omit<AiControlChange, 'ceiling'> & {
      readonly providerId: string;
      readonly ceiling: AiSensitivityClass | null;
      readonly actor: AiControlActor;
    },
  ): Promise<AiControlRecordOutcome> {
    const target: AiControlTarget = { scope: AI_PROVIDER_POLICY_SCOPE, organizationId: null, value: request.providerId };
    return this.append(target, { ...request, ceiling: request.ceiling }, request.actor);
  }

  /**
   * Every provider's CURRENT policy, platform-wide: what admission reads (G2). A row that cannot
   * be understood throws, and the gateway treats a failed read as UNREADABLE -- it refuses, it
   * never guesses.
   */
  async providerPolicies(): Promise<AiProviderPolicy[]> {
    const views = await this.prisma.aiControlCurrent.findMany({
      where: { scope: AI_PROVIDER_POLICY_SCOPE, organizationId: null },
      select: { controlKey: true, version: true },
      orderBy: { controlKey: 'asc' },
    });
    if (views.length === 0) return [];
    const rows = await this.prisma.aiControl.findMany({
      where: { OR: views.map((v) => ({ controlKey: v.controlKey, version: v.version })) },
    });
    return aiProviderPoliciesOf(rows.map(entryOf));
  }

  /** One provider's policy history, oldest first. Platform-wide; no organization owns it. */
  async providerPolicyHistory(providerId: string): Promise<AiControlEntry[]> {
    const rows = await this.prisma.aiControl.findMany({
      where: { controlKey: aiControlKey({ scope: AI_PROVIDER_POLICY_SCOPE, organizationId: null, value: providerId }) },
      orderBy: { version: 'asc' },
    });
    return rows.map(entryOf);
  }

  private async append(target: AiControlTarget, change: AiControlChange, actor: AiControlActor): Promise<AiControlRecordOutcome> {
    const ceiling = target.scope === AI_PROVIDER_POLICY_SCOPE ? (change.ceiling ?? null) : null;
    const refusals = aiControlRefusals({ target, state: change.state, reason: change.reason, actor, ceiling: change.ceiling ?? null });
    if (refusals.length > 0) return { ok: false, refusal: refusals[0]! };
    const controlKey = aiControlKey(target);
    const now = change.now ?? new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await tx.aiControlCurrent.findFirst({ where: { controlKey }, select: { version: true } });
        const currentEntry = current
          ? await tx.aiControl.findFirst({ where: { controlKey, version: current.version } })
          : null;
        const decision = aiControlAppendDecision(
          currentEntry
            ? { version: currentEntry.version, state: currentEntry.state as AiControlState, ceiling: (currentEntry as { ceiling?: string | null }).ceiling ?? null }
            : null,
          { expectedVersion: change.expectedVersion, state: change.state, ceiling },
        );
        if (decision.action === 'STALE') return { ok: false as const, refusal: 'STALE' as const };
        if (decision.action === 'UNCHANGED') return { ok: true as const, result: 'UNCHANGED' as const, entry: entryOf(currentEntry!) };
        const row = await tx.aiControl.create({
          data: {
            controlKey,
            version: decision.version,
            scope: target.scope,
            organizationId: target.organizationId,
            value: target.value,
            state: change.state,
            reason: change.reason.trim(),
            actorKind: actor.kind,
            actorUserId: actor.kind === 'HUMAN' ? actor.userId : null,
            actorReference: actor.kind === 'OPERATIONS' ? actor.reference : null,
            // Only a provider policy carries a ceiling; every other control's row is unchanged.
            ...(target.scope === AI_PROVIDER_POLICY_SCOPE ? { ceiling } : {}),
            recordedAt: now,
          },
        });
        if (decision.version === 1) {
          await tx.aiControlCurrent.create({
            data: { controlKey, version: 1, scope: target.scope, organizationId: target.organizationId, value: target.value },
            select: { controlKey: true },
          });
        } else {
          const moved = await tx.aiControlCurrent.updateMany({
            where: { controlKey, version: decision.version - 1 },
            data: { version: decision.version },
          });
          if (moved.count !== 1) throw Object.assign(new Error('control moved underneath this write'), { code: 'P2002' });
        }
        return { ok: true as const, result: 'APPENDED' as const, entry: entryOf(row) };
      });
    } catch (err) {
      // Another writer appended the same version first.
      if (isUniqueViolation(err)) return { ok: false, refusal: 'STALE' };
      throw err;
    }
  }

  /** The current controls an organization's work is subject to: platform ones and its own. */
  async currentFor(organizationId: string): Promise<AiControlEntry[]> {
    const views = await this.prisma.aiControlCurrent.findMany({
      where: { OR: [{ organizationId: null }, { organizationId }] },
      select: { controlKey: true, version: true },
      orderBy: { controlKey: 'asc' },
    });
    if (views.length === 0) return [];
    const rows = await this.prisma.aiControl.findMany({
      where: { OR: views.map((v) => ({ controlKey: v.controlKey, version: v.version })) },
    });
    const byKey = new Map(rows.map((r) => [r.controlKey, r]));
    return views
      .map((v) => byKey.get(v.controlKey))
      .filter((r): r is AiControlRow => r !== undefined)
      // Switches only: a provider policy is read by admission, never by the effective-controls reader.
      .filter((r) => (AI_CONTROL_SCOPES as readonly string[]).includes(r.scope))
      .map(entryOf);
  }

  /** One control's history, oldest first, if the organization may see it. */
  async history(organizationId: string, target: AiControlTarget): Promise<AiControlEntry[]> {
    if (target.organizationId !== null && target.organizationId !== organizationId) return [];
    const rows = await this.prisma.aiControl.findMany({
      where: { controlKey: aiControlKey(target), OR: [{ organizationId: null }, { organizationId }] },
      orderBy: { version: 'asc' },
    });
    return rows.map(entryOf);
  }
}
