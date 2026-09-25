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
// THE OPERATING BUDGET (PR 1, 2026-09-26) is stored here too, under scope BUDGET (`BUDGET|-|operating`),
// ACTIVE only, with its figures in `settings` (capacity.ts). A reviewed operations run records it
// (`recordOperatingBudget`, the record-ai-budget workflow); the gateway reads it (`operatingBudget`). Like
// a provider policy it is never returned by `currentFor`.
//
// EVERY READ NAMES ITS COLUMNS (PR 1). `settings` arrived in migration 20261005000000, and a read that
// selected whole rows would fail on a database the code reached before its migration -- which would
// have refused every AI call, since the provider-policy read goes through here. Only the budget read
// selects `settings`, and it reads a database without the column as "no budget recorded".
//
// AN ORGANIZATION SEES PLATFORM CONTROLS AND ITS OWN -- never another organization's.
// Who may record an organization's controls (OWNER or ADMIN) is decided by the Brain
// API's IAM check in B5; this repository requires only that the person is an active
// member of that organization.

import type { PrismaClient } from '@prisma/client';
import {
  AI_BUDGET_CONTROL_VALUE,
  AI_BUDGET_SCOPE,
  AI_CONTROL_SCOPES,
  AI_CONTROL_STATES,
  AI_PROVIDER_POLICY_SCOPE,
  AI_SENSITIVITY_CLASSES,
  AI_STORED_CONTROL_SCOPES,
  aiProviderPoliciesOf,
  aiControlAppendDecision,
  aiControlKey,
  aiControlRefusals,
  aiOperatingBudgetOf,
  aiOperatingBudgetRefusals,
  type AiControlActor,
  type AiControlEntry,
  type AiControlRefusal,
  type AiControlScope,
  type AiControlState,
  type AiControlTarget,
  type AiOperatingBudget,
  type AiProviderPolicy,
  type AiSensitivityClass,
  type AiStoredControlScope,
} from '@emgloop/shared';

import { absentUntilMigrated } from '../../creator/until-migrated';
import { BrainRecordUnreadable, isUniqueViolation } from './brain-records';

/** Every column a control read needs, named -- never the whole row (see the header). */
const CONTROL_COLUMNS = Object.freeze({
  controlKey: true,
  version: true,
  scope: true,
  organizationId: true,
  value: true,
  state: true,
  reason: true,
  actorKind: true,
  actorUserId: true,
  actorReference: true,
  ceiling: true,
  recordedAt: true,
} as const);

interface AiControlRow {
  readonly controlKey: string;
  readonly version: number;
  readonly scope: string;
  readonly organizationId: string | null;
  readonly value: string | null;
  readonly state: string;
  readonly reason: string;
  readonly actorKind: string;
  readonly actorUserId: string | null;
  readonly actorReference: string | null;
  readonly ceiling: string | null;
  readonly recordedAt: Date;
  readonly settings?: unknown;
}

/** What the gateway reads of the operating budget. UNREADABLE refuses every call; NONE is today's policy. */
export type AiOperatingBudgetRead =
  | { readonly state: 'NONE' }
  | { readonly state: 'RECORDED'; readonly budget: AiOperatingBudget; readonly version: number; readonly recordedAtMs: number; readonly reason: string }
  | { readonly state: 'UNREADABLE' };

export type AiControlRecordOutcome =
  | { readonly ok: true; readonly result: 'APPENDED' | 'UNCHANGED'; readonly entry: AiControlEntry }
  | { readonly ok: false; readonly refusal: AiControlRefusal | 'STALE' | 'SCOPE_NOT_ALLOWED' | 'ACTOR_NOT_ACTIVE_MEMBER' | 'SETTINGS_INVALID' | 'NOT_MIGRATED' };

