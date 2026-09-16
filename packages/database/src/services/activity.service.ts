// Authorized reads of Universal Activity.
//
// Slice A2. Universal Activity is a projection over other authorities, so the one
// thing this service must never become is a second way in. It grants nothing:
//
//   1. BEFORE ANY READ, every adapter's requirements are checked against the
//      viewer's own grants. An adapter the viewer cannot read is not run, so it
//      costs no query and reveals nothing -- not even that it holds rows.
//   2. AFTER THE READ, every item is checked again against those same grants and its
//      own `access` block. An adapter that ever emitted an item stating a
//      requirement it does not hold has that item dropped, not shown.
//
// Check 2 is not redundant. Check 1 trusts the adapter's declaration; check 2 trusts
// the item. The day someone adds a source that returns a row from a neighbouring
// authority, check 2 is what stops it reaching a screen.
//
// THE ORGANIZATION AND THE VIEWER COME FROM THE SIGNED SESSION, established by the
// caller. Nothing here takes an organization from a request, and no subject id is
// resolved from a contact value.
//
// WORKSPACE AUTHORITY IS ENFORCED, NOT DESCRIBED. Sources whose own surface sits
// behind a workspace role (the marketplace and Case surfaces are ADMIN) are read
// only by a viewer holding that role, which the caller resolves from the session.
// A caller that names no workspace role holds none.

import type { PrismaClient } from '@prisma/client';
import type { ActivityPageV1, ActivitySourceReadV1 } from '@emgloop/shared';

import { IamRepository, type Action, type Resource } from '../repositories/iam.repository';
import {
  ActivityCursorError,
  ActivityReadModelRepository,
  type ActivityAdapter,
  type ActivityReadOptions,
  type ActivitySubject,
} from '../repositories/activity-read-model.repository';

export interface ActivityViewer {
  readonly organizationId: string;
  readonly userId: string;
  /** The workspace authority the session resolved, when it has one. */
  readonly workspaceRole?: string | null;
}

export type ActivityReadResult =
  | { outcome: 'OK'; value: ActivityPageV1 }
  | { outcome: 'NOT_AUTHORIZED' }
  | { outcome: 'INVALID_CURSOR' };

export interface ActivityServiceDeps {
  iam?: Pick<IamRepository, 'canEach'>;
  readModel?: ActivityReadModelRepository;
}

/** The resources this service will ever check. An unknown resource fails closed. */
const RESOURCES: readonly Resource[] = [
  'customers',
  'pipeline',
  'inbox',
  'workflows',
  'users',
  'organizations',
  'aiEmployees',
  'settings',
  'audit',
  'analytics',
  'integrations',
  'intelligence',
  'commercialIntelligence',
  'identityResolution',
  'work',
];

function isResource(value: string): value is Resource {
  return (RESOURCES as readonly string[]).includes(value);
}

export class ActivityService {
  private readonly iam: Pick<IamRepository, 'canEach'>;
  private readonly readModel: ActivityReadModelRepository;

  constructor(prisma: PrismaClient, deps: ActivityServiceDeps = {}) {
    this.iam = deps.iam ?? new IamRepository(prisma);
    this.readModel = deps.readModel ?? new ActivityReadModelRepository(prisma);
  }

  async read(viewer: ActivityViewer, subject: ActivitySubject, options: ActivityReadOptions = {}): Promise<ActivityReadResult> {
    if (!viewer.organizationId?.trim() || !viewer.userId?.trim()) return { outcome: 'NOT_AUTHORIZED' };

    const candidates = this.readModel.adaptersFor(subject);
    if (candidates.length === 0) return { outcome: 'NOT_AUTHORIZED' };

    const grants = await this.grants(viewer, candidates);
    const permitted: ActivityAdapter[] = [];
    const skipped: ActivitySourceReadV1[] = [];
    for (const adapter of candidates) {
      const allowed =
        this.holdsWorkspace(viewer, adapter.workspace) &&
        adapter.requiresFor(subject).every((r) => grants.get(key(r.resource, r.action)) === true);
      if (allowed) permitted.push(adapter);
      else skipped.push({ domain: adapter.domain, rowsRead: 0, refused: 0, suppressed: 0, skipped: 'NOT_AUTHORIZED', limitations: [] });
    }
    // Nothing readable is not an empty timeline; the viewer learns neither.
    if (permitted.length === 0) return { outcome: 'NOT_AUTHORIZED' };

    try {
      const page = await this.readModel.page(viewer.organizationId, subject, permitted, options, skipped);
      return { outcome: 'OK', value: this.onlyWhatTheViewerMayRead(page, viewer, grants) };
    } catch (err) {
      if (err instanceof ActivityCursorError) return { outcome: 'INVALID_CURSOR' };
      throw err;
    }
  }

  /** The second check: the item's own stated requirements, against the viewer's grants. */
  private onlyWhatTheViewerMayRead(
    page: ActivityPageV1,
    viewer: ActivityViewer,
    grants: Map<string, boolean>,
  ): ActivityPageV1 {
    const items = page.items.filter((item) => {
      if (item.organizationId !== viewer.organizationId) return false;
      if (!this.holdsWorkspace(viewer, item.access.workspace)) return false;
      if (item.access.requires.length === 0) return false;
      return item.access.requires.every((r) => grants.get(key(r.resource, r.action)) === true);
    });
    return items.length === page.items.length ? page : { ...page, items };
  }

  private holdsWorkspace(viewer: ActivityViewer, required: string | null): boolean {
    if (required === null) return true;
    return (viewer.workspaceRole ?? null) === required;
  }

  /**
   * Every requirement any candidate adapter states, resolved once. A requirement
   * naming a resource the IAM matrix does not govern is denied rather than guessed
   * at, so a typo cannot open a source.
   */
  private async grants(viewer: ActivityViewer, adapters: readonly ActivityAdapter[]): Promise<Map<string, boolean>> {
    const wanted = new Map<string, { resource: string; action: Action }>();
    for (const adapter of adapters) {
      for (const probe of [
        { kind: 'ORGANIZATION' },
        { kind: 'INTAKE_RECORD', customerId: 'probe' },
        { kind: 'CASE', priorityId: 'probe' },
        { kind: 'WORK_ITEM', workInstanceId: 'probe' },
      ] as ActivitySubject[]) {
        const subject = probe;
        if (!adapter.supports(subject)) continue;
        for (const r of adapter.requiresFor(subject)) wanted.set(key(r.resource, r.action), { resource: r.resource, action: r.action });
      }
    }

    const checks = [...wanted.values()].filter((c) => isResource(c.resource)) as { resource: Resource; action: Action }[];
    const results = checks.length > 0 ? await this.iam.canEach(viewer.organizationId, viewer.userId, checks) : [];
    const grants = new Map<string, boolean>();
    for (const [i, check] of checks.entries()) grants.set(key(check.resource, check.action), results[i] === true);
    return grants;
  }
}

function key(resource: string, action: string): string {
  return `${resource}:${action}`;
}
