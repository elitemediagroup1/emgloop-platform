import Link from 'next/link';
import type { ReactNode } from 'react';
import { counted, productLabel, type DayEvent, type TimeView } from '@emgloop/shared';
import { StateBlock } from '../_loop-os/record';
import {
  BRIEFING_SOURCE_LABELS,
  briefingWords,
  type Briefing,
  type BriefingAttention,
  type BriefingChange,
  type BriefingSourceState,
  type BriefingToday,
  type BriefingTone,
} from './briefing';

// The Home briefing, drawn (approved design pass, 2026-09-24; the front door, 2026-09-24). Server
// components over the plan the pure composer returned: what changed, what needs you, and today.
// The figures live on the KPI row and the tiles (front-door-view.tsx); the "Business pulse" panel
// that compared today-so-far with yesterday complete is retired. Presentation only -- nothing here
// loads, decides or widens anything. Every row names its source; a row from a private
// chat says where it is instead of inventing a link; an empty section is one sentence, never a
// card of zeros; a source that is not connected is one line with its way in.

const PILL_TONE: Readonly<Record<BriefingTone, string>> = Object.freeze({
  critical: 'loop-pill--critical',
  attention: 'loop-pill--attention',
  good: 'loop-pill--good',
  neutral: 'loop-pill--neutral',
});

function SourcePill({ source, where }: { source: BriefingChange['source']; where: string | null }) {
  return (
    <span className="loop-pill loop-pill--source loop-brief__src" data-briefing-source={source}>
      {BRIEFING_SOURCE_LABELS[source]}
      {where ? <span className="loop-brief__where"> · {where}</span> : null}
    </span>
  );
}

/** The row's way to act: a link where the source has one, else where the thing is. Never a fabricated URL. */
function Way({ href, label, place }: { href: string | null; label: string | null; place: string | null }) {
  if (href && label) {
    return (
      <Link className="loop-btn loop-btn--quiet loop-brief__act" href={href}>
        {label}
      </Link>
    );
  }
  if (place) return <span className="loop-brief__place">{place}</span>;
  return null;
}

// --- The sentence ------------------------------------------------------------------------------------

export function BriefingLead({ briefing, time }: { briefing: Briefing; time: TimeView }) {
  const words = briefingWords(briefing.sentence, time);
  return (
    <p className="loop-brief__lead" data-briefing-lead>
      {words.lead}
      {words.sources ? <span className="loop-brief__sources"> {words.sources}</span> : null}
    </p>
  );
}

// --- What changed --------------------------------------------------------------------------------

