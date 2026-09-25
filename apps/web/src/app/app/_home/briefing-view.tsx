import Link from 'next/link';
import type { ReactNode } from 'react';
import { INTELLIGENCE_DOMAIN_REGISTRY, counted, productLabel, type DayEvent, type TimeView } from '@emgloop/shared';
import { StateBlock } from '../_loop-os/record';
import {
  BRIEFING_LIMITS,
  BRIEFING_SOURCE_LABELS,
  coverageWords,
  type Briefing,
  type BriefingAttention,
  type BriefingChange,
  type BriefingSourceState,
  type BriefingToday,
  type BriefingTone,
} from './briefing';
import type { NarrativeSentence } from './narrative';
import type { StoredBriefing } from '../../../intelligence/briefing';

// The Home briefing and the viewer's day, drawn (approved design pass, 2026-09-24; the composition
// correction, 2026-09-24). Server components over the pure plans: the briefing card (the narrative's
// prose with its sources, and "What Loop read" folded beneath it), and the Your Day card (the day,
// work due today, and a constrained "needs you" list). Presentation only -- nothing here loads,
// decides or widens anything. Every row names its source; a row from a private chat says where it is
// instead of inventing a link; an empty section is one sentence, never a card of zeros; a source that
// is not connected is one line with its way in.

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

// --- Your briefing ---------------------------------------------------------------------------------

/**
 * The briefing card: the synthesis first, in prose, each sentence with its sources as small chips;
 * then, folded, the rows Loop read that changed -- kept for inspection, never the centerpiece.
 */
const LINE_WORDS: Readonly<Record<string, string>> = Object.freeze({ NEEDS_YOU: 'Needs you', CHANGED: 'Changed', WATCH: 'Watch', AHEAD: 'Ahead' });

/** Where a Briefing line's part lives in Loop (the domain's first surface), for its chip. */
function partHref(part: string): string | null {
  return INTELLIGENCE_DOMAIN_REGISTRY.find((d) => d.domain === part)?.surfaces[0] ?? null;
}
function partLabel(part: string): string {
  return part === 'SITUATION' ? 'Situation' : (INTELLIGENCE_DOMAIN_REGISTRY.find((d) => d.domain === part)?.label ?? part);
}

/**
 * The stored Loop Briefing (Phase G): its headline and lines, each chip naming the part of Loop it rests on.
 * Says who composed it -- the governed model, or Loop's own deterministic Briefing.
 */
function StoredBriefingBody({ stored, time, offers }: { stored: StoredBriefing; time: TimeView; offers: (href: string) => boolean }) {
  return (
    <div className="loop-front__prose" data-briefing-stored={stored.composer}>
      <p className="loop-front__sentence" data-briefing-headline>
        <span>{stored.headline}</span>
      </p>
      {stored.lines.map((l, i) => (
        <p className="loop-front__sentence" key={i} data-briefing-line={l.kind}>
          <span>
            {LINE_WORDS[l.kind]}: {l.statement}
          </span>
          {l.parts.map((part) => {
            const target = partHref(part);
            // A chip links only where this viewer's navigation offers the destination.
            const href = target && offers(target) ? target : null;
            return href ? (
              <Link key={part} className="loop-front__chip" href={href} data-briefing-chip={part}>
                {partLabel(part)}
              </Link>
            ) : (
              <span key={part} className="loop-front__chip" data-briefing-chip={part}>
                {partLabel(part)}
              </span>
            );
          })}
        </p>
      ))}
      <p className="loop-front__prose-quiet">
        {stored.composer === 'MODEL' ? 'Composed by Loop from what it read for you' : 'Loop’s own Briefing from what it read for you'} ·{' '}
        <time dateTime={time.iso(stored.generatedAt)}>{time.relative(stored.generatedAt)}</time>
        {stored.limitations.length > 0 ? ` · ${stored.limitations.join('; ')}` : ''}
      </p>
    </div>
  );
}

