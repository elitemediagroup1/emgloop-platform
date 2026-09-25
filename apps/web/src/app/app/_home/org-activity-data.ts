import 'server-only';

// Home's Recent activity -- the read. The organization's Universal Activity feed, through the
// governed `ActivityService`, for the ORGANIZATION subject only (see org-activity.ts for what is
// composed and why).
//
// THE SERVICE AUTHORIZES; THIS FILE DOES NOT WIDEN. The viewer is the signed session: its
// organization, its user and the workspace authority the session resolves to. The service checks
// every composed adapter's own requirements against that viewer's grants BEFORE reading (an
// adapter the viewer may not read costs no query) and every item again AFTER. This file narrows
// the composition to Home's allowlist first, so a source that is not organization-level
// observable events is never even a candidate.
//
// A read that throws is UNAVAILABLE, never an empty feed; a viewer with no readable source is
// NOT_AUTHORIZED. Actor names come from the session organization's own roster (IamRepository), and
// only the names of members the items already name are kept.

import { ActivityReadModelRepository, ActivityService, prisma, repositories } from '@emgloop/database';
import type { AuthSession } from '../../../auth/auth';
import { resolveWorkspaceRole } from '../../../workspaces/role-router';
import { ORG_ACTIVITY_LIMIT, homeActivityAdapters, type OrgActivity } from './org-activity';

export async function loadOrganizationActivity(session: Pick<AuthSession, 'userId' | 'organizationId' | 'systemRole'>): Promise<OrgActivity> {
  try {
    const composed = homeActivityAdapters(new ActivityReadModelRepository(prisma).adaptersFor({ kind: 'ORGANIZATION' }));
    const service = new ActivityService(prisma, { readModel: new ActivityReadModelRepository(prisma, { adapters: composed }) });
    const result = await service.read(
      { organizationId: session.organizationId, userId: session.userId, workspaceRole: resolveWorkspaceRole(session) },
      { kind: 'ORGANIZATION' },
      { limit: ORG_ACTIVITY_LIMIT },
    );
    if (result.outcome === 'NOT_AUTHORIZED') return { state: 'NOT_AUTHORIZED' };
    if (result.outcome !== 'OK') return { state: 'UNAVAILABLE' };
    const items = result.value.items;
    const named = new Set(items.map((i) => i.actor.userId).filter((id): id is string => typeof id === 'string'));
    // The organization's own roster, through its repository; a roster that cannot be read leaves
    // actors unnamed ("a workspace member"), it does not fail the feed.
    const roster = named.size === 0 ? [] : await repositories.iam.listUsers(session.organizationId).catch(() => []);
    const names = new Map(roster.filter((m) => named.has(m.id) && m.name && m.name.trim()).map((m) => [m.id, m.name!.trim()] as const));
    return { state: 'READ', items, sources: result.value.sources, names };
  } catch {
    return { state: 'UNAVAILABLE' };
  }
}
