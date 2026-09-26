import { redirect } from 'next/navigation';
import { createTimeView, mailDomainIntelligence, mailViewRows, resolveDisplayTimeZone } from '@emgloop/shared';
import { getSession } from '../../../auth/auth';
import { loginPathFor } from '../../../auth/landing';
import { requirePermission } from '../../../auth/guard';
import { loadMailDashboard, type MailDashboard } from '../../../daily-loop/mail-dashboard';
import { readerTimeZone } from '../../../daily-loop/reader-zone';
import WorkspaceShell from '../../../workspaces/WorkspaceShell';
import { SidebarIcon } from '../../crm/_brand/SidebarIcon';
import { LoopPage, PageHead, StateBlock } from '../_loop-os/record';
import { MailEmpty, mailCurrency } from './_mail/mail-parts';
import { RefreshMail } from './_mail/refresh-mail';
import {
  ConversationRow,
  FilterBar,
  LaneSection,
  RecentThreads,
  SummaryCards,
  VIEW_TITLES,
  mailFilterFrom,
  mailHref,
} from './_mail/dashboard';

// MAIL -- email intelligence for what matters, not another inbox.
//
// WHOSE MAIL. The principal comes from the signed session and from nowhere else. Every read is
// scoped by organization AND user, so no role -- OWNER or ADMIN included -- can point this at
// somebody else's mailbox, and there is no admin variant of this page. The URL carries a view, a
// search and two switches (`mailFilterFrom`), never a person.
//
// IT IS AN OPERATING SURFACE BUILT FROM GMAIL, NOT A MAIL CLIENT. Four lanes -- needs my reply,
// follow-ups due, waiting on them, new opportunities -- decided by stated rules over what GM-1
// stored (`classifyMailThread`), each row saying why it is there. Every row opens the existing
// conversation, where the reply, Draft with Loop and Send are unchanged. Gmail itself is one link
// away for everything Loop deliberately does not do.
//
// IT LEADS WITH WHAT THE MAILBOX MEANS. `mailDomainIntelligence` -- the Mail domain's own reading of
// its lanes, counts and business areas only, never a subject or a person -- opens the page, above
// the lanes. Home repeats the same lines, so the two surfaces never read the mailbox differently.
//
// AN EMPTY LANE AND AN UNREADABLE MAILBOX NEVER LOOK ALIKE. Lanes are only concluded from a read
// Loop made; "nothing needs your reply" is only said about a current one.

import { MAIL_CONTENT_GOVERNANCE_ENV, mailContentGovernance } from '@emgloop/shared';
import { SourceContentAuthorizationRepository, prisma } from '@emgloop/database';
import { loadPrincipalReading } from '../../../intelligence/domain-reading';
import { DomainReadingPanel } from '../../../intelligence/domain-reading-view';
import { authorizeMailContentAction, revokeMailContentAction } from '../../../daily-loop/mail-content-actions';

export const dynamic = 'force-dynamic';

const GMAIL_URL = 'https://mail.google.com/';

