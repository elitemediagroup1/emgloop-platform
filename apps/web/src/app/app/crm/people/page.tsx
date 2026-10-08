import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  CRM_CADENCE_STAGES,
  CRM_CONVERSATION_STATES,
  CRM_CONVERSATION_STATE_LABELS,
  CRM_PEOPLE_PAGE_SIZE,
  CRM_PEOPLE_PRESETS,
  CRM_PEOPLE_PRESET_LABELS,
  crmPeopleHref,
  pageCrmPeople,
  parseCrmPeopleFilters,
  summarizeCrmPeople,
  type CrmPeopleSearchParams,
} from '@emgloop/shared';
import { requirePermission } from '../../../../auth/guard';
import { personHref, PEOPLE_HREF } from '../../../../crm/crm-slice-data';
import { DISCOVER_HREF, readPeopleCommand } from '../../../../crm/outreach-data';
import {
  basisText,
  cadenceText,
  conversationState,
  dueText,
  lastTouchText,
  mailFreshnessText,
  replyText,
  DUE_FILTER_LABELS,
  PEOPLE_SUMMARY_LABELS as L,
} from '../../../../crm/outreach-display';
import { ActionButton, LoopPage, PageHead, Panel, ReadFailed, StateBlock, SummaryStrip, type ActionSpec } from '../../_loop-os/record';

export const dynamic = 'force-dynamic';

// People: the outreach command center (CRM slice 6). docs/architecture/crm-people-command-center.md.
//
// Established PERSON Parties only: intake records, unidentified callers and identity-review records
// are not People (Product C-04). Each row puts two authorities side by side and says which is which:
//   - SHARED CRM facts: title, company and creator context, the human-set state and next action, the
//     latest note -- the same for everyone who may see People;
//   - YOUR OWN Gmail and Calendar: sends, replies, the cadence and meetings, derived from your mailbox
//     and nobody else's (daily-loop-employee-intelligence.md §20.1). A colleague sees theirs.
// Counts are counts of these rows. What Gmail cannot vouch for (not connected, stale) says so instead
// of reading as "no reply". Identity state is secondary metadata here.
//
// Filtering, ordering and paging are server-side over the whole directory, in a fixed number of
// queries. Search covers names, titles and companies, never a contact value.

const IDENTITY_REVIEW_HREF = '/crm/parties';

