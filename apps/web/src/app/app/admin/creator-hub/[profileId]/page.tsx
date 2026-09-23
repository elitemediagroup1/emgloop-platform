import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { CampaignView, DeliverableView, LibraryItem, OpportunityView } from '@emgloop/database';
import {
  CAMPAIGN_STATES,
  COMPENSATION_STATES,
  COMPENSATION_STATE_LABELS,
  CREATOR_VISIBLE_OPPORTUNITY_LABELS,
  CREATOR_VISIBLE_OPPORTUNITY_STATES,
  DELIVERABLE_TYPES,
  EVIDENCE_SOURCE_LABELS,
  SOCIAL_PLATFORM_LABELS,
  type CompensationState,
  type EvidenceSource,
  type SocialPlatform,
} from '@emgloop/shared';
import { requireWorkspace } from '../../../../../workspaces/guard';
import { creatorDomain, EMG_HREFS } from '../../../../../creator/creator-runtime';
import {
  bindCreatorLoginAction,
  declareDeliverableAction,
  designateOpportunityAction,
  recordBrandApprovalAction,
  recordEmgApprovalAction,
  relayBrandFeedbackAction,
  transitionCampaignAction,
} from '../../../../../creator/emg-actions';
import { viewerTime } from '../../../../../time/viewer-time';
import { money, num } from '../../../_loop-os/format';
import { Facts, LoopPage, PageHead, Panel, RecordLayout, StateBlock, SummaryStrip } from '../../../_loop-os/record';
import { listCreatorLogins, loginOf } from '../_data';
import { ContentStatePill, Pill, RefusedBlock, TRAIL, creatorHandle, groupRequests, stepLine, turnaround } from '../_shared';

// EMG Creator Operations — one creator's operating view (design pass §10).
//
// "What does this creator need from us, and what are we waiting on", in one screen. It
// COMPOSES the domain's EMG projections -- productions, the content library, the CRM's
// opportunities and campaigns with their deliverables, the compensation ledger, the
// analytics evidence, the profile and its login -- and copies none of them. Every EMG-only
// value (a forecast, a term, an internal note, a stage name) is marked as such, because the
// creator's own seat never sees it.
//
// The acts here are small server-action forms over the same objects: designate what the
// creator may see of an opportunity, move a campaign, declare a deliverable, record an
// approval, relay brand feedback, bind the login. Each re-checks the seat and the organization.

export const dynamic = 'force-dynamic';

const CAMPAIGN_TONE: Record<string, 'good' | 'attention' | 'critical' | 'neutral' | 'info'> = {
  DRAFT: 'neutral',
  AGREED: 'info',
  ACTIVE: 'good',
  PAUSED: 'attention',
  ENDED: 'neutral',
  CANCELLED: 'critical',
};

const COMPENSATION_TONE: Record<CompensationState, 'good' | 'attention' | 'critical' | 'neutral' | 'info'> = {
  EXPECTED: 'neutral',
  PENDING: 'attention',
  RECEIVED_BY_EMG: 'info',
  AVAILABLE: 'good',
  TRANSFER_PENDING: 'attention',
  PAID: 'good',
};

function amount(minor: number, currency: string): string {
  return currency === 'USD' ? money(minor) : `${(minor / 100).toFixed(2)} ${currency}`;
}

function sourceLabel(source: string): string {
  return EVIDENCE_SOURCE_LABELS[source as EvidenceSource] ?? source;
}

