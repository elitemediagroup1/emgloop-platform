// Promote to Work, for one signed-in person. SERVER ONLY. Loop Intelligence Phase C.
//
// Everything the service needs to know about the person comes from the SIGNED SESSION, decided here:
//   - may they give the work to someone else?     work:manage (the platform has no work:assign action);
//   - may they read Cases?                        the Headlines gate (ADMIN workspace + commercialIntelligence:view);
//   - may they read an organization domain?       that domain's registry read authority (permission and
//                                                 workspace), the same one its surface enforces.
// No form field names an organization, a user or a scope.

import 'server-only';

import { PromoteToWorkService, WorkRepository, prisma, type PromoteActor, type PromotePreview } from '@emgloop/database';
import { intelligenceDomainEntry, type PromoteOrigin } from '@emgloop/shared';

import type { AuthSession } from '../auth/auth';
import { hasPermission } from '../auth/guard';
import { canOpenHeadlines } from '../crm/headlines-access';
import { resolveWorkspaceRole } from '../workspaces/role-router';

export async function promoteActorFor(session: AuthSession): Promise<PromoteActor> {
  const [mayAssignOthers, mayReadCases] = await Promise.all([hasPermission('work', 'manage'), canOpenHeadlines(session)]);
  const role = resolveWorkspaceRole(session);
  // Pre-resolve every organization domain's authority once, so the check below is synchronous.
  const domainAccess = new Map<string, boolean>();
  for (const domain of ['CALLGRID', 'CAMPAIGNS', 'PIPELINE', 'CRM', 'CREATORS', 'WORK', 'WEBSITE']) {
    const entry = intelligenceDomainEntry(domain);
    if (!entry) continue;
    const workspaceOk = entry.readAuthority.workspace === null || entry.readAuthority.workspace === role;
    const [resource, action] = (entry.readAuthority.permission ?? ':').split(':');
    const permissionOk = entry.readAuthority.permission === null || (await hasPermission(resource as never, action as never));
    domainAccess.set(domain, workspaceOk && permissionOk);
  }
  return {
    organizationId: session.organizationId,
    userId: session.userId,
    mayAssignOthers,
    mayReadCases,
    mayReadOrganizationDomain: (domain) => domainAccess.get(domain) === true,
  };
}

export interface PromoteView {
  readonly preview: PromotePreview;
  readonly workTypes: readonly { readonly id: string; readonly name: string }[];
  /** The person themselves first; others only when they may assign to others. */
  readonly assignees: readonly { readonly id: string; readonly name: string }[];
}

/** What the confirmation block needs, for one origin, for the signed-in person. Reads only. */
export async function loadPromoteView(session: AuthSession, origin: PromoteOrigin): Promise<PromoteView> {
  const actor = await promoteActorFor(session);
  const work = new WorkRepository(prisma);
  const [preview, types, members] = await Promise.all([
    new PromoteToWorkService(prisma).preview(actor, origin),
    work.listWorkTypes(session.organizationId),
    work.listActiveMembers(session.organizationId),
  ]);
  const self = members.find((m) => m.id === session.userId);
  const others = actor.mayAssignOthers ? members.filter((m) => m.id !== session.userId) : [];
  return {
    preview,
    workTypes: types.map((t) => ({ id: t.id, name: t.name })),
    assignees: [
      { id: session.userId, name: `${self?.name ?? 'You'} (you)` },
      ...others.map((m) => ({ id: m.id, name: m.name ?? m.email })),
    ],
  };
}
