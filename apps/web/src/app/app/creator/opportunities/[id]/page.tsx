import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CONTENT_STATE_LABELS } from '@emgloop/shared';
import { requireWorkspace } from '../../../../../workspaces/guard';
import { CREATOR_HREFS, creatorDomain, requireCreator } from '../../../../../creator/creator-runtime';
import { seatOf } from '../../../../../creator/creator-data';
import { viewerTime } from '../../../../../time/viewer-time';
import { settle } from '../../../_home/settle';
import { ActivityList } from '../../../_loop-os/activity-item';
import { Facts, LoopPage, PageHead, Panel, StateBlock } from '../../../_loop-os/record';
import { COMPENSATION_TONES, CONTENT_STATE_TONES, OPPORTUNITY_TONES, Pill, moneyMinor } from '../../_parts/vocabulary';

// One opportunity (Creator Hub): overview, its campaigns with their deliverables, the updates EMG
// made visible, and the payment lines recorded against its campaigns. A foreign or withheld id is
// not found. Earnings load on their own; a failed read says so in its panel.

export const dynamic = 'force-dynamic';

export default async function CreatorOpportunityPage({ params }: { params: { id: string } }) {
  await requireWorkspace('CREATOR');
  const seat = await requireCreator();
  const time = viewerTime();
  const domain = creatorDomain();
  const opportunities = await domain.records.opportunities(seatOf(seat), seat.partyId);
  const o = opportunities.find((x) => x.id === params.id) ?? null;
  if (!o) notFound();
  const earnings = await settle(() => domain.records.earnings(seat.actor.organizationId, seat.profileId));
  const campaignNames = new Set(o!.campaigns.map((c) => c.name));
  const payments = earnings.ok ? earnings.value.entries.filter((e) => e.campaignName !== null && campaignNames.has(e.campaignName)) : [];

  return (
    <LoopPage label={o!.title}>
      <PageHead trail={[{ label: 'Creator' }, { label: 'Opportunities', href: CREATOR_HREFS.opportunities }, { label: o!.title }]} title={o!.title} />
      <div className="ch-titlerow">
        {o!.creatorVisibleState ? <Pill tone={OPPORTUNITY_TONES[o!.creatorVisibleState]}>{o!.stateLabel}</Pill> : null}
        <span className="ch-fact">
          {o!.brandLabel ? `${o!.brandLabel} · ` : ''}updated {time.dateTime(o!.updatedAt)}
        </span>
      </div>

      <Panel title="Overview">
        <Facts
          rows={[
            { label: 'Brand', value: o!.brandLabel, unknownText: 'Not shared yet' },
            { label: 'Where it stands', value: o!.stateLabel, unknownText: 'Not shared yet' },
            { label: 'Summary', value: o!.summary, unknownText: 'EMG has not written a summary for you yet' },
          ]}
        />
      </Panel>

      {o!.campaigns.length === 0 ? (
        <Panel title="Campaigns">
          <StateBlock kind="empty" compact title="No campaign yet." body="A campaign and its deliverables appear here once EMG sets them up." />
        </Panel>
      ) : (
        o!.campaigns.map((c) => (
          <Panel key={c.id} title={`Campaign · ${c.name}`}>
            <Facts
              rows={[
                { label: 'State', value: c.state.charAt(0) + c.state.slice(1).toLowerCase() },
                { label: 'Brand', value: c.brandLabel, unknownText: 'Not shared yet' },
                { label: 'Runs', value: c.startDate || c.endDate ? `${c.startDate ? time.date(c.startDate) : '…'} – ${c.endDate ? time.date(c.endDate) : '…'}` : null, unknownText: 'Dates not set' },
                { label: 'Brief', value: c.creatorBrief, unknownText: 'No brief shared yet' },
              ]}
            />
            <h3 className="ch-h" style={{ marginTop: 14 }}>
              Deliverables
            </h3>
            {c.deliverables.length === 0 ? (
              <p className="loop-note">None declared yet.</p>
            ) : (
              <ul className="ch-list" aria-label={`Deliverables for ${c.name}`}>
                {c.deliverables.map((d) => (
                  <li key={d.id} className="ch-row ch-row--static">
                    <span className="ch-row__main">
                      <span className="ch-row__title">
                        {d.title} <span className="ch-chip">{d.deliverableType.charAt(0) + d.deliverableType.slice(1).toLowerCase()}</span>
                      </span>
                      <span className="ch-row__meta">
                        {d.line}
                        {d.dueAt ? ` · due ${time.date(d.dueAt)}` : ''}
                        {d.acceptsUnedited ? ' · accepts an unedited original' : ''}
                      </span>
                      {d.requirements.length > 0 ? <span className="ch-row__line">Needs: {d.requirements.map((r) => r.label + (r.required ? '' : ' (optional)')).join(' · ')}</span> : null}
                      {d.contentId ? (
                        <Link className="loop-link" href={CREATOR_HREFS.contentRecord(d.contentId)}>
                          {d.contentTitle ?? 'Open the content'} →
                        </Link>
                      ) : (
                        <Link className="loop-link" href={`${CREATOR_HREFS.content}?deliverable=${encodeURIComponent(d.id)}`}>
                          Upload for this deliverable →
                        </Link>
                      )}
                    </span>
                    {d.contentState ? (
                      <Pill tone={CONTENT_STATE_TONES[d.contentState]} small>
                        {CONTENT_STATE_LABELS[d.contentState]}
                      </Pill>
                    ) : (
                      <Pill tone="neutral" small>
                        Awaiting content
                      </Pill>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        ))
      )}

      <Panel title="Updates">
        {o!.updates.length === 0 ? (
          <StateBlock kind="empty" compact title="No updates shared yet." body="EMG's updates on this opportunity appear here when it marks them visible to you." />
        ) : (
          <ActivityList
            label="Updates on this opportunity"
            entries={[...o!.updates]
              .sort((a, b) => (a.at < b.at ? 1 : -1))
              .map((u, i) => ({
                key: `update:${i}:${u.at}`,
                category: 'STATE_CHANGE' as const,
                story: u.note ? `${u.toState ? `${u.toState} · ` : ''}${u.note}` : u.toState || 'Updated',
                when: time.dateTime(u.at),
                whenIso: u.at,
                evidence: [{ label: 'Shared by', value: 'EMG' }],
              }))}
          />
        )}
      </Panel>

      <Panel title="Payments">
        {!earnings.ok ? (
          <StateBlock kind="error" compact title="Loop could not load your earnings just now." body="This is a failure to read, not a finding that there are none." />
        ) : payments.length === 0 ? (
          <StateBlock kind="empty" compact title="No payment lines yet." body="Compensation EMG records against these campaigns appears here." />
        ) : (
          <ul className="ch-list" aria-label="Payment lines">
            {payments.map((p) => (
              <li key={p.id} className="ch-row ch-row--static">
                <span className="ch-row__main">
                  <span className="ch-row__title">{p.description}</span>
                  <span className="ch-row__meta">
                    {p.campaignName}
                    {p.deliverableTitle ? ` · ${p.deliverableTitle}` : ''} · {time.date(p.occurredAt)}
                    {p.source === 'SEEDED_DEMO' ? ' · seeded demo data' : ''}
                  </span>
                </span>
                <span className="ch-row__amount">
                  {moneyMinor(p.amountMinor, p.currency)}{' '}
                  <Pill tone={COMPENSATION_TONES[p.state] ?? 'neutral'} small>
                    {p.stateLabel}
                  </Pill>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="loop-note" style={{ marginTop: 10 }}>
          <Link href={CREATOR_HREFS.earnings}>All earnings →</Link>
        </p>
      </Panel>
    </LoopPage>
  );
}