export default async function PeoplePage({ searchParams }: { searchParams?: CrmPeopleSearchParams & { refused?: string } }) {
  await requirePermission('identityResolution', 'view');
  const parsed = parseCrmPeopleFilters(searchParams);
  if (!parsed.ok) {
    const href = crmPeopleHref(PEOPLE_HREF, parsed.params);
    redirect(`${href}${href.includes('?') ? '&' : '?'}refused=contact`);
  }
  const { result, time } = await readPeopleCommand();
  const trail = [{ label: 'CRM' }, { label: 'People', href: PEOPLE_HREF }];
  const params = parsed.params;
  const filtered = Object.keys(params).length > 0;
  const href = (p: Readonly<Partial<Record<string, string>>>, page = 1) => crmPeopleHref(PEOPLE_HREF, p, page);

  if (result === null) {
    return (
      <LoopPage label="People">
        <PageHead trail={trail} title="People" />
        <StateBlock kind="unavailable" title="The People command center is not available here yet." body="This workspace's database does not have the outreach records yet (migration 20261013000000_crm_people_command_center)." />
      </LoopPage>
    );
  }
  if (result.outcome === 'NOT_AUTHORIZED') {
    return (
      <LoopPage label="People">
        <PageHead trail={trail} title="People" />
        <StateBlock kind="denied" title="You cannot view people in this workspace." body="Your membership does not include canonical identity. Ask a workspace administrator if you need it." />
      </LoopPage>
    );
  }
  if (result.outcome === 'TOO_LARGE') {
    return (
      <LoopPage label="People">
        <PageHead trail={trail} title="People" />
        <StateBlock kind="error" title="This directory is larger than the command center reads." body={`More than ${result.limit.toLocaleString('en-US')} people are established here. Counts would be partial, so none are shown.`} />
      </LoopPage>
    );
  }
  if (result.outcome !== 'OK') return <ReadFailed what="people" />;

  const now = time.now;
  const summary = summarizeCrmPeople(result.rows, now);
  // "Replied — needs response" is semantic. When the body-aware reading exists, this preset follows
  // that reading instead of pretending message metadata can know whether an answer is owed.
  const semanticReplyPreset = parsed.filters.preset === 'replied-needs-response';
  const viewRows = semanticReplyPreset
    ? result.rows.filter((row) => result.intelligenceByParty.get(row.partyId)?.suggestion === 'REPLY')
    : result.rows;
  const viewFilters = semanticReplyPreset ? { ...parsed.filters, preset: null } : parsed.filters;
  const view = pageCrmPeople(viewRows, viewFilters, parsed.page, now);
  const mail = result.mail;
  const mailKnown = mail.permitted && mail.gmail.state !== 'UNAVAILABLE';
  const n = (v: number) => v.toLocaleString('en-US');
  const mailCount = (v: number): string | null => (mailKnown ? n(v) : null);
  const aiRows = result.rows
    .map((row) => ({ row, ai: result.intelligenceByParty.get(row.partyId) ?? null }))
    .filter((x) => x.ai !== null);
  // Metadata can prove a reply exists, but not that an answer is owed. Only a human state or the
  // governed body-aware reading may make that semantic suggestion. It is still a suggestion, never a write.
  const aiRepliesNeedingResponse = aiRows.filter((x) => x.ai!.suggestion === 'REPLY').length;
  const effectiveRepliesNeedingResponse = summary.repliesNeedingResponse + aiRepliesNeedingResponse;
  const effectiveDueToday = summary.dueToday;
  const effectiveOverdue = summary.overdue;
  const suggestionLabel = (s: string) =>
    s === 'REPLY' ? 'Reply' : s === 'WAIT' ? 'Waiting on them' : s === 'CIRCLE_BACK' ? 'Circle back' : s === 'REVIEW' ? 'Review' : 'No immediate action';
  const establish: ActionSpec = { label: '+ Establish person', href: IDENTITY_REVIEW_HREF };
  const discover: ActionSpec = result.discovery
    ? { label: `Possible new people · ${n(result.discovery.count)}`, href: DISCOVER_HREF, primary: result.discovery.count > 0 }
    : { label: 'Possible new people', href: null, reason: mail.permitted ? 'Your Gmail is not connected or has not been read yet.' : 'Your membership does not include your own mail intelligence.' };
  const first = view.filteredCount === 0 ? 0 : (view.page - 1) * CRM_PEOPLE_PAGE_SIZE + 1;
  const last = (view.page - 1) * CRM_PEOPLE_PAGE_SIZE + view.rows.length;

  return (
    <LoopPage label="People">
      <PageHead
        trail={trail}
        title="People"
        subtitle="Who you are working with, where each conversation stands, and what is due next."
        actions={
          <div className="loop-btnrow">
            <ActionButton action={discover} />
            <ActionButton action={establish} />
          </div>
        }
      />

      <Panel title="AI outreach brief">
        {aiRows.length > 0 ? (
          <>
            <p className="loop-panel__lead">
              Loop has body-aware AI readings for {n(aiRows.length)} CRM-linked {aiRows.length === 1 ? 'conversation' : 'conversations'}.
              {effectiveRepliesNeedingResponse > 0 ? ` ${n(effectiveRepliesNeedingResponse)} currently need your response.` : ' None of the AI-reviewed conversations currently require your reply.'}
            </p>
            <ul className="loop-note" style={{ margin: '10px 0 0', paddingLeft: 18 }}>
              {aiRows
                .filter((x) => x.ai!.suggestion !== 'NONE')
                .slice(0, 4)
                .map(({ row, ai }) => (
                  <li key={row.partyId}>
                    <Link href={personHref(row.partyId)}>{row.displayName}</Link>: {suggestionLabel(ai!.suggestion)}
                    {ai!.suggestionText ? ` — ${ai!.suggestionText}` : ''}
                  </li>
                ))}
            </ul>
            <p className="loop-note" style={{ marginTop: 10 }}>
              AI summarizes and suggests; it does not silently change a CRM state or create a relationship.
            </p>
          </>
        ) : (
          <>
            <p className="loop-panel__lead">AI conversation summaries are not enabled for this mailbox yet.</p>
            <p className="loop-note">
              The KPI strip below still shows deterministic Gmail and Calendar facts. This panel is reserved for AI interpretation of conversation content and will not substitute source notes or metadata for an AI summary.
            </p>
          </>
        )}
      </Panel>
      <StateBlock
        kind={mailKnown && mail.gmail.state === 'FRESH' ? 'empty' : 'attention'}
        compact
        title={mail.permitted ? mailFreshnessText(mail.gmail, time) : 'Your own mail intelligence is not part of your membership.'}
        body="Sends, replies, the cadence and meetings come from your own Gmail and Calendar; colleagues see their own. Titles, context, notes and the state a person set are shared."
      />
      {mail.keyMismatchedPoints > 0 ? (
        <StateBlock kind="error" compact title="Some contact points cannot be matched to mail here." body={`${n(mail.keyMismatchedPoints)} were recorded under a different identifier key than this server holds, so their mail is not linked. Nothing is guessed in their place.`} />
      ) : null}
      {mail.truncated ? <StateBlock kind="attention" compact title="Your mail is larger than one read covers." body="Some older messages are not considered, so counts may be low." /> : null}
      {searchParams?.refused === 'contact' ? (
        <StateBlock kind="attention" compact title="Contact details are not searchable." body="Search finds people by name, title and company. An email address or phone number is never searched." />
      ) : null}

      <SummaryStrip
        label="Outreach summary"
        items={[
          { label: L.activeContacts, value: mailKnown ? n(summary.activeContacts) : null, unknownText: 'Needs your Gmail' },
          { label: L.awaitingReply, value: mailCount(summary.awaitingReply), unknownText: 'Needs your Gmail' },
          { label: L.dueToday, value: n(effectiveDueToday) },
          { label: L.overdue, value: n(effectiveOverdue) },
          { label: L.repliesNeedingResponse, value: mailCount(effectiveRepliesNeedingResponse), unknownText: 'Needs your Gmail' },
          { label: L.activeOrInterested, value: n(summary.activeOrInterested) },
          { label: L.meetingsUpcoming, value: mail.calendar !== 'UNAVAILABLE' ? n(summary.meetingsUpcoming) : null, unknownText: 'Needs your Calendar' },
          { label: L.onHold, value: n(summary.onHold) },
          { label: L.recentlyClosed, value: n(summary.recentlyClosed) },
          { label: L.touchedThisWeek, value: mailCount(summary.touchedThisWeek), unknownText: 'Needs your Gmail' },
          { label: L.newRepliesThisWeek, value: mailCount(summary.newRepliesThisWeek), unknownText: 'Needs your Gmail' },
          { label: L.reviewRequired, value: n(summary.reviewRequired) },
          { label: L.possibleNewPeople, value: result.discovery ? n(result.discovery.count) : null, unknownText: 'Needs your Gmail' },
          { label: L.newPeopleThisWeek, value: n(summary.newPeopleThisWeek) },
        ]}
      />

      <nav className="loop-filters" aria-label="Outreach views">
        <Link className="loop-filter" href={PEOPLE_HREF} aria-current={!params.preset ? 'true' : undefined}>
          Everyone · {n(summary.totalPeople)}
        </Link>
        {CRM_PEOPLE_PRESETS.map((p) => (
          <Link key={p} className="loop-filter" href={href({ ...params, preset: p })} aria-current={params.preset === p ? 'true' : undefined}>
            {CRM_PEOPLE_PRESET_LABELS[p]}
          </Link>
        ))}
      </nav>

      <form className="loop-filters" style={{ alignItems: 'flex-end' }} method="get" action={PEOPLE_HREF} role="search" aria-label="Find people">
        <label className="loop-field">
          <span className="loop-label">Search</span>
          <input className="loop-input" type="search" name="q" defaultValue={params.q ?? ''} maxLength={100} placeholder="Name, title or company" autoComplete="off" />
        </label>
        <label className="loop-field">
          <span className="loop-label">Status</span>
          <select className="loop-select" name="state" defaultValue={params.state ?? ''}>
            <option value="">Any</option>
            {CRM_CONVERSATION_STATES.map((s) => (
              <option key={s} value={s}>{CRM_CONVERSATION_STATE_LABELS[s]}</option>
            ))}
          </select>
        </label>
        <label className="loop-field">
          <span className="loop-label">Group</span>
          <select className="loop-select" name="group" defaultValue={params.group ?? ''}>
            <option value="">Any</option>
            <option value="active">Active outreach</option>
            <option value="hold">On hold or circle back</option>
            <option value="closed">Passed or closed</option>
          </select>
        </label>
        <label className="loop-field">
          <span className="loop-label">Cadence stage</span>
          <select className="loop-select" name="stage" defaultValue={params.stage ?? ''}>
            <option value="">Any</option>
            {CRM_CADENCE_STAGES.map((s) => (
              <option key={s} value={s}>{s === 'INITIAL' ? 'Initial' : s === 'THREE_DAY' ? '3-day' : s === 'SEVEN_DAY' ? '7-day' : s === 'FOURTEEN_DAY' ? '14-day' : 'Monthly'}</option>
            ))}
          </select>
        </label>
        <label className="loop-field">
          <span className="loop-label">Due</span>
          <select className="loop-select" name="due" defaultValue={params.due ?? ''}>
            <option value="">Any</option>
            {(Object.keys(DUE_FILTER_LABELS) as (keyof typeof DUE_FILTER_LABELS)[]).map((k) => (
              <option key={k} value={k}>{DUE_FILTER_LABELS[k]}</option>
            ))}
          </select>
        </label>
        <label className="loop-field">
          <span className="loop-label">Replied</span>
          <select className="loop-select" name="replied" defaultValue={params.replied ?? ''}>
            <option value="">Any</option>
            <option value="yes">Has replied</option>
            <option value="no">No reply observed</option>
          </select>
        </label>
        <label className="loop-field">
          <span className="loop-label">Meeting</span>
          <select className="loop-select" name="meeting" defaultValue={params.meeting ?? ''}>
            <option value="">Any</option>
            <option value="upcoming">Upcoming</option>
            <option value="this-week">This week</option>
          </select>
        </label>
        <label className="loop-field">
          <span className="loop-label">Last contacted</span>
          <select className="loop-select" name="contacted" defaultValue={params.contacted ?? ''}>
            <option value="">Any time</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="older">Over 90 days ago</option>
            <option value="never">Never recorded</option>
          </select>
        </label>
        <label className="loop-field">
          <span className="loop-label">Creator</span>
          <select className="loop-select" name="creator" defaultValue={params.creator ?? ''}>
            <option value="">Any</option>
            {result.creators.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="loop-field">
          <span className="loop-label">Company</span>
          <select className="loop-select" name="company" defaultValue={params.company ?? ''}>
            <option value="">Any</option>
            {result.companies.map((c) => (
              <option key={c.partyId} value={c.partyId}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="loop-field">
          <span className="loop-label">Title</span>
          <input className="loop-input" type="search" name="title" defaultValue={params.title ?? ''} maxLength={100} placeholder="e.g. Partnerships" autoComplete="off" />
        </label>
        <label className="loop-field">
          <span className="loop-label">Worked by</span>
          <select className="loop-select" name="owner" defaultValue={params.owner ?? ''}>
            <option value="">Anyone</option>
            {result.owners.map((o) => (
              <option key={o.userId} value={o.userId}>{o.name}</option>
            ))}
          </select>
        </label>
        <label className="loop-field">
          <span className="loop-label">Source</span>
          <select className="loop-select" name="origin" defaultValue={params.origin ?? ''}>
            <option value="">Any</option>
            <option value="imported">Imported</option>
            <option value="manual">Added manually</option>
          </select>
        </label>
        {params.preset ? <input type="hidden" name="preset" value={params.preset} /> : null}
        <button className="loop-btn loop-btn--primary" type="submit">Apply</button>
        {filtered ? (
          <Link className="loop-btn loop-btn--quiet" href={PEOPLE_HREF}>Clear</Link>
        ) : null}
      </form>

      {view.filteredCount === 0 ? (
        <StateBlock
          kind="empty"
          title={summary.totalPeople === 0 ? 'No established people yet.' : 'No people match.'}
          body={summary.totalPeople === 0 ? 'A person appears here once their identity is established. Intake records and unidentified callers are not people.' : 'Nobody in this workspace matches these filters.'}
          action={filtered ? { label: 'Clear filters', href: PEOPLE_HREF } : undefined}
        />
      ) : (
        <>
          <p className="loop-resultcount">
            Showing {n(first)}–{n(last)} of {n(view.filteredCount)}
            {filtered ? ` (filtered from ${n(view.totalCount)})` : ''}
          </p>
          <table className="loop-table">
            <caption className="loop-sr-only">People and where each conversation stands</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Creator</th>
                <th scope="col">Status</th>
                <th scope="col">Cadence</th>
                <th scope="col">Last touch</th>
                <th scope="col">Next action</th>
                <th scope="col">Reply</th>
                <th scope="col">AI summary</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => {
                const o = row.outreach;
                const state = conversationState(o.state);
                const due = dueText(o, time);
                return (
                  <tr key={row.partyId}>
                    <td>
                      <Link className="loop-table__strong" href={personHref(row.partyId)}>{row.displayName}</Link>
                      <div className="loop-note">
                        {[row.title?.text, row.company?.name].filter(Boolean).join(' · ') || <span className="loop-table__muted">No title or company recorded</span>}
                      </div>
                      <div className="loop-table__muted" style={{ fontSize: 12 }}>
                        Established {time.date(row.establishedAt)} · {row.origin === 'IMPORTED' ? 'imported' : 'added manually'}
                      </div>
                    </td>
                    <td data-label="Creator">{row.creator ? row.creator.label : <span className="loop-table__muted">None recorded</span>}</td>
                    <td data-label="Status">
                      {(() => {
                        const ai = result.intelligenceByParty.get(row.partyId) ?? null;
                        const latestReplyNeedsReview = o.reviewReason === 'REPLY_CONTENT_UNKNOWN';
                        const aiHasSemanticRead = latestReplyNeedsReview && ai !== null;
                        const aiLabel =
                          ai?.suggestion === 'REPLY'
                            ? 'Replied — needs response'
                            : ai?.suggestion === 'NONE'
                              ? 'Replied — no immediate action'
                              : ai
                                ? `${suggestionLabel(ai.suggestion)} suggested`
                                : null;
                        return (
                          <>
                            <span className={`loop-pill loop-pill--${ai?.suggestion === 'REPLY' ? 'attention' : aiHasSemanticRead ? 'info' : state.tone}`}>
                              {aiHasSemanticRead ? aiLabel : state.label}
                            </span>
                            <div className="loop-table__muted" style={{ fontSize: 12 }}>
                              {aiHasSemanticRead ? 'AI interpretation of your linked Gmail thread' : basisText(o.basis)}
                            </div>
                          </>
                        );
                      })()}
                    </td>
                    <td data-label="Cadence">{cadenceText(o)}</td>
                    <td data-label="Last touch">{lastTouchText(o, time)}</td>
                    <td data-label="Next action">
                      {(() => {
                        const ai = result.intelligenceByParty.get(row.partyId) ?? null;
                        const semanticReplyReview = o.reviewReason === 'REPLY_CONTENT_UNKNOWN' && ai;
                        if (semanticReplyReview) {
                          return (
                            <>
                              <span className="loop-table__strong">
                                {ai.suggestion === 'REPLY' ? 'Reply needed' : `AI suggests: ${suggestionLabel(ai.suggestion)}`}
                              </span>
                              {ai.suggestionText ? <div className="loop-table__muted" style={{ fontSize: 12 }}>{ai.suggestionText}</div> : null}
                            </>
                          );
                        }
                        return (
                          <>
                            {o.nextAction.kind === 'NONE' ? <span className="loop-table__muted">{o.nextAction.label}</span> : <span className="loop-table__strong">{o.nextAction.label}</span>}
                            {due ? (
                              <div style={{ fontSize: 12.5, fontWeight: o.nextAction.bucket === 'OVERDUE' ? 700 : 500, color: o.nextAction.bucket === 'OVERDUE' ? 'var(--loop-crit)' : o.nextAction.bucket === 'TODAY' ? 'var(--loop-warn)' : 'var(--loop-muted)' }}>
                                {due}
                              </div>
                            ) : null}
                          </>
                        );
                      })()}
                    </td>
                    <td data-label="Reply">{replyText(o, mail.gmail, time)}</td>
                    <td data-label="AI summary">
                      {result.intelligenceByParty.get(row.partyId) ? (
                        <span title="AI summary of your own linked Gmail conversation">
                          {result.intelligenceByParty.get(row.partyId)!.summary.length > 180
                            ? `${result.intelligenceByParty.get(row.partyId)!.summary.slice(0, 179)}…`
                            : result.intelligenceByParty.get(row.partyId)!.summary}
                        </span>
                      ) : (
                        <span className="loop-table__muted">AI summary unavailable</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {view.pages > 1 ? (
            <nav className="loop-pager" aria-label="Pages of people">
              {view.page > 1 ? <Link className="loop-btn" href={href(params, view.page - 1)}>Previous</Link> : <span />}
              <span className="loop-resultcount">Page {view.page} of {view.pages}</span>
              {view.page < view.pages ? <Link className="loop-btn" href={href(params, view.page + 1)}>Next</Link> : <span />}
            </nav>
          ) : null}
        </>
      )}
      <p className="loop-note">
        Records awaiting identity review are not People yet. <Link href={IDENTITY_REVIEW_HREF}>Open identity review</Link>.
      </p>
      <p className="loop-note">
        Opportunities are not summarised per person here. <Link href="/app/crm/opportunities">Open Opportunities</Link>
      </p>
    </LoopPage>
  );
}
