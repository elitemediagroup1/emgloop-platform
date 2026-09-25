// The employee's own settings, and the organization's retention policy as it applies to them.
//
// Architecture: daily-loop-employee-intelligence.md §21.3 and §26.3 (DL-1).
//
// THE TIMEZONE HERE IS THE FIRST STORED DISPLAY ZONE IN LOOP. Until now the reader's zone
// came from the browser, which is fine for rendering and useless for scheduling: "has this
// person's working day started yet" needs an authority that exists when nobody is looking at
// a screen. This column is that authority, and it is a PREFERENCE -- the Loop Time Authority
// still owns presentation, and nothing in this package formats a human-facing date.
//
// RETENTION IS POLICY, NOT A CONSTANT. The approved windows live in `@emgloop/shared` as
// versioned, reviewed code, one entry per category. This repository resolves the EFFECTIVE
// window: an organization's deliberate override where one exists, the approved default
// otherwise. DL-1 represents the policy; DL-13 builds the sweep that acts on it.

import type { PrismaClient } from '@prisma/client';
import { WORK_RETENTION_CATEGORIES, WORK_RETENTION_NOT_OVERRIDABLE, WORK_RETENTION_POLICY_VERSION, type WorkRetentionCategory } from '@emgloop/shared';

import { workScope, type WorkPrincipal } from './work-principal';

export interface WorkPreferences {
  readonly timeZone: string;
  readonly dayStartMinutes: number;
  readonly quietStartMinutes: number | null;
  readonly quietEndMinutes: number | null;
  readonly briefEnabled: boolean;
  readonly sources: unknown;
}

const DEFAULTS: WorkPreferences = Object.freeze({
  timeZone: 'UTC',
  dayStartMinutes: 480,
  quietStartMinutes: null,
  quietEndMinutes: null,
  briefEnabled: true,
  sources: {},
});

export interface EffectiveRetention extends WorkRetentionCategory {
  /** True when this organization holds a deliberate departure from the approved default. */
  readonly overridden: boolean;
  /** The policy version the override was written against, when there is one. */
  readonly overridePolicyVersion: string | null;
}

export class WorkPreferencesRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * This person's settings, or the approved defaults when they have set none. Defaults are
   * returned rather than written, so a row exists only because somebody chose something.
   */
  async get(principal: WorkPrincipal): Promise<WorkPreferences> {
    const row = await this.prisma.employeeWorkPreferences.findFirst({ where: workScope(principal) });
    if (!row) return DEFAULTS;
    return {
      timeZone: row.timeZone,
      dayStartMinutes: row.dayStartMinutes,
      quietStartMinutes: row.quietStartMinutes,
      quietEndMinutes: row.quietEndMinutes,
      briefEnabled: row.briefEnabled,
      sources: row.sources,
    };
  }

  /** Set some of this person's own settings. Both ends of a quiet window travel together. */
  async set(principal: WorkPrincipal, update: Partial<WorkPreferences>): Promise<WorkPreferences> {
    const scope = workScope(principal);
    if ((update.quietStartMinutes == null) !== (update.quietEndMinutes == null)) {
      throw new Error('a quiet window needs both a start and an end, or neither');
    }
    const existing = await this.prisma.employeeWorkPreferences.findFirst({ where: scope });
    const data = {
      ...(update.timeZone !== undefined ? { timeZone: update.timeZone } : {}),
      ...(update.dayStartMinutes !== undefined ? { dayStartMinutes: update.dayStartMinutes } : {}),
      ...(update.quietStartMinutes !== undefined ? { quietStartMinutes: update.quietStartMinutes } : {}),
      ...(update.quietEndMinutes !== undefined ? { quietEndMinutes: update.quietEndMinutes } : {}),
      ...(update.briefEnabled !== undefined ? { briefEnabled: update.briefEnabled } : {}),
      ...(update.sources !== undefined ? { sources: update.sources as any } : {}),
    };
    if (!existing) {
      await this.prisma.employeeWorkPreferences.create({ data: { ...scope, ...data } });
    } else {
      await this.prisma.employeeWorkPreferences.update({ where: { id: existing.id }, data });
    }
    return this.get(principal);
  }

  /**
   * The retention policy in force for an organization: every approved category, with an
   * override applied where the organization recorded one.
   *
   * ORGANIZATION-SCOPED ON PURPOSE, AND SAFE. This is a policy about categories -- how long a
   * kind of row is kept -- and carries no employee data of any kind. It is the one read in
   * this directory that does not name a user, and it can never return one person's rows.
   */
  async effectiveRetention(organizationId: string): Promise<EffectiveRetention[]> {
    const overrides = await this.prisma.workRetentionOverride.findMany({ where: { organizationId } });
    const byCategory = new Map(overrides.map((o: any) => [o.category, o]));
    return WORK_RETENTION_CATEGORIES.map((category) => {
      const override = byCategory.get(category.category);
      if (!override || category.rule !== 'DAYS') {
        return { ...category, overridden: false, overridePolicyVersion: null };
      }
      return { ...category, days: override.days, overridden: true, overridePolicyVersion: override.policyVersion };
    });
  }

  /** Record a deliberate departure from the approved default, for one category. */
  async setRetentionOverride(
    organizationId: string,
    category: string,
    override: { readonly days: number; readonly reason?: string | null; readonly setByUserId?: string | null },
  ): Promise<void> {
    const approved = WORK_RETENTION_CATEGORIES.find((c) => c.category === category);
    if (!approved) throw new Error('unknown retention category');
    if (approved.rule !== 'DAYS') throw new Error('only a day-counted category can be overridden');
    // Its window is stamped on each row when written; an override would be a promise nothing keeps.
    if (WORK_RETENTION_NOT_OVERRIDABLE.includes(category)) throw new Error('this category is not overridable');
    const existing = await this.prisma.workRetentionOverride.findFirst({ where: { organizationId, category } });
    const data = {
      days: override.days,
      policyVersion: WORK_RETENTION_POLICY_VERSION,
      reason: override.reason ?? null,
      setByUserId: override.setByUserId ?? null,
    };
    if (!existing) {
      await this.prisma.workRetentionOverride.create({ data: { organizationId, category, ...data } });
      return;
    }
    await this.prisma.workRetentionOverride.update({ where: { id: existing.id }, data });
  }
}
