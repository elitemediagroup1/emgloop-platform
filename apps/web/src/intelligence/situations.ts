// Situations for a signed-in person. SERVER ONLY. Loop Intelligence Phase F, 2026-09-26.
//
// TWO SCOPES, READ SEPARATELY, EACH IN THE QUERY. The person's PRIVATE situations are read as them (the
// repository resolves the owner in the query; nobody else's is reachable, whatever their role). The
// organization's situations are read only for someone who holds the read authority of EVERY domain a
// situation cites -- the most restrictive evidence decides who sees it, at read time as at write time.
// A page render READS; it never synthesizes, verifies or enqueues.

import 'server-only';

import { SituationRepository, absentUntilMigrated, prisma, type SituationView } from '@emgloop/database';
import type { IntelligenceDomain } from '@emgloop/shared';

import type { AuthSession } from '../auth/auth';
import { mayReadOrganizationReading } from './domain-reading';

export interface SituationsRead {
  readonly personal: readonly SituationView[];
  /** Null when this person may read no organization situation at all. */
  readonly organization: readonly SituationView[] | null;
}

export async function loadSituations(session: AuthSession): Promise<SituationsRead> {
  const repo = new SituationRepository(prisma);
  const personal = (await absentUntilMigrated(repo.open({ scope: 'PRINCIPAL', organizationId: session.organizationId, userId: session.userId }, 5))) ?? [];
  const org = (await absentUntilMigrated(repo.open({ scope: 'ORGANIZATION', organizationId: session.organizationId }, 10))) ?? [];
  const readable = new Map<string, boolean>();
  const may = async (domain: string) => {
    if (!readable.has(domain)) readable.set(domain, await mayReadOrganizationReading(session, domain as IntelligenceDomain));
    return readable.get(domain)!;
  };
  const visible: SituationView[] = [];
  let anyAuthority = false;
  for (const s of org) {
    const domains = s.record?.domains ?? [];
    if (domains.length === 0) continue;
    let ok = true;
    for (const d of domains) if (!(await may(d))) ok = false;
    if (ok) {
      anyAuthority = true;
      visible.push(s);
    }
  }
  return { personal, organization: anyAuthority || org.length === 0 ? visible.slice(0, 5) : null };
}

/**
 * Whether a Case is an organization SITUATION and, if so, whether this viewer may see it: they must hold
 * the read authority of every domain it cites. The Case page answers HIDDEN with not-found.
 */
export async function situationCaseFor(session: AuthSession, caseId: string): Promise<{ readonly kind: 'NOT_SITUATION' } | { readonly kind: 'HIDDEN' } | { readonly kind: 'VISIBLE'; readonly view: SituationView }> {
  const view = await absentUntilMigrated(new SituationRepository(prisma).get({ scope: 'ORGANIZATION', organizationId: session.organizationId }, caseId));
  if (!view) return { kind: 'NOT_SITUATION' };
  for (const d of view.record?.domains ?? []) if (!(await mayReadOrganizationReading(session, d as IntelligenceDomain))) return { kind: 'HIDDEN' };
  if (!view.record) return { kind: 'HIDDEN' };
  return { kind: 'VISIBLE', view };
}
