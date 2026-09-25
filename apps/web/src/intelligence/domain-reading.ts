// Domain readings for a signed-in person. SERVER ONLY. Loop Intelligence Phases D-E, 2026-09-26.
//
// ONE ARTIFACT, TWO DEPTHS. A domain's Home tile and its own page both read the SAME stored DOMAIN digest
// through this loader and project it with the ONE shared projection (`projectDomainDigest`), so Home can
// never say something the domain page does not. The page additionally shows the digest's signals in depth.
//
// SCOPE IS THE SESSION'S. A PRINCIPAL reading is read with the session's own (organization, user); an
// ORGANIZATION reading only after the domain's registry read authority (permission AND workspace) is
// proved from the session -- the same authority the domain's surface enforces. Nothing here takes an
// organization, a user or a scope from a request. A page render READS; it never enqueues or produces.

import 'server-only';

import { IntelligenceDigestRepository, absentUntilMigrated, prisma, type IntelligenceDigestRecord } from '@emgloop/database';
import { intelligenceDomainEntry, projectDomainDigest, type DomainProjection, type IntelligenceDomain } from '@emgloop/shared';

import type { AuthSession } from '../auth/auth';
import { hasPermission } from '../auth/guard';
import { resolveWorkspaceRole } from '../workspaces/role-router';

export interface DomainReadingView {
  readonly projection: DomainProjection;
  /** The stored digest (for the page's depth), or null when none. Never rendered raw. */
  readonly digest: IntelligenceDigestRecord | null;
}

const NONE: DomainReadingView = { projection: projectDomainDigest(null, { connectionLive: false, sourceLastEvidenceAt: null, now: new Date(0) }), digest: null };

/** The viewer's OWN reading of a personal domain (Mail, Calendar, their own Work). */
export async function loadPrincipalReading(
  session: Pick<AuthSession, 'organizationId' | 'userId'>,
  domain: IntelligenceDomain,
  opts: { readonly now: Date; readonly connectionLive: boolean },
): Promise<DomainReadingView> {
  const principal = { organizationId: session.organizationId, userId: session.userId };
  const digest = await absentUntilMigrated(new IntelligenceDigestRepository(prisma).current(principal, domain, { now: opts.now }));
  if (!digest) return NONE;
  return { digest, projection: projectDomainDigest(digest, { connectionLive: opts.connectionLive, sourceLastEvidenceAt: null, now: opts.now }) };
}

/** Whether this session holds a domain's registry read authority (permission and workspace). */
export async function mayReadOrganizationReading(session: AuthSession, domain: IntelligenceDomain): Promise<boolean> {
  const entry = intelligenceDomainEntry(domain);
  if (!entry || !entry.scopes.includes('ORGANIZATION')) return false;
  if (entry.readAuthority.workspace !== null && resolveWorkspaceRole(session) !== entry.readAuthority.workspace) return false;
  if (entry.readAuthority.permission === null) return true;
  const [resource, action] = entry.readAuthority.permission.split(':');
  return hasPermission(resource as never, action as never);
}

/** The organization's reading of a shared domain, only for someone who holds the domain's read authority. */
export async function loadOrganizationReading(session: AuthSession, domain: IntelligenceDomain, opts: { readonly now: Date }): Promise<DomainReadingView | null> {
  if (!(await mayReadOrganizationReading(session, domain))) return null;
  const digest = await absentUntilMigrated(new IntelligenceDigestRepository(prisma).organizationCurrent(session.organizationId, domain, { now: opts.now }));
  if (!digest) return NONE;
  return { digest, projection: projectDomainDigest(digest, { connectionLive: true, sourceLastEvidenceAt: null, now: opts.now }) };
}
