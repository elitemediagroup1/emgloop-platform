import { redirect } from 'next/navigation';
import { createTimeView, resolveDisplayTimeZone } from '@emgloop/shared';

import { getSession } from '../../../auth/auth';
import { LOOP_HOME, loginPathFor } from '../../../auth/landing';
import { requirePermission } from '../../../auth/guard';
import { loadYourDay, type YourDayView } from '../../../daily-loop/your-day';
import { readerTimeZone } from '../../../daily-loop/reader-zone';
import WorkspaceShell from '../../../workspaces/WorkspaceShell';
import { LoopPage, PageHead } from '../_loop-os/record';
import { CalendarView } from './_calendar/calendar-view';
import { PrincipalReadingSection } from '../../../intelligence/domain-reading-section';

// CALENDAR -- the viewer's own day. A domain page, not configuration.
//
// WHOSE DAY. The principal comes from the signed session and from nowhere else; `loadYourDay` scopes
// every read by organization AND user, so no role -- OWNER or ADMIN included -- can open somebody
// else's calendar here. The URL carries nothing.
//
// THE GATE IS MAIL'S. The day is the viewer's own work state derived from their own Google connection
// (DL-1), the same authority `/app/mail` enforces (`employeeIntelligence:view`) and the one the
// Refresh action's `employeeIntelligence:update` sits beside. `loadYourDay` additionally answers null
// for a principal with no Google connection at all (an AI Employee), which is said, not drawn empty.
//
// ONE READ, SHARED. `loadYourDay` is the read Home and Mail make: the same visit-refresh schedule,
// the same freshness, and the reader's own zone. Connections is only where the calendar is connected
// or managed; this page points there.

export const dynamic = 'force-dynamic';

export default async function CalendarPage() {
  const session = await getSession();
  if (!session) redirect(loginPathFor('/app/calendar'));
  // The authority to see one's own work state. It grants your own rows and nobody else's.
  await requirePermission('employeeIntelligence', 'view');

  const principal = { organizationId: session.organizationId, userId: session.userId };

  // A calendar that cannot be read right now degrades this page to saying so -- never to an error.
  let day: YourDayView | null | 'UNAVAILABLE';
  try {
    day = await loadYourDay(principal);
  } catch {
    day = 'UNAVAILABLE';
  }
  // The day was resolved in the reader's own zone; its times are shown in that same zone. Without a
  // day, the zone is the reader's device zone, as Home resolves it.
  const zone = day && day !== 'UNAVAILABLE' ? day.zone : resolveDisplayTimeZone({ preference: null, device: readerTimeZone() });
  const time = createTimeView(zone, day && day !== 'UNAVAILABLE' ? day.now : new Date());

  return (
    <WorkspaceShell session={session}>
      <LoopPage label="Calendar">
        <PageHead
          trail={[{ label: 'Home', href: LOOP_HOME }, { label: 'Calendar' }]}
          title="Calendar"
          subtitle="Your own day: what is on now, what is next, and what is clear."
        />
        <CalendarView day={day} time={time} />
        <PrincipalReadingSection domain="CALENDAR" title="Your day, read" connectionLive={day !== null && day !== 'UNAVAILABLE'} />
      </LoopPage>
    </WorkspaceShell>
  );
}
