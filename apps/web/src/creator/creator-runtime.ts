// The creator domain, bound to a web request (Creator Hub, 2026-09-22). SERVER ONLY.
//
// TWO SEATS, ONE DOMAIN. `requireCreator()` is the creator seat's boundary: the CREATOR
// route authority (requireWorkspace) AND a CreatorProfile bound to this very login. A
// CREATOR-role login with no profile is refused, not defaulted. `emgActor()` is the EMG
// seat's: an ADMIN or EMPLOYEE authority from the same session guards every other page
// uses. Neither reads a creator id, an organization or a role from the request.

import 'server-only';

import { redirect } from 'next/navigation';
import { prisma, repositories, createCreatorDomain, type CreatorDomain, type CreatorActor, type EmgActor } from '@emgloop/database';
import type { AuthSession } from '../auth/auth';
import { requireWorkspace, requireWorkspaceSession } from '../workspaces/guard';
import { resolveWorkspaceRole } from '../workspaces/role-router';
import { LOOP_HOME } from '../auth/landing';

let domain: CreatorDomain | null = null;

/** The creator domain over the one Prisma client and the one Work OS repository. */
export function creatorDomain(): CreatorDomain {
  if (!domain) domain = createCreatorDomain(prisma, repositories.work);
  return domain;
}

export interface CreatorSeat {
  readonly session: AuthSession;
  readonly actor: CreatorActor;
  readonly profileId: string;
  readonly partyId: string;
  readonly displayName: string;
}

/**
 * The creator seat: CREATOR route authority, then the profile bound to this login. A creator
 * login with no profile yet is sent to Loop Home, which says so. Every creator page awaits
 * `requireWorkspace('CREATOR')` itself first (the tree's invariant); this adds the binding.
 */
export async function requireCreator(): Promise<CreatorSeat> {
  const session = await requireWorkspace('CREATOR');
  const profile = await creatorDomain().creator.profileForUser(session.organizationId, session.userId);
  if (!profile) redirect(LOOP_HOME);
  return {
    session,
    actor: { organizationId: session.organizationId, userId: session.userId, creatorProfileId: profile!.id },
    profileId: profile!.id,
    partyId: profile!.partyId,
    displayName: profile!.displayName,
  };
}

/** The creator seat when the session is one, else null. For Loop Home, which renders for every role. */
export async function creatorSeatOf(session: AuthSession): Promise<CreatorSeat | null> {
  if (resolveWorkspaceRole(session) !== 'CREATOR') return null;
  const profile = await creatorDomain().creator.profileForUser(session.organizationId, session.userId);
  if (!profile) return null;
  return {
    session,
    actor: { organizationId: session.organizationId, userId: session.userId, creatorProfileId: profile.id },
    profileId: profile.id,
    partyId: profile.partyId,
    displayName: profile.displayName,
  };
}

/**
 * The EMG seat for creator operations: an ADMIN authority may act on any production step; an
 * EMPLOYEE only on steps assigned to them (the service re-checks). Anyone else is refused.
 */
export interface EmgSeat {
  readonly session: AuthSession;
  readonly actor: EmgActor;
  readonly workspace: 'ADMIN' | 'EMPLOYEE';
}

export async function requireEmgActor(): Promise<EmgSeat> {
  const session = await requireWorkspaceSession();
  const workspace = resolveWorkspaceRole(session);
  if (workspace !== 'ADMIN' && workspace !== 'EMPLOYEE') redirect(LOOP_HOME);
  return {
    session,
    actor: { organizationId: session.organizationId, userId: session.userId, canActOnAnyStep: workspace === 'ADMIN' },
    workspace: workspace as 'ADMIN' | 'EMPLOYEE',
  };
}

// --- Addresses -----------------------------------------------------------------------------

export const CREATOR_ROOT = '/app/creator';
export const CREATOR_HREFS = Object.freeze({
  home: LOOP_HOME,
  content: `${CREATOR_ROOT}/content`,
  contentRecord: (id: string) => `${CREATOR_ROOT}/content/${encodeURIComponent(id)}`,
  review: (id: string, versionId: string) => `${CREATOR_ROOT}/content/${encodeURIComponent(id)}?review=${encodeURIComponent(versionId)}`,
  requestEdit: (id: string) => `${CREATOR_ROOT}/content/${encodeURIComponent(id)}/request-edit`,
  opportunities: `${CREATOR_ROOT}/opportunities`,
  opportunity: (id: string) => `${CREATOR_ROOT}/opportunities/${encodeURIComponent(id)}`,
  analytics: `${CREATOR_ROOT}/analytics`,
  tasks: `${CREATOR_ROOT}/tasks`,
  earnings: `${CREATOR_ROOT}/earnings`,
  profile: `${CREATOR_ROOT}/profile`,
  media: (versionId: string) => `/api/creator/media/${encodeURIComponent(versionId)}`,
});

export const EMG_HREFS = Object.freeze({
  creators: '/app/admin/creator-hub',
  creator: (profileId: string) => `/app/admin/creator-hub/${encodeURIComponent(profileId)}`,
  creatorContent: (profileId: string, contentId: string) => `/app/admin/creator-hub/${encodeURIComponent(profileId)}/content/${encodeURIComponent(contentId)}`,
  requests: '/app/admin/creator-hub/requests',
  adminWork: (workInstanceId: string) => `/app/admin/work/${encodeURIComponent(workInstanceId)}`,
  employeeWork: (workInstanceId: string) => `/app/employee/work/${encodeURIComponent(workInstanceId)}`,
});
