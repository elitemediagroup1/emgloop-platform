// Who is calling a creator API route (Creator Hub, 2026-09-22). SERVER ONLY.
//
// Route handlers cannot redirect like pages, so they resolve the session themselves and answer
// 401/403 as JSON. The organization and the person come from the signed session, never from the
// request. A CREATOR-role session is a creator only when a profile is bound to that login.

import 'server-only';

import { getSession, type AuthSession } from '../auth/auth';
import { resolveWorkspaceRole } from '../workspaces/role-router';
import { creatorDomain } from './creator-runtime';
import type { CreatorActor, EmgActor } from '@emgloop/database';

export type ApiCaller =
  | { kind: 'CREATOR'; session: AuthSession; actor: CreatorActor }
  | { kind: 'EMG'; session: AuthSession; actor: EmgActor }
  | { kind: 'NONE'; status: 401 | 403; reason: string };

export async function apiCaller(): Promise<ApiCaller> {
  const session = await getSession();
  if (!session) return { kind: 'NONE', status: 401, reason: 'UNAUTHENTICATED' };
  const workspace = resolveWorkspaceRole(session);
  if (workspace === 'CREATOR') {
    const profile = await creatorDomain().creator.profileForUser(session.organizationId, session.userId);
    if (!profile) return { kind: 'NONE', status: 403, reason: 'NO_CREATOR_PROFILE' };
    return { kind: 'CREATOR', session, actor: { organizationId: session.organizationId, userId: session.userId, creatorProfileId: profile.id } };
  }
  if (workspace === 'ADMIN' || workspace === 'EMPLOYEE') {
    return { kind: 'EMG', session, actor: { organizationId: session.organizationId, userId: session.userId, canActOnAnyStep: workspace === 'ADMIN' } };
  }
  return { kind: 'NONE', status: 403, reason: 'NOT_ALLOWED' };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
