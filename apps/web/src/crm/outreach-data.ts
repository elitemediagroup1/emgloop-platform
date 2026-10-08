// The People command center's reads, bound to the signed session (CRM slice 6). SERVER ONLY.
//
// The organization and the viewer come from the session (requireCrmContext) and nowhere else. The
// viewer's own Gmail and Calendar freshness comes from the one derivation every surface uses
// (`loadSourceState`), so this page can never claim mail is current when Mail says it is not.
//
// `null` while the slice 6 migration has not reached this database: an honest "not available here
// yet", never a crash (absentUntilMigrated).

import 'server-only';
import { CrmPeopleCommandService, absentUntilMigrated, prisma, type CrmViewerSources } from '@emgloop/database';

import { googleWorkspace } from '../google/google-runtime';
import { loadSourceState } from '../daily-loop/source-state';
import { viewerTime } from '../time/viewer-time';
import { requireCrmContext } from './crm-data';

export { DISCOVER_HREF } from './outreach-hrefs';

const command = new CrmPeopleCommandService(prisma);

/** What the viewer's own Gmail and Calendar can say right now. Unknown on any failure: never invented. */
async function viewerSources(principal: { organizationId: string; userId: string }, now: Date): Promise<CrmViewerSources> {
  try {
    const status = await googleWorkspace().status(principal);
    if (!status.permitted) return { gmail: null, calendar: null };
    const [gmail, calendar] = await Promise.all([loadSourceState(principal, 'GMAIL', status, now), loadSourceState(principal, 'CALENDAR', status, now)]);
    return {
      gmail: { freshness: gmail.freshness, lastReadAt: gmail.lastReadAt },
      calendar: { freshness: calendar.freshness, lastReadAt: calendar.lastReadAt },
    };
  } catch {
    return { gmail: null, calendar: null };
  }
}

async function bound() {
  const ctx = await requireCrmContext();
  const actor = { organizationId: ctx.organizationId, userId: ctx.userId };
  const time = viewerTime();
  return { actor, time, sources: await viewerSources(actor, time.now) };
}

export async function readPeopleCommand() {
  const { actor, time, sources } = await bound();
  const result = await absentUntilMigrated(command.directory(actor, sources, { now: time.now, timeZone: time.timeZone }));
  return { result, time };
}

export async function readPersonOutreach(partyId: string) {
  const { actor, time, sources } = await bound();
  const result = await absentUntilMigrated(command.person(actor, partyId, sources, { now: time.now, timeZone: time.timeZone }));
  return { result, time };
}

export async function readDiscovery() {
  const { actor, time, sources } = await bound();
  const result = await absentUntilMigrated(command.discovery(actor, sources, { now: time.now }));
  return { result, time };
}