export function WhatChanged({ briefing, time }: { briefing: Briefing; time: TimeView }) {
  const { changes, changesObserved, historyHref } = briefing;
  const sub = changes.length === 0 ? null : changesObserved > changes.length ? `${changes.length} of ${changesObserved} observed` : `${counted(changes.length, 'change', 'changes')} since yesterday`;
  return (
    <section className="loop-panel loop-brief__panel" aria-label="What changed" id="what-changed">
      <div className="loop-brief__head">
        <h2 className="loop-panel__title">What changed</h2>
        {sub ? <span className="loop-brief__sub">{sub}</span> : null}
        {historyHref ? (
          <Link className="loop-link loop-brief__more" href={historyHref}>
            Headlines history →
          </Link>
        ) : null}
      </div>
      {changes.length === 0 ? (
        <p className="loop-brief__quiet">Nothing changed in what Loop can read since yesterday.</p>
      ) : (
        <ul className="loop-brief__rows">
          {changes.map((c) => (
            <li className="loop-brief__row" key={c.key} data-briefing-change={c.source} data-briefing-provider={c.provider ?? undefined}>
              <span className={`loop-brief__dot is-${c.tone}`} aria-hidden="true" />
              <div className="loop-brief__body">
                <p className="loop-brief__what">{c.what}</p>
                <p className="loop-brief__meta">
                  <SourcePill source={c.source} where={c.where} />
                  <span className="loop-brief__why" data-briefing-why>
                    Why: {c.why}
                  </span>
                  {c.next ? (
                    <span className="loop-brief__next" data-briefing-next>
                      Next: {c.next}
                    </span>
                  ) : null}
                  {c.at ? <time dateTime={time.iso(c.at)}>{time.relative(c.at)}</time> : null}
                </p>
              </div>
              <div className="loop-brief__ways">
                <Way href={c.href} label={c.hrefLabel} place={c.place} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {changesObserved > changes.length ? (
        <p className="loop-brief__foot">
          Not shown: {counted(changesObserved - changes.length, 'earlier change', 'earlier changes')}.
        </p>
      ) : null}
    </section>
  );
}

// --- Needs your attention -------------------------------------------------------------------------

/** The section is titled by the governed attention state's own label: one vocabulary, imported. */
const ATTENTION_TITLE = productLabel('NEEDS_ATTENTION')?.label ?? 'Needs attention';

export function NeedsAttention({ briefing, time }: { briefing: Briefing; time: TimeView }) {
  const { attention, attentionTotal, attentionElsewhere, attentionReadable } = briefing;
  const more = attentionElsewhere.filter((e) => e.count > 0 && e.href);
  return (
    <section className="loop-panel loop-brief__panel" aria-label={ATTENTION_TITLE} id="needs-attention">
      <div className="loop-brief__head">
        <h2 className="loop-panel__title">{ATTENTION_TITLE}</h2>
        {attention.length > 0 ? <span className="loop-brief__sub">Ranked by deadline, then kind, then how long it has waited</span> : null}
      </div>
      {attention.length === 0 ? (
        <p className="loop-brief__quiet">
          {attentionReadable ? 'Nothing needs you right now in what Loop can read.' : 'Loop could not read the sources that raise attention items just now.'}
        </p>
      ) : (
        <ol className="loop-brief__rows">
          {attention.map((a, i) => (
            <AttentionRow key={a.key} row={a} rank={i + 1} time={time} />
          ))}
        </ol>
      )}
      {attentionTotal > attention.length || more.length > 0 ? (
        <p className="loop-brief__foot">
          {attentionTotal > attention.length ? <span>Showing {attention.length} of {attentionTotal}. </span> : null}
          {more.map((e) => (
            <Link className="loop-link" href={e.href!} key={e.source}>
              {e.count} more in {BRIEFING_SOURCE_LABELS[e.source]} →
            </Link>
          ))}
        </p>
      ) : null}
    </section>
  );
}

function AttentionRow({ row, rank, time }: { row: BriefingAttention; rank: number; time: TimeView }) {
  return (
    <li className="loop-brief__row" data-briefing-attention={row.source} data-briefing-provider={row.provider ?? undefined} data-briefing-score={row.score}>
      <span className="loop-brief__rank" aria-hidden="true">
        {rank}
      </span>
      <div className="loop-brief__body">
        <p className="loop-brief__what">{row.what}</p>
        <p className="loop-brief__meta">
          <span className={`loop-pill ${PILL_TONE[row.kindTone]}`}>{row.kindLabel}</span>
          {row.deadline ? (
            <span className="loop-pill loop-pill--attention" data-briefing-deadline>
              Due {row.deadline}
            </span>
          ) : null}
          <SourcePill source={row.source} where={row.where} />
          {row.next ? (
            <span className="loop-brief__next" data-briefing-next>
              Next: {row.next}
            </span>
          ) : null}
          {row.since ? (
            <span>
              {row.provider === 'TELEGRAM' ? 'still open as of ' : 'since '}
              <time dateTime={time.iso(row.since)}>{time.relative(row.since)}</time>
            </span>
          ) : null}
        </p>
      </div>
      <div className="loop-brief__ways">
        <Way href={row.href} label={row.hrefLabel} place={row.place} />
      </div>
    </li>
  );
}

// --- Today --------------------------------------------------------------------------------------------

function attendance(event: DayEvent): string | null {
  if (!event.attendanceKnown || event.attendeeCount === null || event.attendeeCount <= 1) return null;
  const people = `${event.attendeeCount} ${event.attendeeCount === 1 ? 'person' : 'people'}`;
  return event.externalAttendeeCount !== null && event.externalAttendeeCount > 0 ? `${people} · external` : people;
}

/** The facts beside an event, each one a stored column. No location, no link, no attendee names. */
function eventFacts(event: DayEvent): string[] {
  const facts: string[] = [];
  const people = attendance(event);
  if (people) facts.push(people);
  if (event.hasConference) facts.push('video call');
  if (event.organizerIsSelf) facts.push('organizer: you');
  if (event.selfResponse === 'declined') facts.push('declined');
  if (event.kind === 'OUT_OF_OFFICE') facts.push('out of office');
  if (event.kind === 'FOCUS_TIME') facts.push('focus time');
  return facts;
}

/** How current a read is, in the source's own words: said only when it is not current. */
function currencyWords(state: Extract<BriefingSourceState, { state: 'READ' }>, noun: 'calendar' | 'mail', time: TimeView): string | null {
  if (state.current) return null;
  const when = state.readAt ? time.relative(state.readAt, { style: 'long' }) : 'earlier';
  return state.failed ? `Loop could not reach Google just now. This is your ${noun} as Loop last read it, ${when}.` : `Loop last read your ${noun} ${when}.`;
}

function SourceLine({ state, mark, time }: { state: BriefingSourceState; mark: 'calendar' | 'mail'; time: TimeView }) {
  if (state.state === 'NOT_CONFIGURED') return null;
  if (state.state === 'READ') {
    const words = currencyWords(state, mark, time);
    return words ? (
      <p className="loop-brief__source-line" data-briefing-source-state="STALE" data-briefing-source-of={mark}>
        <span>{words}</span>
      </p>
    ) : null;
  }
  return (
    <p className="loop-brief__source-line" data-briefing-source-state={state.state} data-briefing-source-of={mark}>
      <span className="loop-brief__ring" aria-hidden="true" />
      <span>{state.line}</span>
      {state.state === 'NOT_CONNECTED' ? (
        <Link className="loop-link" href={state.href}>
          {state.action}
        </Link>
      ) : null}
    </p>
  );
}

export function TodayPanel({ today, time, refresh, mailHref }: { today: BriefingToday; time: TimeView; refresh?: ReactNode; mailHref: string }) {
  const read = today.calendar.state === 'READ';
  const meetings = read ? `${counted(today.events.length, 'meeting', 'meetings')}${today.allDayCount > 0 ? ` · ${counted(today.allDayCount, 'all-day event', 'all-day events')}` : ''}` : null;
  const nextWords = today.inProgress
    ? `“${today.inProgress.summary ?? 'Untitled event'}” is on now`
    : today.next && today.minutesUntilNext !== null && today.minutesUntilNext <= 120
      ? `next in ${today.minutesUntilNext} min`
      : today.next?.startsAt
        ? `next at ${time.time(today.next.startsAt)}`
        : read && today.events.length > 0
          ? 'none left today'
          : null;
  const clear = today.afternoonClear === true ? 'afternoon clear' : null;
  const nothingToSay = today.calendar.state === 'NOT_CONFIGURED' && today.mail.state === 'NOT_CONFIGURED' && today.due.length === 0;
  if (nothingToSay) return null;
  return (
    <section className="loop-panel loop-brief__panel" aria-label="Today" id="today">
      <div className="loop-brief__head">
        <h2 className="loop-panel__title">Today</h2>
        <span className="loop-brief__sub">{time.date(time.now)}</span>
        {read ? (
          <a className="loop-link loop-brief__more" href="https://calendar.google.com/" target="_blank" rel="noreferrer">
            Open Google Calendar ↗
          </a>
        ) : null}
      </div>
      {read ? (
        <p className="loop-brief__now">
          <b>{meetings}</b>
          {[nextWords, clear].filter(Boolean).map((w) => (
            <span key={w!}> · {w}</span>
          ))}
        </p>
      ) : null}
      <SourceLine state={today.calendar} mark="calendar" time={time} />
      {read && today.events.length > 0 ? (
        <ul className="loop-brief__tl">
          {today.events.map((e) => (
            <li key={e.eventId} className={today.inProgress?.eventId === e.eventId ? 'is-live' : undefined}>
              <span className="loop-brief__t">{e.startsAt ? time.time(e.startsAt) : '—'}</span>
              <span className="loop-brief__e">
                <b>{e.summary ?? 'Untitled event'}</b>
                <span>{eventFacts(e).join(' · ')}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {read && today.events.length === 0 && today.allDayCount === 0 ? <p className="loop-brief__quiet">No meetings on your calendar today.</p> : null}
      {today.due.length > 0 ? (
        <>
          <p className="loop-brief__subhead">Due today</p>
          <ul className="loop-brief__tl">
            {today.due.map((d) => (
              <li key={d.key} className="is-due">
                <span className="loop-brief__t">{time.time(d.at)}</span>
                <span className="loop-brief__e">
                  {d.href ? (
                    <Link href={d.href}>
                      <b>{d.what}</b>
                    </Link>
                  ) : (
                    <b>{d.what}</b>
                  )}
                  <span>{d.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {today.mail.state !== 'NOT_CONFIGURED' ? <p className="loop-brief__subhead">Mail</p> : null}
      <SourceLine state={today.mail} mark="mail" time={time} />
      {today.mailCounts ? (
        <p className="loop-brief__mailline" data-briefing-mail>
          {today.mailCounts.needsReply > 0 || today.mailCounts.followUps > 0 || today.mailCounts.waiting > 0
            ? [
                today.mailCounts.needsReply > 0 ? `${today.mailCounts.needsReply} need a reply` : null,
                today.mailCounts.followUps > 0 ? `${counted(today.mailCounts.followUps, 'follow-up', 'follow-ups')} due` : null,
                today.mailCounts.waiting > 0 ? `${today.mailCounts.waiting} waiting on others` : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : today.mailCounts.current
              ? 'Nothing in your mail needs you right now.'
              : 'Nothing in your mail needed you when Loop last read it.'}
          {' '}
          <Link className="loop-link" href={mailHref}>
            Open Mail →
          </Link>
        </p>
      ) : null}
      {refresh ? <div className="loop-brief__refresh">{refresh}</div> : null}
    </section>
  );
}

/** The one-line unavailable state a whole source gets when its read threw. */
export function SourceUnavailable({ what }: { what: string }) {
  return <StateBlock kind="error" compact title={`Loop could not read ${what} just now`} body="The rest of Home is current. Try again in a moment." />;
}
