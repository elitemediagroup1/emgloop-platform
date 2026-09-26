import { redirect } from 'next/navigation';
import { getSession } from '../../auth/auth';
import { LOOP_HOME, loginPathFor } from '../../auth/landing';
import WorkspaceShell from '../../workspaces/WorkspaceShell';
import { navFor } from '../../workspaces/nav-access';
import { resolveWorkspaceRole } from '../../workspaces/role-router';
import { AdminHome } from './_home/admin-home';
import { ModuleHome } from './_home/module-home';
import { loadYourDay } from '../../daily-loop/your-day';
import { loadMailDashboard } from '../../daily-loop/mail-dashboard';
import { loadNeedsYou } from '../../daily-loop/needs-you';
import { loadMyQueueForHome } from './employee/work/work-data';
import { readerTimeZone } from '../../daily-loop/reader-zone';
import { createTimeView, resolveDisplayTimeZone } from '@emgloop/shared';
import { settle } from './_home/settle';
import { loadFrontDoor } from './_home/front-door-data';
import { creatorSeatOf } from '../../creator/creator-runtime';
import { CreatorHome } from '../../creator/creator-home';
import { promoteOriginFrom } from '../../work/promote-origin';
import { loadPromoteView } from '../../work/promote';
import { PromotePanel, promoteRefusalWords } from '../../work/promote-panel';
import { StateBlock } from './_loop-os/record';

// Loop Home — the first destination after sign-in, for every role.
//
// It renders here rather than redirecting to a role-specific URL, inside the one
// Loop shell. What the home shows follows authority, never a different address:
// Owner, Admin and Manager see the executive briefing (which enforces that authority
// itself); everyone else sees their own briefing and the areas of Loop they can open.
//
// YOUR DAY, YOUR MAIL AND NEEDS YOU ARE THE VIEWER'S OWN, FOR EVERYONE. The principal comes
// from the session, and no role widens it. Each is loaded ONCE here and handed to whichever
// Home renders, as data; the Homes compose, they do not load.
//
// EVERY SOURCE LOADS ON ITS OWN. A calendar or mailbox that cannot be read makes its
// own line say so; it never takes Home down with it. (A Home that read one missing
// table directly was a production outage on 2026-09-18.)
//
// THE FRONT DOOR'S ADDITIVE READS (a person's own chats, the intake counts) are
// gated by the navigation the person was offered and made here for the module Home; the
// executive Home makes its own, with the organization-wide ones, after stating its authority.

export const dynamic = 'force-dynamic';

/**
 * How many of the viewer's own open "needs you" items Home reads: all of them the loader will hold
 * (it scans at most 200), so the Chats figure and the briefing count conversations, not a cut-off
 * page. Home still SHOWS three and folds the rest.
 */
const HOME_NEEDS_YOU_LIMIT = 200;

export default async function LoopHome({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const session = await getSession();
  if (!session) redirect(loginPathFor(LOOP_HOME));

  const role = resolveWorkspaceRole(session);
  // A CREATOR login with a creator profile bound to it gets the creator's Home (Creator Hub,
  // 2026-09-22). A CREATOR login with no profile is not a creator yet and sees the module Home.
  const creatorSeat = await creatorSeatOf(session);
  const principal = { organizationId: session.organizationId, userId: session.userId };
  const zone = resolveDisplayTimeZone({ preference: null, device: readerTimeZone() });

  // A visit refreshes the calendar and the mailbox at most on their own schedules; everything
  // below is concluded from what is stored, so one sync serves Home and Mail alike.
  // The employee seat also reads its own work queue -- the same guarded read its My Work page
  // makes -- so Home can say what is due today. No other seat reads it (an Owner's work arrives
  // through the executive Home's dashboard; a read-only seat has no queue).
  const [dayResult, mailResult, needsYouResult, queueResult] = await Promise.all([
    settle(() => loadYourDay(principal)),
    settle(() => loadMailDashboard(principal, { timeZone: zone.timeZone })),
    settle(() => loadNeedsYou(principal, HOME_NEEDS_YOU_LIMIT)),
    role === 'EMPLOYEE' ? settle(() => loadMyQueueForHome()) : Promise.resolve(null),
  ]);
  const day = dayResult.ok ? dayResult.value : null;
  const mail = mailResult.ok ? mailResult.value : null;
  // NEEDS YOU is the viewer's own, for EVERY role: loaded once with the session's principal and
  // handed to whichever Home renders -- one loader, one scope, one set of items.
  const needsYou = needsYouResult.ok ? needsYouResult.value : [];
  const queue = queueResult?.ok ? queueResult.value.rows : [];
  const groups = await navFor(session);
  const time = createTimeView(zone, new Date());
  // Never the executive reads for this seat: the module Home is a person's own sources and the
  // areas they can open; loadFrontDoor settles each read on its own and never throws.
  const front = !creatorSeat && role !== 'ADMIN' ? await loadFrontDoor({ session, principal, groups, time, needsYou, executive: false }) : null;

  // PROMOTE TO WORK from Home (Loop Intelligence): a person's own private situation has no page of its own,
  // so its confirmation renders here, re-resolved inside the signed session's scope by the one service.
  const param = (k: string) => {
    const v = searchParams?.[k];
    return typeof v === 'string' ? v : null;
  };
  const promoteOrigin = creatorSeat ? null : promoteOriginFrom(param);
  const promoteView = promoteOrigin ? await loadPromoteView(session, promoteOrigin) : null;
  const promoteRefused = promoteRefusalWords(param('promoteResult'));

  return (
    <WorkspaceShell session={session}>
      {promoteRefused ? <StateBlock kind="attention" compact title="Promote to Work" body={promoteRefused} /> : null}
      {promoteView ? <PromotePanel view={promoteView} returnTo="/app" /> : null}
      {creatorSeat ? (
        <CreatorHome seat={creatorSeat} time={time} />
      ) : role === 'ADMIN' ? (
        <AdminHome session={session} principal={principal} day={day} dayFailed={!dayResult.ok} mail={mail} mailFailed={!mailResult.ok} needsYou={needsYou} groups={groups} />
      ) : (
        <ModuleHome name={session.name} userId={session.userId} groups={groups} time={time} day={day} dayFailed={!dayResult.ok} mail={mail} mailFailed={!mailResult.ok} needsYou={needsYou} queue={queue} front={front} />
      )}
    </WorkspaceShell>
  );
}
