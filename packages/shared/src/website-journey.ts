// Website journeys -- an anonymous visitor's sessions, built from Loop's governed first-party website events
// (2026-10-05). Pure: no I/O, no clock (`now` is passed), no randomness.
//
// INPUT is what website ingestion stored and nothing more: the canonical event type, the occurrence time, and the
// MINIMIZED attributes (@emgloop/shared `minimizeWebsiteEvent` -- page path without query, bounded labels,
// pseudonymous visitor/session ids, referrer host, utm source/medium, a ZIP / category / city a search carried,
// scroll depth). Nothing here can add data the minimizer dropped: no campaign name, no free-text search, no URL
// query, no email or phone, no form contents. A journey shows only what the visitor's browser sent and Loop kept.
//
// ANONYMOUS STAYS ANONYMOUS. A visitor is a browser's random id (localStorage), never a person: nothing here
// creates, matches or names a Person or Customer.
//
// WHAT THE TRACKER'S EVENTS MEAN (apps/web/public/sdk/emg-loop.js):
//   session_start  the tracker minted a new session id: no session, or > 30 minutes since the last PAGE LOAD
//   page_view      every page load
//   scroll_depth   25 / 50 / 75 / 100 % milestones, once each per page load
//   heartbeat      every 30 s while the page is open -- instrumentation, folded into duration, never a step
//   session_end    fires on EVERY `pagehide` (each navigation away from a page), so it marks LEAVING A PAGE,
//                  not the end of the session; the session's exit is its last page
//   identify       instrumentation (the attached contact details are dropped by the minimizer)

import { websiteEventClass } from './website-evidence';

export interface JourneyEvent {
  readonly at: Date;
  /** Canonical `web.*` type. */
  readonly eventType: string;
  /** Minimized attributes. */
  readonly attributes: Readonly<Record<string, string | number | undefined>>;
}

/** What a person reads for each canonical event. Unlisted types read as "Other website activity". */
export const WEBSITE_EVENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'web.session_start': 'Started a visit',
  'web.session_end': 'Left the page',
  'web.page_view': 'Viewed a page',
  'web.guide_view': 'Viewed a guide',
  'web.search': 'Searched',
  'web.search_zip': 'Searched by ZIP code',
  'web.search_city': 'Searched by city',
  'web.search_category': 'Searched by category',
  'web.cta_click': 'Clicked a call to action',
  'web.phone_click': 'Clicked a phone number',
  'web.email_click': 'Clicked an email address',
  'web.external_link': 'Followed a link off the site',
  'web.affiliate_click': 'Followed an affiliate link',
  'web.form_start': 'Started a form',
  'web.form_submit': 'Submitted a form',
  'web.appointment_request': 'Requested an appointment',
  'web.newsletter_signup': 'Signed up for the newsletter',
  'web.chat_start': 'Started a chat',
  'web.chat_complete': 'Finished a chat',
  'web.download': 'Downloaded a file',
  'web.quiz_start': 'Started a quiz',
  'web.quiz_complete': 'Finished a quiz',
  'web.planner_start': 'Started a planner',
  'web.planner_save': 'Saved a planner',
  'web.planner_print': 'Printed a planner',
  'web.video_play': 'Played a video',
  'web.error': 'Hit an error',
  'web.goal_conversion': 'Completed a goal',
  'web.scroll_depth': 'Scrolled',
  'web.heartbeat': 'Still on the page',
  'web.identify': 'Identified the browser',
  'web.other': 'Other website activity',
});

export function websiteEventLabel(eventType: string): string {
  return WEBSITE_EVENT_LABELS[eventType] ?? 'Other website activity';
}

/** How the visit arrived. CAMPAIGN: utm source/medium present. REFERRAL: another site. DIRECT: neither. */
export type JourneyTraffic =
  | { readonly kind: 'CAMPAIGN'; readonly source: string | null; readonly medium: string | null }
  | { readonly kind: 'REFERRAL'; readonly referrerHost: string }
  | { readonly kind: 'DIRECT' };

export interface JourneyPage {
  readonly path: string;
  readonly views: number;
  readonly firstAt: Date;
  /** The deepest scroll milestone reached on this page, or null when none was reported. */
  readonly maxScroll: number | null;
}

export interface JourneyStep {
  readonly at: Date;
  /** Milliseconds since the previous STEP (heartbeats and scroll milestones are not steps). Null for the first. */
  readonly sincePreviousMs: number | null;
  readonly eventType: string;
  readonly label: string;
  readonly page: string | null;
  /** A minimized, displayable detail (CTA label, form name, ZIP / category / city), or null. */
  readonly detail: string | null;
}

export interface JourneyCounts {
  readonly pageViews: number;
  readonly ctaClicks: number;
  readonly phoneClicks: number;
  readonly emailClicks: number;
  readonly outboundClicks: number;
  readonly downloads: number;
  readonly searches: number;
  readonly formStarts: number;
  readonly formSubmits: number;
  readonly appointmentRequests: number;
  readonly chat: number;
  readonly planner: number;
}

