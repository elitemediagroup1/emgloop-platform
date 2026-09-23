// Creator Home (Creator Hub design pass, 2026-09-22). SERVER ONLY.
//
// Loop Home for a creator seat: a greeting, four numbers each traceable to rows, the things that
// need them, their active opportunities, the content in motion, and what Loop noticed about their
// most recently published piece. Every source loads on its own (the Home rule since 2026-09-18):
// a read that fails makes its own panel say so and never takes Home down. No number is invented:
// a source with nothing says nothing, and seeded demo data says it is.

import 'server-only';

import Link from 'next/link';
import type { ContentNotice, LibraryItem } from '@emgloop/database';
import type { TimeView } from '@emgloop/shared';
import { settle } from '../app/app/_home/settle';
import { LoopPage, PageHead, Panel, StateBlock, SummaryStrip } from '../app/app/_loop-os/record';
import { CreatorNoticePanel } from '../app/app/creator/_parts/notice-panel';
import { CONTENT_STATE_TONES, OPPORTUNITY_TONES, Pill, compactNumber, moneyMinor } from '../app/app/creator/_parts/vocabulary';
import { TaskList } from '../app/app/creator/_parts/task-list';
import { loadContentRecord, loadNotice, seatOf } from './creator-data';
import { CREATOR_HREFS, creatorDomain, type CreatorSeat } from './creator-runtime';

const IN_MOTION = new Set<LibraryItem['state']>(['IN_PRODUCTION', 'YOUR_REVIEW', 'CHANGES_REQUESTED', 'APPROVED_BY_YOU', 'FINAL']);

function Failed({ what }: { what: string }) {
  return <StateBlock kind="error" compact title={`Loop could not load ${what} just now.`} body="This is a failure to read, not a finding that there are none." />;
}

export async function CreatorHome({ seat, time }: { seat: CreatorSeat; time: TimeView }) {
  const domain = creatorDomain();
  const s = seatOf(seat);
  const [tasks, opportunities, library, earnings, analytics] = await Promise.all([
    settle(() => domain.records.tasks(seat.actor, { content: CREATOR_HREFS.contentRecord, profile: CREATOR_HREFS.profile })),
    settle(() => domain.records.opportunities(s, seat.partyId)),
    settle(() => domain.records.library(s, seat.profileId)),
    settle(() => domain.records.earnings(seat.actor.organizationId, seat.profileId)),
    settle(() => domain.records.analytics(seat.actor.organizationId, seat.profileId)),
  ]);

  // What Loop noticed: the most recently published piece, else the latest piece. Loaded on its own.
  const items = library.ok ? library.value : [];
  const subject = [...items].filter((i) => i.published).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0] ?? items[0] ?? null;
  const notice = subject
    ? await settle(async (): Promise<ContentNotice | null> => {
        const record = await loadContentRecord(seat, subject.id);
        return record ? loadNotice(seat, record, time.now) : null;
      })
    : null;

  const needs = tasks.ok ? tasks.value.filter((t) => t.bucket === 'NEEDS_ATTENTION') : [];
  const active = opportunities.ok ? opportunities.value.filter((o) => o.creatorVisibleState !== 'DIDNT_GO_AHEAD') : [];
  const inMotion = items.filter((i) => IN_MOTION.has(i.state));
  const followers = analytics.ok && analytics.value.latestAudience.length > 0 ? analytics.value.latestAudience.reduce((sum, a) => sum + a.followers, 0) : null;

  return (
    <LoopPage label="Loop Home">
      <PageHead trail={[{ label: 'Your Loop' }]} title={`${time.greeting()}, ${seat.displayName}`} subtitle="Your content, the opportunities EMG is working on for you, and what needs you." />

      <SummaryStrip
        label="At a glance"
        items={[
          {
            label: analytics.ok && analytics.value.seeded ? 'Total audience · seeded demo data' : 'Total audience',
            value: followers === null ? null : compactNumber(followers),
            unknownText: analytics.ok ? 'No platform connected' : 'Could not read',
          },
          { label: 'Active opportunities', value: opportunities.ok ? String(active.length) : null, unknownText: 'Could not read' },
          {
            label: earnings.ok && earnings.value.seeded ? 'Available balance · seeded demo data' : 'Available balance',
            value: earnings.ok ? moneyMinor(earnings.value.availableMinor, earnings.value.currency) : null,
            unknownText: 'Could not read',
          },
          { label: 'Content in progress', value: library.ok ? String(inMotion.length) : null, unknownText: 'Could not read' },
        ]}
      />

      <Panel title="Things that need you">
        {!tasks.ok ? <Failed what="your tasks" /> : needs.length === 0 ? <StateBlock kind="empty" compact title="Nothing needs you right now." body="A returned edit or a deliverable due soon lands here." action={{ label: 'All tasks', href: CREATOR_HREFS.tasks }} /> : <TaskList tasks={needs} time={time} />}
      </Panel>

      <div className="ch-home">
        <Panel title="Active opportunities">
          {!opportunities.ok ? (
            <Failed what="your opportunities" />
          ) : active.length === 0 ? (
            <StateBlock kind="empty" compact title="No active opportunities." body="EMG shares an opportunity here once it decides you can see it." />
          ) : (
            <ul className="ch-list">
              {active.slice(0, 5).map((o) => (
                <li key={o.id}>
                  <Link className="ch-row" href={CREATOR_HREFS.opportunity(o.id)}>
                    <span className="ch-row__main">
                      <span className="ch-row__title">{o.title}</span>
                      <span className="ch-row__meta">{o.brandLabel ? `${o.brandLabel} · ` : ''}updated {time.relative(o.updatedAt)}</span>
                    </span>
                    {o.creatorVisibleState ? (
                      <Pill tone={OPPORTUNITY_TONES[o.creatorVisibleState]} small>
                        {o.stateLabel}
                      </Pill>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p className="loop-note" style={{ marginTop: 10 }}>
            <Link href={CREATOR_HREFS.opportunities}>All opportunities →</Link>
          </p>
        </Panel>

        <Panel title="Content in progress">
          {!library.ok ? (
            <Failed what="your content" />
          ) : inMotion.length === 0 ? (
            <StateBlock kind="empty" compact title="Nothing in motion." body="Content in production, waiting for your review or approved but not yet published shows here." action={{ label: 'Your content', href: CREATOR_HREFS.content }} />
          ) : (
            <ul className="ch-list">
              {inMotion.slice(0, 6).map((i) => (
                <li key={i.id}>
                  <Link className="ch-row" href={CREATOR_HREFS.contentRecord(i.id)} data-content-state={i.state}>
                    <span className="ch-row__main">
                      <span className="ch-row__title">{i.title}</span>
                      <span className="ch-row__meta">
                        {i.campaignName ?? 'Independent'} · updated {time.relative(i.updatedAt)}
                      </span>
                    </span>
                    <Pill tone={CONTENT_STATE_TONES[i.state]} small>
                      {i.stateLabel}
                    </Pill>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p className="loop-note" style={{ marginTop: 10 }}>
            <Link href={CREATOR_HREFS.content}>All content →</Link>
          </p>
        </Panel>
      </div>

      {notice && !notice.ok ? (
        <Panel title="What Loop noticed">
          <Failed what="what Loop noticed" />
        </Panel>
      ) : (
        <CreatorNoticePanel notice={notice?.ok ? notice.value : null} when={(iso) => time.dateTime(iso)} title={subject ? `What Loop noticed · ${subject.title}` : 'What Loop noticed'} />
      )}
    </LoopPage>
  );
}