export default async function MailPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const session = await getSession();
  if (!session) redirect(loginPathFor('/app/mail'));
  // The authority to see one's own work state. It grants your own rows and nobody else's.
  await requirePermission('employeeIntelligence', 'view');

  const principal = { organizationId: session.organizationId, userId: session.userId };
  const zone = resolveDisplayTimeZone({ preference: null, device: readerTimeZone() });
  const state = mailFilterFrom(searchParams);

  // A mailbox that cannot be read right now degrades this page to saying so -- never to an error.
  let dashboard: MailDashboard | null | 'UNAVAILABLE';
  try {
    dashboard = await loadMailDashboard(principal, { timeZone: zone.timeZone });
  } catch {
    dashboard = 'UNAVAILABLE';
  }
  const time = createTimeView(zone, dashboard && dashboard !== 'UNAVAILABLE' ? dashboard.now : new Date());

  // LOOP INTELLIGENCE (Phase D). The person's own MAIL reading -- the SAME stored digest Home's Mail tile
  // leads with -- and their own Mail-content consent. The consent is OFFERED only once the deployment
  // names the recorded counterparty-consent decision (UNRESOLVED today); stopping is always offered.
  const governance = mailContentGovernance(process.env[MAIL_CONTENT_GOVERNANCE_ENV]);
  const [reading, consent] = await Promise.all([
    loadPrincipalReading(session, 'MAIL', { now: time.now, connectionLive: true }).catch(() => null),
    new SourceContentAuthorizationRepository(prisma).get(session.organizationId, session.userId, 'GMAIL').catch(() => null),
  ]);
  const contentOn = consent !== null && consent.revokedAt === null;

  return (
    <WorkspaceShell session={session}>
      <LoopPage label="Mail">
        <PageHead
          trail={[{ label: 'Your Loop' }, { label: 'Mail' }]}
          title="Mail"
          subtitle="Email intelligence for what matters. Not another inbox."
          actions={
            <div className="loop-mx__head-actions">
              <p className="loop-mx__tagline">“Turn email into opportunities.”</p>
              <a href={GMAIL_URL} className="loop-btn" target="_blank" rel="noopener noreferrer">
                Open Gmail
                <SidebarIcon name="external" size={15} />
              </a>
            </div>
          }
        />

        {dashboard === 'UNAVAILABLE' ? (
          <StateBlock
            kind="attention"
            title="Loop could not open your mail just now"
            body="Nothing is wrong with your mailbox. Loop could not read what it stored about it, so it shows nothing rather than an empty inbox. Try again in a moment."
          />
        ) : !dashboard ? (
          <StateBlock kind="empty" title="No mailbox" body="Loop has no mailbox for this account." />
        ) : (
          <MailBody dashboard={dashboard} state={state} time={time} />
        )}

        {contentOn || governance.state === 'DECIDED' ? (
          <DomainReadingPanel
            title="Mail intelligence"
            view={reading}
            time={time}
            empty={contentOn ? 'Loop has not written a reading of your mail yet.' : 'Loop reads only headers today. Turn on mail reading below for a reading of what your threads say.'}
          />
        ) : null}
        {contentOn ? (
          <form action={revokeMailContentAction} className="loop-btnrow" data-mail-content="on">
            <button type="submit" className="loop-btn loop-btn--quiet">Stop mail reading</button>
          </form>
        ) : governance.state === 'DECIDED' ? (
          <form action={authorizeMailContentAction} className="loop-btnrow" data-mail-content="offered">
            <button type="submit" className="loop-btn">Turn on mail reading</button>
          </form>
        ) : null}
      </LoopPage>
    </WorkspaceShell>
  );
}

function MailBody({ dashboard, state, time }: { dashboard: MailDashboard; state: ReturnType<typeof mailFilterFrom>; time: ReturnType<typeof createTimeView> }) {
  const { mail, summary, rows, current } = dashboard;
  const currency = mailCurrency(mail.freshness, mail.lastSyncedAt, mail.syncInProgress, time);

  return (
    <div className="loop-mx">
      <div className="loop-mx__status">
        <p className="loop-mx__currency">
          {currency.line}
          {currency.href ? (
            <>
              {' '}
              <a href={currency.href}>{currency.action}</a>
            </>
          ) : null}
        </p>
        {/* Refresh reads what changed since Loop's position in the mailbox. Before the first read
            there is no position, so there is nothing for it to do and it is not offered. */}
        {mail.canRefresh ? <RefreshMail /> : null}
      </div>

      {!dashboard.concludable ? (
        <MailEmpty freshness={mail.freshness} knows={mail.knows} refresh={mail.canRefresh ? <RefreshMail /> : undefined} />
      ) : (
        <>
          <MailMeaning dashboard={dashboard} />
          <SummaryCards summary={summary} state={state} />
          <FilterBar summary={summary} state={state} />
          {state.view === 'dashboard' && state.query.trim() === '' && !state.unreadOnly && !state.includeNotifications ? (
            <Dashboard dashboard={dashboard} state={state} time={time} current={current} />
          ) : (
            <ListView dashboard={dashboard} state={state} time={time} current={current} />
          )}
        </>
      )}
    </div>
  );
}

/** The domain's interpretation, at most two sentences. Nothing when the lanes hold nothing: never a zero. */
function MailMeaning({ dashboard }: { dashboard: MailDashboard }) {
  const { lines } = mailDomainIntelligence(
    dashboard.rows.map((r) => r.insight),
    dashboard.summary,
    dashboard.now,
  );
  if (lines.length === 0) return null;
  return (
    <section className="loop-stack" aria-label="What your mail means" data-mail-intelligence>
      {lines.map((line) => (
        <p key={line} className="loop-panel__lead">
          {line}
        </p>
      ))}
    </section>
  );
}

