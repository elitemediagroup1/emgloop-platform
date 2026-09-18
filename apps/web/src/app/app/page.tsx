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
import { loadYourDay } from '../../daily-loop/your-day';
import { YourMail } from './_home/your-mail';
import { loadMail } from '../../daily-loop/mail';
import { loadMailAttention } from '../../daily-loop/mail-attention';
import { readerTimeZone } from '../../daily-loop/reader-zone';
import { createTimeView, resolveDisplayTimeZone } from '@emgloop/shared';

// Loop Home — the first destination after sign-in, for every role.
//
// It renders here rather than redirecting to a role-specific URL, inside the one
// Loop shell. What the home shows follows authority, never a different address:
// Owner, Admin and Manager see the operational overview (which enforces that
// authority itself); everyone else sees the areas of Loop they can open.
//
// YOUR DAY COMES FIRST, FOR EVERYONE (DL-4). An owner is an employee too, and the
// question "what does my day look like" is the same question whatever else a
// person can open. It is their OWN calendar, always: the principal comes from the
// session, and no role widens it. It is handed to whichever home this person sees,
// which renders it at the top of the one page, above the surfaces already here.

export const dynamic = 'force-dynamic';

export default async function LoopHome() {
  const session = await getSession();
  if (!session) redirect(loginPathFor(LOOP_HOME));

  const role = resolveWorkspaceRole(session);
  const principal = { organizationId: session.organizationId, userId: session.userId };
  const day = <YourDay view={await loadYourDay(principal)} refresh={<RefreshCalendar />} />;

  // YOUR MAIL (GM-3). A visit refreshes the mailbox at most every five minutes; the attention
  // items are then recomputed from what is stored, so one sync serves Home and the Inbox alike.
  // A person with no Google connection gets nothing here rather than an empty promise.
  const mail = await loadMail(principal, { limit: 1 });
  const zone = resolveDisplayTimeZone({ preference: null, device: readerTimeZone() });
  const attention = mail ? await loadMailAttention(principal, { timeZone: zone.timeZone }) : null;
  const yourMail = (
    <YourMail
      view={attention}
      time={createTimeView(zone, new Date())}
      unavailable={mail && !mail.knows ? 'Loop has not read your mail recently enough to say what it is waiting on.' : null}
    />
  );

  return (
    <WorkspaceShell session={session}>
      {role === 'ADMIN' ? (
        <AdminHome day={day} mail={yourMail} />
      ) : (
        <ModuleHome name={session.name} groups={await navFor(session)} day={day} mail={yourMail} />
      )}
    </WorkspaceShell>
  );
}