export function BriefingCard({ narrative, briefing, time, stored = null, offers = () => false }: { narrative: readonly NarrativeSentence[]; briefing: Briefing; time: TimeView; stored?: StoredBriefing | null; offers?: (href: string) => boolean }) {
  return (
    <section className="loop-panel loop-front__briefing" aria-label="Your briefing" id="your-briefing">
      <div className="loop-brief__head">
        <h2 className="loop-panel__title">Your briefing</h2>
        <span className="loop-brief__sub">{time.date(time.now)}</span>
      </div>
      {stored ? (
        <StoredBriefingBody stored={stored} time={time} offers={offers} />
      ) : narrative.length === 0 ? (
        <p className="loop-front__prose-quiet" data-briefing-narrative-empty>
          Loop has no source it can read for you yet. Connect one in Connections and your briefing starts here.
        </p>
      ) : (
        <div className="loop-front__prose" data-briefing-narrative>
          {narrative.map((s) => (
            <p className="loop-front__sentence" key={s.topic} data-briefing-sentence={s.topic}>
              <span>{s.text}</span>
              {s.sources.map((src) =>
                src.href ? (
                  <Link key={src.label} className="loop-front__chip" href={src.href} data-briefing-chip={src.label}>
                    {src.label}
                  </Link>
                ) : (
                  <span key={src.label} className="loop-front__chip" data-briefing-chip={src.label}>
                    {src.label}
                  </span>
                ),
              )}
            </p>
          ))}
        </div>
      )}
      <WhatLoopRead briefing={briefing} time={time} />
    </section>
  );
}

/** What Loop read that changed: the evidence under the briefing, closed by default, capped. */
export function WhatLoopRead({ briefing, time }: { briefing: Briefing; time: TimeView }) {
  const { changes, changesObserved, historyHref } = briefing;
  const sources = coverageWords(briefing.coverage);
  return (
    <details className="loop-front__evidence" id="what-changed" data-briefing-evidence>
      <summary className="loop-front__evidence-sum">
        What Loop read
        <span className="loop-brief__sub">
          {changesObserved === 0 ? ' · nothing changed' : changesObserved > changes.length ? ` · ${changes.length} of ${changesObserved} changes` : ` · ${counted(changes.length, 'change', 'changes')}`}
        </span>
      </summary>
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
      {changesObserved > changes.length || historyHref || sources ? (
        <p className="loop-brief__foot">
          {changesObserved > changes.length ? <span>Not shown: {counted(changesObserved - changes.length, 'earlier change', 'earlier changes')}.</span> : null}
          {sources ? <span data-briefing-coverage>{sources}</span> : null}
          {historyHref ? (
            <Link className="loop-link" href={historyHref}>
              Headlines history →
            </Link>
          ) : null}
        </p>
      ) : null}
    </details>
  );
}

// --- Needs your attention -------------------------------------------------------------------------

/** The section is titled by the governed attention state's own label: one vocabulary, imported. */
const ATTENTION_TITLE = productLabel('NEEDS_ATTENTION')?.label ?? 'Needs attention';

/**
 * What needs the viewer, CONSTRAINED: the top three ranked rows, and the rest behind a native
 * "Show all" -- no new page, nothing hidden that the count does not state.
 */
