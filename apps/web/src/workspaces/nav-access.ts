import 'server-only';
import { repositories } from '@emgloop/database';
import type { AuthSession } from '../auth/auth';
import { LOOP_NAV, visibleNav, type NavGroup, type NavItem } from './config';
import { resolveWorkspaceRole } from './role-router';

// The Loop navigation one signed-in person is offered, resolved server-side.
//
// Permissions come from IamRepository.canEach: the same rules as the can() every
// page enforces (the ACTIVE OrganizationMembership in the signed session's
// organization, Permission rows with DENY winning, then the capability matrix),
// answered in one read instead of one round per item. Role authority comes from
// the role router. This only decides what to SHOW: every destination still
// enforces its own authority on arrival.

type Requirement = NonNullable<NavItem['requires']>;
const key = (r: Requirement) => `${r.resource}:${r.action}`;

export async function navFor(session: AuthSession): Promise<NavGroup[]> {
  const required = new Map<string, Requirement>();
  for (const item of LOOP_NAV.nav.flatMap((g) => g.items)) {
    if (item.requires) required.set(key(item.requires), item.requires);
  }
  const checks = [...required.values()];
  const answers = await repositories.iam.canEach(session.organizationId, session.userId, checks);
  const granted = new Map(checks.map((check, i) => [key(check), answers[i] === true] as const));

  return visibleNav(LOOP_NAV.nav, {
    workspace: resolveWorkspaceRole(session),
    permitted: (item) => (item.requires ? granted.get(key(item.requires)) === true : true),
  });
}