function Dashboard({ dashboard, state, time, current }: { dashboard: MailDashboard; state: ReturnType<typeof mailFilterFrom>; time: ReturnType<typeof createTimeView>; current: boolean }) {
  const byId = new Map(dashboard.rows.map((r) => [r.insight.threadId, r]));
  const lane = (view: 'needs-reply' | 'follow-ups' | 'waiting' | 'opportunities') =>
    mailViewRows(
      dashboard.rows.map((r) => r.insight),
      { view, query: '', unreadOnly: false, includeNotifications: false },
    ).map((i) => byId.get(i.threadId)!);
  const [needsReply, followUps, waiting, opportunities] = [lane('needs-reply'), lane('follow-ups'), lane('waiting'), lane('opportunities')];
  const none = (what: string) => (current ? what : `${what.replace(/\.$/, '')} when Loop last read your mail.`);

  return (
    <>
      <div className="loop-mx__grid">
        <div className="loop-mx__col">
          <LaneSection title="Needs my reply" icon="mail" tone="crit" rows={needsReply.slice(0, 5)} total={needsReply.length} href={mailHref(state, { view: 'needs-reply' })} time={time} context="lane" empty={none('No conversation needs your reply.')} />
          <LaneSection title="Waiting on them" icon="clock" tone="warn" rows={waiting.slice(0, 5)} total={waiting.length} href={mailHref(state, { view: 'waiting' })} time={time} context="lane" empty={none('You are not waiting on anybody.')} />
        </div>
        <div className="loop-mx__col">
          <LaneSection title="Follow-ups due" icon="send" tone="accent" rows={followUps.slice(0, 5)} total={followUps.length} href={mailHref(state, { view: 'follow-ups' })} time={time} context="lane" empty={none('No follow-up is due.')} />
          <LaneSection title="New opportunities" icon="target" tone="good" rows={opportunities.slice(0, 5)} total={opportunities.length} href={mailHref(state, { view: 'opportunities' })} time={time} context="opportunity" empty={none('No new opportunity signals in your mail.')} />
        </div>
      </div>
      <RecentThreads rows={dashboard.recent} time={time} href={mailHref(state, { view: 'all' })} />
      <p className="loop-mx__footnote">
        Loop decides these from who wrote last, when, and what Gmail itself filed as promotions or updates — never from reading a
        message. Notification mail stays out unless you include it.
      </p>
    </>
  );
}

function ListView({ dashboard, state, time, current }: { dashboard: MailDashboard; state: ReturnType<typeof mailFilterFrom>; time: ReturnType<typeof createTimeView>; current: boolean }) {
  const view = state.view === 'dashboard' ? 'all' : state.view;
  const byId = new Map(dashboard.rows.map((r) => [r.insight.threadId, r]));
  const rows = mailViewRows(
    dashboard.rows.map((r) => r.insight),
    { view, query: state.query, unreadOnly: state.unreadOnly, includeNotifications: state.includeNotifications },
  ).map((i) => byId.get(i.threadId)!);
  const context = view === 'opportunities' ? 'opportunity' : view === 'needs-reply' || view === 'follow-ups' || view === 'waiting' ? 'lane' : 'any';
  const title = VIEW_TITLES[view];

  return (
    <section className="loop-mx__lane" aria-label={title}>
      <header className="loop-mx__lane-head">
        <h2 className="loop-mx__lane-title">{title}</h2>
        <span className="loop-mx__count">{rows.length === 1 ? '1 conversation' : `${rows.length} conversations`}</span>
        <a href={mailHref(state, { view: 'dashboard', query: '', unreadOnly: false, includeNotifications: false })} className="loop-mx__viewall">
          Back to dashboard
        </a>
      </header>
      {rows.length === 0 ? (
        <p className="loop-mx__empty">
          {state.query.trim() !== ''
            ? `No conversation matches “${state.query.trim()}”.`
            : current
              ? 'Nothing here right now.'
              : 'Nothing was here when Loop last read your mail.'}
        </p>
      ) : (
        <ul className="loop-mx__list">
          {rows.slice(0, 100).map((row) => (
            <ConversationRow key={row.insight.threadId} row={row} time={time} context={context} />
          ))}
        </ul>
      )}
    </section>
  );
}
