import { redirect } from 'next/navigation';

import { createTimeView, resolveDisplayTimeZone } from '@emgloop/shared';

import { getSession } from '../../../auth/auth';
import { LOOP_HOME, loginPathFor } from '../../../auth/landing';
import { requirePermission } from '../../../auth/guard';
import { loadMail } from '../../../daily-loop/mail';
import { readerTimeZone } from '../../../daily-loop/reader-zone';
import WorkspaceShell from '../../../workspaces/WorkspaceShell';
import { LoopPage, PageHead, Panel } from '../_loop-os/record';
import { MailEmpty, ThreadRow, mailCurrency } from './_mail/mail-parts';
import { RefreshMail } from './_mail/refresh-mail';

// MAIL -- the employee's own inbox, inside Loop (GM-2).
//
// WHOSE MAIL. The principal comes from the signed session and from nowhere else. Every read is
// scoped by organization AND user, so no role -- OWNER or ADMIN included -- can point this at
// somebody else's mailbox, and there is no admin variant of this page.
//
// IT IS A LIST OF CONVERSATIONS, NOT A MAIL CLIENT. No labels, no folders, no bulk actions, no
// starring: the things an employee opens Loop to do are find what needs them and answer it.
//
// AN EMPTY LIST AND AN UNREADABLE ONE NEVER LOOK ALIKE. "Nothing in the last two weeks" is only
// said in the states where Loop actually read the mailbox.

export const dynamic = 'force-dynamic';

export default async function MailPage() {
  const session = await getSession();
  if (!session) redirect(loginPathFor('/app/mail'));
  // The authority to see one's own work state. It grants your own rows and nobody else's.
  await requirePermission('employeeIntelligence', 'view');

  const principal = { organizationId: session.organizationId, userId: session.userId };
  const view = await loadMail(principal);
  const zone = resolveDisplayTimeZone({ preference: null, device: readerTimeZone() });
  const time = createTimeView(zone, view?.now ?? new Date());

  return (
    <WorkspaceShell session={session}>
      <LoopPage label="Mail">
        <PageHead trail={[{ label: 'Your Loop' }, { label: 'Mail' }]} title="Mail" subtitle="Your own conversations, and what they are waiting on." />
        {!view ? (
          <Panel title="Mail">
            <p className="loop-home__line muted">Loop has no mailbox for this account.</p>
          </Panel>
        ) : (
          <Panel title="Inbox">
            <div className="loop-mail">
              <p className="loop-home__line muted">
                {(() => {
                  const state = mailCurrency(view.freshness, view.lastSyncedAt, view.syncInProgress, time);
                  return (
                    <>
                      {state.line}
                      {state.href ? (
                        <>
                          {' '}
                          <a href={state.href}>{state.action}</a>
                        </>
                      ) : null}
                    </>
                  );
                })()}
              </p>

              {view.threads.length === 0 ? (
                <MailEmpty freshness={view.freshness} knows={view.knows} refresh={<RefreshMail />} />
              ) : (
                <>
                  <ul className="loop-mail__list">
                    {view.threads.map((thread) => (
                      <ThreadRow key={thread.threadId} thread={thread} time={time} />
                    ))}
                  </ul>
                  <RefreshMail />
                </>
              )}
            </div>
          </Panel>
        )}
      </LoopPage>
    </WorkspaceShell>
  );
}