export interface AiControlChange {
  readonly state: AiControlState;
  readonly reason: string;
  /** The version the writer read: 0 for a control with no history. */
  readonly expectedVersion: number;
  readonly now?: Date;
  /** PROVIDER_POLICY only. */
  readonly ceiling?: AiSensitivityClass | null;
  /** BUDGET only. */
  readonly settings?: unknown;
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
    ...(scope === AI_BUDGET_SCOPE ? { settings: row.settings ?? null } : {}),
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
      select: CONTROL_COLUMNS,
    });
    return aiProviderPoliciesOf(rows.map(entryOf));
  }

  /**
   * PR 1. Record the operating budget: the figures (`settings`, capacity.ts) an operations run chose,
   * validated against the reviewed policy's budget classes and the code maximums before anything is
   * written. Versioned like every control; recording figures that are already current appends nothing.
   * NOT_MIGRATED when the database has no `settings` column yet.
   */
  async recordOperatingBudget(request: {
    readonly settings: unknown;
    readonly knownClasses: readonly string[];
    readonly reason: string;
    readonly expectedVersion: number;
    readonly actor: AiControlActor;
    readonly now?: Date;
  }): Promise<AiControlRecordOutcome> {
    if (aiOperatingBudgetRefusals(request.settings, request.knownClasses).length > 0) return { ok: false, refusal: 'SETTINGS_INVALID' };
    // An empty result is a migrated table with no rows; null is a database without the column.
    const migrated = await absentUntilMigrated(this.prisma.aiControl.findMany({ select: { settings: true }, take: 1 }));
    if (migrated === null) return { ok: false, refusal: 'NOT_MIGRATED' };
    const target: AiControlTarget = { scope: AI_BUDGET_SCOPE, organizationId: null, value: AI_BUDGET_CONTROL_VALUE };
    return this.append(target, { state: 'ACTIVE', reason: request.reason, expectedVersion: request.expectedVersion, settings: request.settings, now: request.now }, request.actor);
  }

  /**
   * PR 1. The CURRENT operating budget, as the gateway admits against it. NONE when nothing is recorded
   * (a database that predates migration 20261005000000 cannot hold a BUDGET row at all, so it reads NONE
   * here without ever touching the new column). UNREADABLE when a recorded budget cannot be read back or
   * does not validate: the gateway then refuses every call rather than run unbounded. Throws on a
   * database error, which the gateway's reader also treats as UNREADABLE.
   */
  async operatingBudget(knownClasses: readonly string[]): Promise<AiOperatingBudgetRead> {
    const key = aiControlKey({ scope: AI_BUDGET_SCOPE, organizationId: null, value: AI_BUDGET_CONTROL_VALUE });
    const view = await this.prisma.aiControlCurrent.findFirst({ where: { controlKey: key }, select: { version: true } });
    if (!view) return { state: 'NONE' };
    const row = await absentUntilMigrated(
      this.prisma.aiControl.findFirst({ where: { controlKey: key, version: view.version }, select: { ...CONTROL_COLUMNS, settings: true } }),
    );
    if (row === null) return { state: 'UNREADABLE' };
    const budget = row.state === 'ACTIVE' ? aiOperatingBudgetOf(row.settings, knownClasses) : null;
    if (!budget) return { state: 'UNREADABLE' };
    return { state: 'RECORDED', budget, version: row.version, recordedAtMs: row.recordedAt.getTime(), reason: row.reason };
  }

  /**
   * PR 1. The operating budget's CURRENT VERSION -- a record's position in its history, not a
   * measurement -- whether or not its figures still validate (version 0 when none is recorded). This is the recovery path: a budget that became UNREADABLE (for instance, a later release
   * retired a budget class it names) refuses every AI call, and recording corrected figures must still be
   * able to name the version it replaces. It reads the current view only -- never `settings`.
   */
  async operatingBudgetVersion(): Promise<{ readonly version: number }> {
    const key = aiControlKey({ scope: AI_BUDGET_SCOPE, organizationId: null, value: AI_BUDGET_CONTROL_VALUE });
    const view = await this.prisma.aiControlCurrent.findFirst({ where: { controlKey: key }, select: { version: true } });
    return { version: view?.version ?? 0 };
  }

  /** One provider's policy history, oldest first. Platform-wide; no organization owns it. */
  async providerPolicyHistory(providerId: string): Promise<AiControlEntry[]> {
    const rows = await this.prisma.aiControl.findMany({
      where: { controlKey: aiControlKey({ scope: AI_PROVIDER_POLICY_SCOPE, organizationId: null, value: providerId }) },
      orderBy: { version: 'asc' },
      select: CONTROL_COLUMNS,
    });
    return rows.map(entryOf);
  }

  private async append(target: AiControlTarget, change: AiControlChange, actor: AiControlActor): Promise<AiControlRecordOutcome> {
    const ceiling = target.scope === AI_PROVIDER_POLICY_SCOPE ? (change.ceiling ?? null) : null;
    const settings = target.scope === AI_BUDGET_SCOPE ? (change.settings ?? null) : null;
    const refusals = aiControlRefusals({
      target,
      state: change.state,
      reason: change.reason,
      actor,
      ceiling: change.ceiling ?? null,
      settings: change.settings ?? null,
    });
    if (refusals.length > 0) return { ok: false, refusal: refusals[0]! };
    const controlKey = aiControlKey(target);
    const now = change.now ?? new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await tx.aiControlCurrent.findFirst({ where: { controlKey }, select: { version: true } });
        const currentEntry = current
          ? await tx.aiControl.findFirst({
              where: { controlKey, version: current.version },
              // Only a budget's own history reads `settings`, so no other control depends on the column.
              select: target.scope === AI_BUDGET_SCOPE ? { ...CONTROL_COLUMNS, settings: true } : CONTROL_COLUMNS,
            })
          : null;
        const decision = aiControlAppendDecision(
          currentEntry
            ? {
                version: currentEntry.version,
                state: currentEntry.state as AiControlState,
                ceiling: currentEntry.ceiling ?? null,
                settings: (currentEntry as AiControlRow).settings ?? null,
              }
            : null,
          { expectedVersion: change.expectedVersion, state: change.state, ceiling, settings },
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
            // Only a provider policy carries a ceiling, and only a budget carries settings; every other
            // control's row is written exactly as before (neither column is named).
            ...(target.scope === AI_PROVIDER_POLICY_SCOPE ? { ceiling } : {}),
            ...(target.scope === AI_BUDGET_SCOPE ? { settings: settings as never } : {}),
            recordedAt: now,
          },
          select: target.scope === AI_BUDGET_SCOPE ? { ...CONTROL_COLUMNS, settings: true } : CONTROL_COLUMNS,
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
      select: CONTROL_COLUMNS,
    });
    const byKey = new Map(rows.map((r) => [r.controlKey, r]));
    return views
      .map((v) => byKey.get(v.controlKey))
      .filter((r): r is AiControlRow => r !== undefined)
      // Switches only: a provider policy or the operating budget is read by admission, never by the
      // effective-controls reader.
      .filter((r) => (AI_CONTROL_SCOPES as readonly string[]).includes(r.scope))
      .map(entryOf);
  }

  /** One control's history, oldest first, if the organization may see it. */
  async history(organizationId: string, target: AiControlTarget): Promise<AiControlEntry[]> {
    if (target.organizationId !== null && target.organizationId !== organizationId) return [];
    const rows = await this.prisma.aiControl.findMany({
      where: { controlKey: aiControlKey(target), OR: [{ organizationId: null }, { organizationId }] },
      orderBy: { version: 'asc' },
      select: CONTROL_COLUMNS,
    });
    return rows.map(entryOf);
  }
}
