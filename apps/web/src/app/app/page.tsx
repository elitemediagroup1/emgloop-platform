import { redirect } from 'next/navigation';
import { getSession } from '../../auth/auth';
import { LOOP_HOME, loginPathFor } from '../../auth/landing';
import WorkspaceShell from '../../workspaces/WorkspaceShell';
import { navFor } from '../../workspaces/nav-access';
import { resolveWorkspaceRole } from '../../workspaces/role-router';
import { AdminHome } from './_home/admin-home';
import { ModuleHome } from './_home/module-home';
import { YourDay } from './_home/your-day';
import { RefreshCalendar } from './_home/refresh-calendar';
import { DayUnavailable } from './_home/day-calendar';
import { loadYourDay } from '../../daily-loop/your-day';
import { YourMail } from './_home/your-mail';
import { NeedsYou } from './_home/needs-you';
import { loadMailDashboard } from '../../daily-loop/mail-dashboard';
import { loadNeedsYou } from '../../daily-loop/needs-you';
import { mailCurrency } from './mail/_mail/mail-parts';
import { readerTimeZone } from '../../daily-loop/reader-zone';
import { createTimeView, resolveDisplayTimeZone } from '@emgloop/shared';
import { settle } from './_home/settle';

// Loop Home — the first destination after sign-in, for every role.
//
// It renders here rather than redirecting to a role-specific URL, inside the one
// Loop shell. What the home shows follows authority, never a different address:
// Owner, Admin and Manager see the executive review (which enforces that authority
// itself); everyone else sees their own day, their own mail, and the areas of Loop
// they can open.
//
// YOUR DAY AND YOUR MAIL ARE THE VIEWER'S OWN, FOR EVERYONE. The principal comes from
// the session, and no role widens it.
//
// EVERY SOURCE LOADS ON ITS OWN. A calendar or mailbox that cannot be read makes its
// own panel say so; it never takes Home down with it. (A Home that read one missing
// table directly was a production outage on 2026-09-18.)

export const dynamic = 'force-dynamic';

export default async function LoopHome() {
  const session = await getSession();
  if (!session) redirect(loginPathFor(LOOP_HOME));

  const role = resolveWorkspaceRole(session);
  const principal = { organizationId: session.organizationId, userId: session.userId };
  const zone = resolveDisplayTimeZone({ preference: null, device: readerTimeZone() });

  // A visit refreshes the calendar and the mailbox at most on their own schedules; everything
  // below is concluded from what is stored, so one sync serves Home and Mail alike.
  const [dayResult, mailResult, needsYouResult] = await Promise.all([
    settle(() => loadYourDay(principal)),
    settle(() => loadMailDashboard(principal, { timeZone: zone.timeZone })),
    settle(() => loadNeedsYou(principal)),
  ]);
  const day = dayResult.ok ? dayResult.value : null;
  const mail = mailResult.ok ? mailResult.value : null;
  const needsYou = needsYouResult.ok ? needsYouResult.value : [];
  const time = createTimeView(zone, new Date());

  // How current Loop is about this mailbox, in the Inbox's own words. Not connected at all: nothing.
  const connected = mail !== null && mail.mail.freshness !== 'NOT_CONNECTED' && mail.mail.freshness !== 'NOT_CONFIGURED';
  const currency = !mailResult.ok
    ? { line: 'Loop could not open your mail just now.' }
    : connected
      ? mailCurrency(mail!.mail.freshness, mail!.mail.lastSyncedAt, mail!.mail.syncInProgress, time)
      : null;

  return (
    <WorkspaceShell session={session}>
      {role === 'ADMIN' ? (
        <AdminHome session={session} principal={principal} day={day} dayFailed={!dayResult.ok} mail={mail} mailCurrency={currency} />
      ) : (
        <ModuleHome
          name={session.name}
          groups={await navFor(session)}
          day={dayResult.ok ? <YourDay view={day} refresh={<RefreshCalendar />} /> : <DayUnavailable title="Your day" />}
          mail={<YourMail dashboard={connected ? mail : null} time={time} currency={currency} />}
          needsYou={<NeedsYou items={needsYou} time={time} />}
        />
      )}
    </WorkspaceShell>
  );
}