export interface JourneySession {
  readonly startedAt: Date;
  readonly lastAt: Date;
  /** First to last event, heartbeats included -- how long the visit was observably open. */
  readonly durationMs: number;
  readonly eventCount: number;
  readonly landingPage: string | null;
  /** The last page the visitor was on: where the session ended (no later event is known). */
  readonly exitPage: string | null;
  readonly traffic: JourneyTraffic;
  readonly pages: readonly JourneyPage[];
  /** The page sequence as visited (consecutive repeats collapsed). */
  readonly path: readonly string[];
  readonly counts: JourneyCounts;
  readonly steps: readonly JourneyStep[];
  /** Whether the tracker marked this as a new session (session_start seen). False: the start was not observed. */
  readonly startObserved: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function detailOf(e: JourneyEvent): string | null {
  const a = e.attributes;
  if (e.eventType.startsWith('web.search')) return str(a['zip']) ?? str(a['category']) ?? str(a['city']);
  if (e.eventType.startsWith('web.form') || e.eventType === 'web.appointment_request') return str(a['form']);
  if (['web.cta_click', 'web.phone_click', 'web.email_click', 'web.external_link', 'web.download', 'web.affiliate_click'].includes(e.eventType)) return str(a['cta']);
  if (e.eventType === 'web.page_view' || e.eventType === 'web.guide_view') return str(a['title']);
  return null;
}

/** Events that are instrumentation, folded into the session rather than shown as steps. */
function isFolded(eventType: string): boolean {
  return eventType === 'web.heartbeat' || eventType === 'web.scroll_depth' || eventType === 'web.identify';
}

/**
 * One session's journey from its events (any order). Returns null for no events. Folds heartbeats into duration
 * and scroll milestones into each page's maximum; every other event is a chronological step with the time since the
 * previous step.
 */
export function buildJourneySession(events: readonly JourneyEvent[]): JourneySession | null {
  if (events.length === 0) return null;
  // Same-instant events: the session start first, then the page view, then the rest -- the order a page load emits.
  const rank = (t: string) => (t === 'web.session_start' ? 0 : t === 'web.page_view' ? 1 : 2);
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime() || rank(a.eventType) - rank(b.eventType) || a.eventType.localeCompare(b.eventType));
  const pages = new Map<string, { path: string; views: number; firstAt: Date; maxScroll: number | null }>();
  const path: string[] = [];
  const steps: JourneyStep[] = [];
  const counts = { pageViews: 0, ctaClicks: 0, phoneClicks: 0, emailClicks: 0, outboundClicks: 0, downloads: 0, searches: 0, formStarts: 0, formSubmits: 0, appointmentRequests: 0, chat: 0, planner: 0 };
  let traffic: JourneyTraffic | null = null;
  let lastPage: string | null = null;
  let lastStepAt: Date | null = null;

  for (const e of sorted) {
    const page = str(e.attributes['page']);
    if (page) lastPage = page;
    // How the visit arrived is what its FIRST page load said (later pages' referrer is the site itself).
    if (!traffic && (e.eventType === 'web.session_start' || e.eventType === 'web.page_view')) {
      const source = str(e.attributes['source']);
      const medium = str(e.attributes['medium']);
      const referrerHost = str(e.attributes['referrerHost']);
      traffic = source || medium ? { kind: 'CAMPAIGN', source, medium } : referrerHost ? { kind: 'REFERRAL', referrerHost } : { kind: 'DIRECT' };
    }
    if (e.eventType === 'web.scroll_depth') {
      const depth = e.attributes['depth'];
      const p = page ? pages.get(page) : undefined;
      if (p && typeof depth === 'number') p.maxScroll = Math.max(p.maxScroll ?? 0, depth);
      continue;
    }
    if (isFolded(e.eventType)) continue;

    if (websiteEventClass(e.eventType) === 'PAGE_VIEW') {
      counts.pageViews++;
      if (page) {
        const p = pages.get(page);
        if (p) p.views++;
        else pages.set(page, { path: page, views: 1, firstAt: e.at, maxScroll: null });
        if (path[path.length - 1] !== page) path.push(page);
      }
    }
    switch (e.eventType) {
      case 'web.cta_click': counts.ctaClicks++; break;
      case 'web.phone_click': counts.phoneClicks++; break;
      case 'web.email_click': counts.emailClicks++; break;
      case 'web.external_link': case 'web.affiliate_click': counts.outboundClicks++; break;
      case 'web.download': counts.downloads++; break;
      case 'web.form_start': counts.formStarts++; break;
      case 'web.form_submit': counts.formSubmits++; break;
      case 'web.appointment_request': counts.appointmentRequests++; break;
      case 'web.chat_start': case 'web.chat_complete': counts.chat++; break;
      case 'web.planner_start': case 'web.planner_save': case 'web.planner_print': counts.planner++; break;
      default: if (e.eventType.startsWith('web.search')) counts.searches++;
    }
    steps.push({
      at: e.at,
      sincePreviousMs: lastStepAt ? e.at.getTime() - lastStepAt.getTime() : null,
      eventType: e.eventType,
      label: websiteEventLabel(e.eventType),
      page,
      detail: detailOf(e),
    });
    lastStepAt = e.at;
  }

  const startedAt = sorted[0]!.at;
  const lastAt = sorted[sorted.length - 1]!.at;
  const pageList = [...pages.values()].sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime());
  return {
    startedAt,
    lastAt,
    durationMs: lastAt.getTime() - startedAt.getTime(),
    eventCount: sorted.length,
    landingPage: pageList[0]?.path ?? null,
    exitPage: path[path.length - 1] ?? lastPage,
    traffic: traffic ?? { kind: 'DIRECT' },
    pages: pageList,
    path,
    counts,
    steps,
    startObserved: sorted.some((e) => e.eventType === 'web.session_start'),
  };
}

/** "4m 05s", "1h 02m", "12s" -- a duration for a person to read. */
export function formatJourneyDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** A short, non-identifying reference for an anonymous browser id, for display only ("…a3f9"). */
export function anonymousRef(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9]/g, '');
  return clean.length <= 4 ? clean : clean.slice(-4);
}
