// A domain's reading on its own page (Loop Intelligence Phase E). A server component: it resolves the
// viewer from the signed session, reads the SAME stored digest the Home tile projects (domain-reading.ts),
// and renders the depth panel -- or nothing at all for someone who does not hold the domain's read
// authority. The page's own guard still runs first; this never widens it.

import type { IntelligenceDomain } from '@emgloop/shared';

import { getSession } from '../auth/auth';
import { viewerTime } from '../time/viewer-time';
import { loadOrganizationReading, loadPrincipalReading } from './domain-reading';
import { DomainReadingPanel } from './domain-reading-view';

const EMPTY = 'Loop has not written a reading of this yet. Readings appear once the domain’s intelligence is switched on.';

export async function OrganizationReadingSection({ domain, title }: { domain: IntelligenceDomain; title: string }) {
  const session = await getSession();
  if (!session) return null;
  const view = await loadOrganizationReading(session, domain, { now: new Date() });
  if (!view) return null;
  return <DomainReadingPanel title={title} view={view} time={viewerTime()} empty={EMPTY} />;
}

export async function PrincipalReadingSection({ domain, title, connectionLive }: { domain: IntelligenceDomain; title: string; connectionLive: boolean }) {
  const session = await getSession();
  if (!session) return null;
  const view = await loadPrincipalReading(session, domain, { now: new Date(), connectionLive });
  return <DomainReadingPanel title={title} view={view} time={viewerTime()} empty={EMPTY} />;
}