export function NeedsAttention({ briefing, time }: { briefing: Briefing; time: TimeView }) {
  const { attention, attentionTotal, attentionElsewhere, attentionReadable } = briefing;
  const top = attention.slice(0, BRIEFING_LIMITS.attention);
  const rest = attention.slice(BRIEFING_LIMITS.attention);
  const more = attentionElsewhere.filter((e) => e.count > 0 && e.href);
  return (
    <section className="loop-front__needs" aria-label={ATTENTION_TITLE} id="needs-attention">
      <h3 className="loop-brief__subhead">{ATTENTION_TITLE}</h3>
      {attention.length === 0 ? (
        <p className="loop-brief__quiet">
          {attentionReadable ? 'Nothing needs you right now in what Loop can read.' : 'Loop could not read the sources that raise attention items just now.'}
        </p>
      ) : (
        <ol className="loop-brief__rows">
          {top.map((a, i) => (
            <AttentionRow key={a.key} row={a} rank={i + 1} time={time} />
          ))}
        </ol>
      )}
      {rest.length > 0 ? (
        <details className="loop-front__more" data-briefing-attention-more>
          <summary className="loop-link">Show all {attention.length}</summary>
          <ol className="loop-brief__rows" start={top.length + 1}>
            {rest.map((a, i) => (
              <AttentionRow key={a.key} row={a} rank={top.length + i + 1} time={time} />
            ))}
          </ol>
        </details>
      ) : null}
      {attentionTotal > attention.length || more.length > 0 ? (
        <p className="loop-brief__foot">
          {attentionTotal > attention.length ? <span>{counted(attentionTotal, 'item needs you', 'items need you')} in all; the rest are in their sources. </span> : null}
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

// --- Your day -------------------------------------------------------------------------------------

/** The meetings the card lists: the one on now and those still ahead, the next few only. */
export const DAY_EVENTS_SHOWN = 4;

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
function currencyWords(state: Extract<BriefingSourceState, { state: 'READ' }>, time: TimeView): string | null {
  if (state.current) return null;
  const when = state.readAt ? time.relative(state.readAt, { style: 'long' }) : 'earlier';
  return state.failed ? `Loop could not reach Google just now. This is your calendar as Loop last read it, ${when}.` : `Loop last read your calendar ${when}.`;
}

function CalendarLine({ state, time }: { state: BriefingSourceState; time: TimeView }) {
  if (state.state === 'NOT_CONFIGURED') return null;
  if (state.state === 'READ') {
    const words = currencyWords(state, time);
    return words ? (
      <p className="loop-brief__source-line" data-briefing-source-state="STALE" data-briefing-source-of="calendar">
        <span>{words}</span>
      </p>
    ) : null;
  }
  return (
    <p className="loop-brief__source-line" data-briefing-source-state={state.state} data-briefing-source-of="calendar">
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

/**
 * The Your Day card, compact: today's meetings (the one on now and the next few), all-day events,
 * work due today, and then what needs the viewer -- constrained. `calendarHref` is the Calendar page
 * when the viewer's rail leads there, else null and no link is drawn.
 */
export function YourDayCard({
  today,
  briefing,
  time,
  refresh,
  calendarHref,
}: {
  today: BriefingToday;
  briefing: Briefing;
  time: TimeView;
  refresh?: ReactNode;
  calendarHref: string | null;
}) {
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
  // The one on now and those still ahead; a meeting that already ended is counted, not listed.
  const ahead = today.events.filter((e) => today.inProgress?.eventId === e.eventId || (e.startsAt !== null && e.startsAt.getTime() >= time.now.getTime())).slice(0, DAY_EVENTS_SHOWN);
  return (
    <section className="loop-panel loop-front__day" aria-label="Your day" id="today">
      <div className="loop-brief__head">
        <h2 className="loop-panel__title">Your day</h2>
        <span className="loop-brief__sub">{time.date(time.now)}</span>
        {calendarHref ? (
          <Link className="loop-link loop-brief__more" href={calendarHref}>
            Calendar →
          </Link>
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
      <CalendarLine state={today.calendar} time={time} />
      {read && ahead.length > 0 ? (
        <ul className="loop-brief__tl">
          {ahead.map((e) => (
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
          <h3 className="loop-brief__subhead">Due today</h3>
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
      {(read || today.calendar.state === 'NOT_READ') && refresh ? <div className="loop-brief__refresh">{refresh}</div> : null}
      <NeedsAttention briefing={briefing} time={time} />
    </section>
  );
}

/** The one-line unavailable state a whole source gets when its read threw. */
export function SourceUnavailable({ what }: { what: string }) {
  return <StateBlock kind="error" compact title={`Loop could not read ${what} just now`} body="The rest of Home is current. Try again in a moment." />;
}