function DeliverableRows({ deliverables, profileId }: { deliverables: readonly DeliverableView[]; profileId: string }) {
  const time = viewerTime();
  if (deliverables.length === 0) return <p className="loop-note">No deliverable declared on this campaign yet.</p>;
  return (
    <ul className="loop-stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {deliverables.map((d) => (
        <li key={d.id}>
          <span className="loop-table__strong">{d.title}</span>
          <span className="loop-table__muted"> · {d.deliverableType.toLowerCase()}</span>
          {d.dueAt ? <span className="loop-table__muted"> · due {time.dateTime(d.dueAt)}</span> : null}
          {' · '}
          {d.status === 'COMPLETE' ? <Pill tone="good">Complete</Pill> : <span>{d.line}</span>}
          {d.acceptsUnedited ? <span className="loop-table__muted"> · accepts an unedited original</span> : null}
          <div className="loop-note">
            Requires: {d.requirements.length ? d.requirements.map((r) => r.label).join(' · ') : 'none declared'}
            {d.contentId ? (
              <>
                {' · '}
                <Link className="loop-link" href={EMG_HREFS.creatorContent(profileId, d.contentId)}>{d.contentTitle ?? 'Content'}</Link>
              </>
            ) : (
              ' · no content attached yet'
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function CampaignBlock({ c, profileId, returnTo }: { c: CampaignView; profileId: string; returnTo: string }) {
  const time = viewerTime();
  return (
    <div className="loop-stack" style={{ gap: 8 }}>
      <div>
        <span className="loop-table__strong">{c.name}</span> <Pill tone={CAMPAIGN_TONE[c.state] ?? 'neutral'}>{c.state.toLowerCase()}</Pill>
        {c.brandLabel ? <span className="loop-table__muted"> · {c.brandLabel}</span> : null}
        {c.startDate || c.endDate ? (
          <span className="loop-table__muted">
            {' '}
            · {c.startDate ? time.date(c.startDate) : '…'} – {c.endDate ? time.date(c.endDate) : '…'}
          </span>
        ) : null}
      </div>
      {c.creatorBrief ? <p className="loop-note" style={{ margin: 0 }}>Brief to the creator: “{c.creatorBrief}”</p> : null}
      {c.termsSummary ? (
        <p className="loop-note" style={{ margin: 0 }}>
          <Pill tone="neutral">EMG only</Pill> Terms: {c.termsSummary}
        </p>
      ) : null}
      <DeliverableRows deliverables={c.deliverables} profileId={profileId} />
      <details className="loop-drawer">
        <summary>Move this campaign</summary>
        <form action={transitionCampaignAction} className="loop-drawer__body loop-stack" aria-label={`Move ${c.name}`}>
          <input type="hidden" name="campaignId" value={c.id} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <label className="loop-field">
            <span className="loop-label">To state</span>
            <select className="loop-select" name="toState" defaultValue={c.state}>
              {CAMPAIGN_STATES.map((s) => (
                <option key={s} value={s}>{s.toLowerCase()}</option>
              ))}
            </select>
          </label>
          <label className="loop-field">
            <span className="loop-label">Note (kept on the transition)</span>
            <input className="loop-input" name="note" maxLength={1000} />
          </label>
          <div className="loop-btnrow"><button className="loop-btn" type="submit">Record transition</button></div>
        </form>
      </details>
      <details className="loop-drawer">
        <summary>Declare a deliverable</summary>
        <form action={declareDeliverableAction} className="loop-drawer__body loop-stack" aria-label={`Declare a deliverable on ${c.name}`}>
          <input type="hidden" name="campaignId" value={c.id} />
          <input type="hidden" name="profileId" value={profileId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <label className="loop-field">
            <span className="loop-label">Title</span>
            <input className="loop-input" name="title" maxLength={140} required placeholder="Reel 1 of 2" />
          </label>
          <label className="loop-field">
            <span className="loop-label">Type</span>
            <select className="loop-select" name="deliverableType" defaultValue="REEL">
              {DELIVERABLE_TYPES.map((t) => (
                <option key={t} value={t}>{t.toLowerCase()}</option>
              ))}
            </select>
          </label>
          <label className="loop-field">
            <span className="loop-label">Due (your local time)</span>
            <input className="loop-input" type="datetime-local" name="dueAt" />
          </label>
          <fieldset className="loop-stack" style={{ border: 0, margin: 0, padding: 0, gap: 4 }}>
            <legend className="loop-label">Requires</legend>
            <label><input type="checkbox" name="req_creator" defaultChecked /> Creator approval</label>
            <label><input type="checkbox" name="req_emg" defaultChecked /> EMG approval</label>
            <label><input type="checkbox" name="req_brand" /> Brand approval (relayed)</label>
            <label><input type="checkbox" name="req_published" defaultChecked /> Published</label>
          </fieldset>
          <label><input type="checkbox" name="acceptsUnedited" /> Accepts an unedited original</label>
          <div className="loop-btnrow"><button className="loop-btn" type="submit">Declare deliverable</button></div>
        </form>
      </details>
    </div>
  );
}

function OpportunityBlock({ o, profileId, returnTo }: { o: OpportunityView; profileId: string; returnTo: string }) {
  const time = viewerTime();
  return (
    <div className="loop-stack" style={{ gap: 8 }}>
      <div>
        <span className="loop-table__strong">{o.title}</span>{' '}
        {o.stateLabel ? <Pill tone="info">Creator sees: {o.stateLabel}</Pill> : <Pill tone="neutral">Not shown to the creator</Pill>}
        {o.brandLabel ? <span className="loop-table__muted"> · {o.brandLabel}</span> : null}
      </div>
      {o.summary ? <p className="loop-note" style={{ margin: 0 }}>Summary the creator reads: “{o.summary}”</p> : null}
      {o.internal ? (
        <p className="loop-note" style={{ margin: 0 }}>
          <Pill tone="neutral">EMG only</Pill> {o.internal.category} · {o.internal.stage}
          {o.internal.amountMinor !== null ? ` · ${amount(o.internal.amountMinor, o.internal.currency ?? 'USD')}` : ''}
          {o.internal.forecastProbability !== null ? ` · forecast ${Math.round(o.internal.forecastProbability * 100)}%` : ''}
          {o.internal.expectedCloseDate ? ` · expected close ${time.date(o.internal.expectedCloseDate)}` : ''}
          {o.internal.internalNotes ? ` · ${o.internal.internalNotes}` : ''}
        </p>
      ) : null}
      <details className="loop-drawer">
        <summary>Designate what the creator sees</summary>
        <form action={designateOpportunityAction} className="loop-drawer__body loop-stack" aria-label={`Designate ${o.title}`}>
          <input type="hidden" name="opportunityId" value={o.id} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <label className="loop-field">
            <span className="loop-label">Creator-visible state</span>
            <select className="loop-select" name="creatorVisibleState" defaultValue={o.creatorVisibleState ?? ''}>
              <option value="">Not shown to the creator</option>
              {CREATOR_VISIBLE_OPPORTUNITY_STATES.map((s) => (
                <option key={s} value={s}>{CREATOR_VISIBLE_OPPORTUNITY_LABELS[s]}</option>
              ))}
            </select>
          </label>
          <label className="loop-field">
            <span className="loop-label">Brand name{o.brandLabel ? ` (${o.brandLabel})` : ''}</span>
            <select className="loop-select" name="brandVisibility" defaultValue="">
              <option value="">Keep as it is</option>
              <option value="show">Show it to the creator</option>
              <option value="hide">Hide it from the creator</option>
            </select>
            <span className="loop-note">Loop does not show the current brand-visibility setting here; the creator&rsquo;s own seat reflects it.</span>
          </label>
          <label className="loop-field">
            <span className="loop-label">Summary for the creator</span>
            <textarea className="loop-textarea" name="summaryForCreator" rows={2} maxLength={2000} defaultValue={o.summary ?? ''} />
          </label>
          <div className="loop-btnrow"><button className="loop-btn" type="submit">Save designation</button></div>
        </form>
      </details>
      {o.campaigns.length > 0 ? (
        <div className="loop-stack" style={{ paddingLeft: 14, borderLeft: '2px solid var(--loop-line)' }}>
          {o.campaigns.map((c) => (
            <CampaignBlock key={c.id} c={c} profileId={profileId} returnTo={returnTo} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LibraryTable({ items, profileId }: { items: readonly LibraryItem[]; profileId: string }) {
  const time = viewerTime();
  if (items.length === 0) return <StateBlock kind="empty" compact title="No content yet." body="Content appears here when the creator uploads an original." />;
  return (
    <table className="loop-table" aria-label="Content library">
      <thead>
        <tr>
          <th scope="col">Content</th>
          <th scope="col">State</th>
          <th scope="col">Latest version</th>
          <th scope="col">Where it fits</th>
          <th scope="col">Updated</th>
        </tr>
      </thead>
      <tbody>
        {items.map((c) => (
          <tr key={c.id}>
            <td data-label="Content">
              <Link className="loop-link" href={EMG_HREFS.creatorContent(profileId, c.id)}>{c.title}</Link>
              <span className="loop-table__muted"> · {c.kind.toLowerCase()}</span>
            </td>
            <td data-label="State"><ContentStatePill state={c.state} /></td>
            <td data-label="Latest version">{c.latestVersion ? `${c.latestVersion.label}${c.latestVersion.visibleToCreator ? '' : ' (EMG-only draft)'}` : <span className="loop-table__muted">None ready</span>}</td>
            <td data-label="Where it fits">{c.campaignName ? `${c.campaignName}${c.deliverableTitle ? ` · ${c.deliverableTitle}` : ''}` : <span className="loop-table__muted">Independent</span>}</td>
            <td data-label="Updated">{time.relative(c.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function CreatorOverviewPage({ params, searchParams }: { params: { profileId: string }; searchParams?: { refused?: string } }) {
  const session = await requireWorkspace('ADMIN');
  const organizationId = session.organizationId;
  const domain = creatorDomain();
  const profile = await domain.creator.profileById(organizationId, params.profileId);
  // Another organization's creator is indistinguishable from a missing one, by design.
  if (!profile) notFound();
  const seat = { kind: 'EMG', organizationId } as const;
  const [requestsAll, library, opportunities, campaigns, earnings, analytics, login, logins] = await Promise.all([
    domain.records.requests(organizationId),
    domain.records.library(seat, profile!.id),
    domain.records.opportunities(seat, profile!.partyId),
    domain.records.campaigns(seat, profile!.partyId),
    domain.records.earnings(organizationId, profile!.id),
    domain.records.analytics(organizationId, profile!.id),
    loginOf(organizationId, profile!.userId),
    listCreatorLogins(organizationId),
  ]);
  const time = viewerTime();
  const here = EMG_HREFS.creator(profile!.id);
  const requests = groupRequests(requestsAll.filter((r) => r.creator.id === profile!.id));
  const weekAhead = time.now.getTime() + 7 * 86400_000;
  const dueThisWeek = campaigns.flatMap((c) => c.deliverables).filter((d) => d.status !== 'COMPLETE' && d.dueAt && new Date(d.dueAt).getTime() <= weekAhead);
  const inOpportunity = new Set(opportunities.flatMap((o) => o.campaigns.map((c) => c.id)));
  const standaloneCampaigns = campaigns.filter((c) => !inOpportunity.has(c.id));
  const handle = creatorHandle(profile!);
  const readyTargets = library.filter((c) => c.latestVersion && c.latestVersion.uploadState === 'READY');
  const social = Array.isArray(profile!.socialAccounts) ? (profile!.socialAccounts as { platform?: string; state?: string }[]) : [];
  const categories = Array.isArray(profile!.categories) ? (profile!.categories as string[]) : [];

  return (
    <LoopPage label={profile!.displayName}>
      <PageHead
        trail={[TRAIL.operations, TRAIL.creators, { label: profile!.displayName }]}
        title={profile!.displayName}
        subtitle={handle ? `${handle} · creator operating view` : 'Creator operating view'}
        actions={
          <div className="loop-btnrow">
            <Link className="loop-btn" href={`/app/crm/people/${encodeURIComponent(profile!.partyId)}`}>Person record</Link>
            <Link className="loop-btn" href={EMG_HREFS.requests}>All requests</Link>
          </div>
        }
      />
      <RefusedBlock refused={searchParams?.refused} />

      <SummaryStrip
        label="Summary"
        items={[
          { label: 'Needs EMG', value: String(requests.needsEmg.length) },
          { label: 'Needs creator', value: String(requests.awaitingCreator.length) },
          { label: 'In production', value: String(requests.needsEmg.length + requests.awaitingCreator.length) },
          { label: 'Due this week', value: String(dueThisWeek.length) },
        ]}
      />

      <RecordLayout
        railLabel="Compensation, analytics and profile"
        main={
          <>
            <Panel title="Productions" lead="What is in motion on this creator's content, and who it waits on.">
              {requests.needsEmg.length + requests.awaitingCreator.length === 0 ? (
                <p className="loop-note">Nothing is in production for {profile!.displayName} right now.</p>
              ) : (
                <ul className="loop-stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {[...requests.needsEmg, ...requests.awaitingCreator].map((r) => {
                    const t = turnaround(r.production, time);
                    return (
                      <li key={r.production.id}>
                        {r.needs === 'EMG' ? <Pill tone="attention">Needs EMG</Pill> : <Pill tone="info">Awaiting creator</Pill>}{' '}
                        <Link className="loop-link" href={EMG_HREFS.creatorContent(profile!.id, r.contentId)}>{r.contentTitle}</Link>
                        <span className="loop-table__muted"> · Production {r.production.number} · {stepLine(r.production.currentStep)}</span>
                        <div className="loop-note">
                          Requested {t.requested ?? 'not asked for'} · expected {t.expected ?? 'not set yet'} ·{' '}
                          <Link className="loop-link" href={EMG_HREFS.adminWork(r.production.workInstanceId)}>Open work</Link>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {requests.done.length > 0 ? <p className="loop-note">{requests.done.length} finished production{requests.done.length === 1 ? '' : 's'} on the content records.</p> : null}
            </Panel>

            <section id="content" aria-label="Content library">
              <Panel title="Content library" lead="The EMG projection: every version, including drafts the creator cannot see yet.">
                <LibraryTable items={library} profileId={profile!.id} />
              </Panel>
            </section>

            <section id="commercial" aria-label="Opportunities and campaigns">
              <Panel title="Opportunities and campaigns" lead="CRM records, read here. What the creator sees of them is designated, never inherited.">
                {opportunities.length === 0 && standaloneCampaigns.length === 0 ? (
                  <StateBlock kind="empty" compact title="No opportunity or campaign yet." body="They are CRM records; once one names this creator it appears here with its deliverables." />
                ) : (
                  <div className="loop-stack" style={{ gap: 18 }}>
                    {opportunities.map((o) => (
                      <OpportunityBlock key={o.id} o={o} profileId={profile!.id} returnTo={`${here}#commercial`} />
                    ))}
                    {standaloneCampaigns.map((c) => (
                      <CampaignBlock key={c.id} c={c} profileId={profile!.id} returnTo={`${here}#commercial`} />
                    ))}
                  </div>
                )}
              </Panel>
            </section>

            <section id="approvals" aria-label="Approvals and brand feedback">
              <Panel title="Approvals and brand feedback" lead="Marks on a version and relayed feedback. Each names who originated it and who entered it.">
                {readyTargets.length === 0 ? (
                  <p className="loop-note">No content has a ready version to act on yet. Open a content record for its full version history.</p>
                ) : (
                  <div className="loop-stack">
                    <details className="loop-drawer">
                      <summary>Record EMG approval on a latest version</summary>
                      <form action={recordEmgApprovalAction} className="loop-drawer__body loop-stack" aria-label="Record EMG approval">
                        <input type="hidden" name="returnTo" value={`${here}#approvals`} />
                        <label className="loop-field">
                          <span className="loop-label">Content · version</span>
                          <select className="loop-select" name="target">
                            {readyTargets.map((c) => (
                              <option key={c.id} value={`${c.id}|${c.latestVersion!.id}`}>{c.title} · {c.latestVersion!.label}</option>
                            ))}
                          </select>
                        </label>
                        <p className="loop-note" style={{ margin: 0 }}>Per-version approval, including older versions, is on each content record.</p>
                        <label className="loop-field">
                          <span className="loop-label">Note</span>
                          <input className="loop-input" name="note" maxLength={2000} />
                        </label>
                        <div className="loop-btnrow"><button className="loop-btn" type="submit">Record EMG approval</button></div>
                      </form>
                    </details>
                    <details className="loop-drawer">
                      <summary>Record a brand approval (relayed)</summary>
                      <form action={recordBrandApprovalAction} className="loop-drawer__body loop-stack" aria-label="Record brand approval">
                        <input type="hidden" name="returnTo" value={`${here}#approvals`} />
                        <label className="loop-field">
                          <span className="loop-label">Content · version</span>
                          <select className="loop-select" name="target">
                            {readyTargets.map((c) => (
                              <option key={c.id} value={`${c.id}|${c.latestVersion!.id}`}>{c.title} · {c.latestVersion!.label}</option>
                            ))}
                          </select>
                        </label>
                        <label className="loop-field">
                          <span className="loop-label">Who approved it (brand or agency)</span>
                          <input className="loop-input" name="originatorLabel" maxLength={120} required />
                        </label>
                        <label className="loop-field">
                          <span className="loop-label">Note</span>
                          <input className="loop-input" name="note" maxLength={2000} />
                        </label>
                        <div className="loop-btnrow"><button className="loop-btn" type="submit">Record brand approval</button></div>
                      </form>
                    </details>
                    <details className="loop-drawer">
                      <summary>Relay brand feedback</summary>
                      <form action={relayBrandFeedbackAction} className="loop-drawer__body loop-stack" aria-label="Relay brand feedback">
                        <input type="hidden" name="returnTo" value={`${here}#approvals`} />
                        <label className="loop-field">
                          <span className="loop-label">Content</span>
                          <select className="loop-select" name="contentId">
                            {readyTargets.map((c) => (
                              <option key={c.id} value={c.id}>{c.title} · latest {c.latestVersion!.label}</option>
                            ))}
                          </select>
                        </label>
                        <label className="loop-field">
                          <span className="loop-label">Who the feedback is from</span>
                          <input className="loop-input" name="originatorLabel" maxLength={120} required />
                        </label>
                        <label className="loop-field">
                          <span className="loop-label">Summary</span>
                          <textarea className="loop-textarea" name="summary" rows={2} maxLength={2000} />
                        </label>
                        <label className="loop-field">
                          <span className="loop-label">Timestamped notes (optional, JSON)</span>
                          <textarea className="loop-textarea" name="notes" rows={2} placeholder='[{"id":"n1","atSeconds":2,"kind":"CHANGE","text":"…"}]' />
                        </label>
                        <label className="loop-field">
                          <span className="loop-label">Requested return (your local time)</span>
                          <input className="loop-input" type="datetime-local" name="requestedReturnAt" />
                        </label>
                        <p className="loop-note" style={{ margin: 0 }}>Continues the active production, or starts the next one on the same content when none is active.</p>
                        <div className="loop-btnrow"><button className="loop-btn" type="submit">Relay feedback</button></div>
                      </form>
                    </details>
                  </div>
                )}
              </Panel>
            </section>
          </>
        }
        rail={
          <>
            <Panel title="Compensation">
              <Facts
                rows={COMPENSATION_STATES.map((s) => ({
                  label: COMPENSATION_STATE_LABELS[s].replace('to you', 'to the creator'),
                  value: earnings.totals[s] > 0 ? amount(earnings.totals[s], earnings.currency) : <span className="loop-table__muted">—</span>,
                }))}
              />
              <p className="loop-note">Payout: {earnings.payoutState === 'NOT_SET_UP' ? 'not set up by the creator' : earnings.payoutState.toLowerCase().replace(/_/g, ' ')}.</p>
              {earnings.entries.length === 0 ? (
                <p className="loop-note">No compensation entry yet.</p>
              ) : (
                <ul className="loop-stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {earnings.entries.slice(0, 10).map((e) => (
                    <li key={e.id}>
                      <span className="loop-table__strong">{amount(e.amountMinor, e.currency)}</span> <Pill tone={COMPENSATION_TONE[e.state] ?? 'neutral'}>{e.stateLabel.replace('to you', 'to the creator')}</Pill>
                      <div className="loop-note">
                        {e.description}
                        {e.campaignName ? ` · ${e.campaignName}` : ''}
                        {e.deliverableTitle ? ` · ${e.deliverableTitle}` : ''} · {time.date(e.occurredAt)}
                        {e.source === 'SEEDED_DEMO' ? ' · seeded demo data' : ''}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {earnings.seeded ? <p className="loop-note">Some entries are seeded demo data, labelled as such.</p> : null}
            </Panel>

            <Panel title="Analytics">
              {analytics.performance.length === 0 && analytics.latestAudience.length === 0 ? (
                <p className="loop-note">No evidence yet. {analytics.connected ? 'The platform has reported nothing so far.' : 'No platform is connected.'}</p>
              ) : (
                <>
                  <Facts
                    rows={[
                      { label: 'Views', value: num(analytics.totals.views) },
                      { label: 'Reach', value: num(analytics.totals.reach) },
                      { label: 'Engagements', value: num(analytics.totals.engagements) },
                      ...analytics.latestAudience.map((a) => ({
                        label: `${SOCIAL_PLATFORM_LABELS[a.platform as SocialPlatform] ?? a.platform} followers`,
                        value: `${num(a.followers)}${a.growth30dPct !== null ? ` · ${a.growth30dPct >= 0 ? '+' : ''}${a.growth30dPct}% / 30d` : ''}`,
                      })),
                    ]}
                  />
                  {analytics.topContent.length > 0 ? (
                    <ul className="loop-stack" style={{ listStyle: 'none', margin: '10px 0 0', padding: 0 }}>
                      {analytics.topContent.map((t) => (
                        <li key={t.contentId} className="loop-note">
                          <Link className="loop-link" href={EMG_HREFS.creatorContent(profile!.id, t.contentId)}>{t.title}</Link> · {num(t.views)} views
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="loop-note">Sources: {analytics.sources.map(sourceLabel).join(', ')}.{analytics.seeded ? ' Includes seeded demo data.' : ''}</p>
                </>
              )}
            </Panel>

            <Panel title="Profile and login">
              <Facts
                rows={[
                  { label: 'Handle', value: handle, unknownText: 'None' },
                  { label: 'Categories', value: categories.length ? categories.join(', ') : null, unknownText: 'None' },
                  {
                    label: 'Platforms',
                    value: social.length ? social.map((s) => `${SOCIAL_PLATFORM_LABELS[(s.platform ?? '') as SocialPlatform] ?? s.platform ?? '?'} (${(s.state ?? 'NOT_CONNECTED').toLowerCase().replace(/_/g, ' ')})`).join(', ') : null,
                    unknownText: 'None connected',
                  },
                  { label: 'Login', value: login ? `${login.name ?? login.email} · ${login.email} · ${login.status.toLowerCase()}` : null, unknownText: 'No login yet' },
                ]}
              />
              {profile!.bio ? <p className="loop-note">{profile!.bio}</p> : null}
              <form action={bindCreatorLoginAction} className="loop-stack" style={{ marginTop: 10 }} aria-label="Bind the creator's login">
                <input type="hidden" name="profileId" value={profile!.id} />
                <input type="hidden" name="returnTo" value={here} />
                <label className="loop-field">
                  <span className="loop-label">Bind to an active Creator login</span>
                  <select className="loop-select" name="email" defaultValue={login?.email ?? ''}>
                    <option value="">No login (unbind)</option>
                    {logins.map((u) => (
                      <option key={u.id} value={u.email}>{u.name ? `${u.name} · ${u.email}` : u.email}</option>
                    ))}
                  </select>
                </label>
                {logins.length === 0 ? <p className="loop-note" style={{ margin: 0 }}>No active login holds the Creator role yet. Invite one from Team first.</p> : null}
                <div className="loop-btnrow"><button className="loop-btn" type="submit">Save login</button></div>
              </form>
            </Panel>

            <Panel title="Relationship">
              <p className="loop-note">
                Identity, relationships and history live on the Person record.{' '}
                <Link className="loop-link" href={`/app/crm/people/${encodeURIComponent(profile!.partyId)}`}>Open the Person record</Link>
              </p>
            </Panel>
          </>
        }
      />
    </LoopPage>
  );
}
