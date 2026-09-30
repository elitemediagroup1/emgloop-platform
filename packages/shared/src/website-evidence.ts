// Website evidence -- the pure contract for governed website evidence (2026-09-30).
//
// Two kinds of website evidence reach Loop, and this file is the contract for both:
//
//   1. FIRST-PARTY TELEMETRY -- Loop's own tracker (emg-loop.js) posting events to the website webhook.
//      Tenancy comes ONLY from a registered property (web_properties): a property key names exactly one
//      organization, and a browser-supplied field never selects one. What is persisted is a MINIMIZED
//      attribute set (`minimizeWebsiteEvent`): a normalized page path without its query string, bounded
//      labels, session/visitor pseudonyms -- never an email, a phone number, a full URL, a campaign name or
//      free-text search.
//
//   2. EXTERNAL AGGREGATES -- Google Analytics 4, Google Search Console, Bing Webmaster Tools and Microsoft
//      Clarity, stored as `source_metric_windows`: counts and rates per window, where NULL is "not
//      reported" and never zero, a window may still be PRELIMINARY, and sampling / thresholding / roll-up /
//      truncation are carried, not hidden (`websiteSourceWindowProblems`). No connector exists yet; this is
//      the shape one must fill.
//
// Pure: no I/O, no clock, no randomness.

import { intelligenceSourceEntry, type IntelligenceEvidenceStream } from './intelligence-registry';

// --- Property identity --------------------------------------------------------------------------------

/** A property key: lowercase, digits and hyphens, 1-63 characters. The database CHECK holds the same rule. */
export const WEB_PROPERTY_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The public browser ingest-key prefix. A key is `pk_emg_<property key>` -- public, never a secret. */
export const WEB_PROPERTY_INGEST_KEY_PREFIX = 'pk_emg_';

export const WEB_PROPERTY_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type WebPropertyStatus = (typeof WEB_PROPERTY_STATUSES)[number];

/** Why a website delivery or event was refused. Codes only -- never the claimed value. */
export const WEBSITE_INGEST_REFUSALS = [
  'MISSING_INGEST_KEY',
  'PROPERTY_UNREGISTERED',
  'PROPERTY_DISABLED',
  'PROPERTY_MISSING',
  'PROPERTY_MISMATCH',
  'MISSING_ORIGIN',
  'DOMAIN_NOT_ALLOWED',
] as const;
export type WebsiteIngestRefusal = (typeof WEBSITE_INGEST_REFUSALS)[number];

export function isWebPropertyKey(value: unknown): value is string {
  return typeof value === 'string' && WEB_PROPERTY_KEY_PATTERN.test(value);
}

/** The property key a public ingest key names, or null when it is not a well-formed ingest key. */
export function webPropertyKeyFromIngestKey(ingestKey: string): string | null {
  const k = String(ingestKey ?? '').trim().toLowerCase();
  if (!k.startsWith(WEB_PROPERTY_INGEST_KEY_PREFIX)) return null;
  const key = k.slice(WEB_PROPERTY_INGEST_KEY_PREFIX.length);
  return isWebPropertyKey(key) ? key : null;
}

export function webPropertyIngestKey(key: string): string {
  return WEB_PROPERTY_INGEST_KEY_PREFIX + key;
}

const HOST_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * A registrable host for a property's allowed-domain list: lowercase, no scheme, port, path or wildcard.
 * Null when the input is not a plain hostname -- a registration with one is refused, not repaired.
 */
export function normalizeWebDomain(raw: string): string | null {
  const h = String(raw ?? '').trim().toLowerCase().replace(/\.$/, '');
  return HOST_PATTERN.test(h) ? h : null;
}

// --- First-party telemetry: page identity and minimization ---------------------------------------------

const PAGE_PATH_MAX = 256;

/**
 * The page identity of a URL or path: its PATH only -- the query string and fragment are removed, because
 * they carry search terms, click ids, campaign names and, too often, an email address. Lowercased, repeated
 * slashes collapsed, a trailing slash removed (except the root), bounded. Null when there is no usable path.
 */
export function normalizePagePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const afterScheme = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const slash = afterScheme.indexOf('/');
    s = slash < 0 ? '/' : afterScheme.slice(slash);
  }
  s = s.split(/[?#]/, 1)[0] ?? '';
  if (!s.startsWith('/')) return null;
  let decoded = s;
  try {
    decoded = decodeURI(s);
  } catch {
    // keep the raw path; it is still bounded and checked below
  }
  let path = decoded.toLowerCase().replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path.length > PAGE_PATH_MAX) path = path.slice(0, PAGE_PATH_MAX);
  if (containsContactDetail(path)) return null;
  return path || '/';
}

const EMAIL_LIKE = /[^\s@/]+@[^\s@/]+\.[a-z]{2,}/i;
const PHONE_LIKE = /(?:\d[\s().-]*){7,}/;

/** True when a string looks like it carries an email address or a phone number. */
export function containsContactDetail(value: string): boolean {
  return EMAIL_LIKE.test(value) || PHONE_LIKE.test(value);
}

/** A bounded label, or null when it is empty, too long to be a label, or carries a contact detail. */
function label(value: unknown, max: number): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (containsContactDetail(s)) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/** A pseudonymous tracker id (visitor / session): a bounded token, never free text. */
function pseudonym(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return /^[A-Za-z0-9._:-]{1,64}$/.test(s) ? s : null;
}

/** A referrer reduced to its host: a referring page's path and query are another site's data about a visitor. */
function referrerHost(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(value.trim());
  return m ? normalizeWebDomain(m[1]!) : null;
}

const ZIP = /^\d{5}(?:-\d{4})?$/;

/**
 * The attributes a website event may persist -- the ENTIRE list. Anything the tracker or a server sender
 * sends that is not here is dropped, including every key added in the future.
 */
export const WEBSITE_TELEMETRY_ATTRIBUTES = [
  'property',
  'page',
  'title',
  'referrerHost',
  'source',
  'medium',
  'sessionId',
  'visitorId',
  'cta',
  'form',
  'category',
  'city',
  'zip',
  'depth',
] as const;
export type WebsiteTelemetryAttribute = (typeof WEBSITE_TELEMETRY_ATTRIBUTES)[number];
export type MinimizedWebsiteEvent = Partial<Record<WebsiteTelemetryAttribute, string | number>>;

function pick(data: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = data[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * The persisted form of one raw website event. Deliberately NOT kept: email, phone, their click targets,
 * the full URL, the query string, free-text search, campaign names, screen size, download / outbound URLs,
 * the browser-claimed organization, and every unknown key. A search that is a ZIP code keeps the ZIP.
 */
export function minimizeWebsiteEvent(data: Record<string, unknown>, property: string): MinimizedWebsiteEvent {
  const out: MinimizedWebsiteEvent = { property };
  const set = (k: WebsiteTelemetryAttribute, v: string | number | null) => {
    if (v !== null) out[k] = v;
  };
  set('page', normalizePagePath(pick(data, ['page', 'path', 'page_path', 'url', 'page_url'])));
  set('title', label(pick(data, ['title', 'page_title']), 120));
  set('referrerHost', referrerHost(pick(data, ['referrer', 'referer'])));
  set('source', label(pick(data, ['source', 'utm_source']), 64));
  set('medium', label(pick(data, ['medium', 'utm_medium']), 64));
  set('sessionId', pseudonym(pick(data, ['sessionId', 'session_id', 'session'])));
  set('visitorId', pseudonym(pick(data, ['visitorId', 'visitor_id', 'anonymous_id', 'client_id'])));
  set('cta', label(pick(data, ['cta', 'cta_label', 'button']), 80));
  set('form', label(pick(data, ['form', 'form_name']), 80));
  set('category', label(pick(data, ['category', 'service', 'vertical']), 80));
  set('city', label(pick(data, ['city']), 80));
  const zip = pick(data, ['zip', 'zipcode', 'postal_code']) ?? pick(data, ['query', 'q', 'search']);
  if (typeof zip === 'string' && ZIP.test(zip.trim())) out.zip = zip.trim();
  const depth = pick(data, ['depth']);
  if (typeof depth === 'number' && Number.isInteger(depth) && depth >= 0 && depth <= 100) out.depth = depth;
  return out;
}

// --- First-party telemetry: event classes --------------------------------------------------------------

/**
 * What an event IS, for counting. Only PAGE_VIEW counts as a page view; TELEMETRY (heartbeat, scroll depth,
 * identify) is instrumentation about a page already viewed and counts as nothing a person did.
 */
export const WEBSITE_EVENT_CLASSES = ['PAGE_VIEW', 'SESSION', 'ENGAGEMENT', 'INTENT', 'TELEMETRY', 'OTHER'] as const;
export type WebsiteEventClass = (typeof WEBSITE_EVENT_CLASSES)[number];

const EVENT_CLASS: Readonly<Record<string, WebsiteEventClass>> = {
  'web.page_view': 'PAGE_VIEW',
  'web.guide_view': 'PAGE_VIEW',
  'web.session_start': 'SESSION',
  'web.session_end': 'SESSION',
  'web.search': 'ENGAGEMENT',
  'web.search_zip': 'ENGAGEMENT',
  'web.search_city': 'ENGAGEMENT',
  'web.search_category': 'ENGAGEMENT',
  'web.cta_click': 'ENGAGEMENT',
  'web.external_link': 'ENGAGEMENT',
  'web.affiliate_click': 'ENGAGEMENT',
  'web.download': 'ENGAGEMENT',
  'web.video_play': 'ENGAGEMENT',
  'web.chat_start': 'ENGAGEMENT',
  'web.quiz_start': 'ENGAGEMENT',
  'web.quiz_complete': 'ENGAGEMENT',
  'web.planner_start': 'ENGAGEMENT',
  'web.planner_save': 'ENGAGEMENT',
  'web.planner_print': 'ENGAGEMENT',
  'web.form_start': 'ENGAGEMENT',
  'web.phone_click': 'INTENT',
  'web.email_click': 'INTENT',
  'web.form_submit': 'INTENT',
  'web.appointment_request': 'INTENT',
  'web.newsletter_signup': 'INTENT',
  'web.chat_complete': 'INTENT',
  'web.heartbeat': 'TELEMETRY',
  'web.scroll_depth': 'TELEMETRY',
  'web.identify': 'TELEMETRY',
};

/** The class of a canonical `web.*` event type. Unknown types are OTHER -- never a page view. */
export function websiteEventClass(eventType: string): WebsiteEventClass {
  return EVENT_CLASS[eventType] ?? 'OTHER';
}

// --- External aggregates: the evidence contract ----------------------------------------------------------

/** A metric value: a finite non-negative number, or NULL for "the source did not report it". Never 0-for-unknown. */
export type SourceMetricValue = number | null;

/** FINAL: the source will not revise this window. PRELIMINARY: it still may (GA4 revises for days). */
export const SOURCE_WINDOW_FINALITIES = ['FINAL', 'PRELIMINARY'] as const;
export type SourceWindowFinality = (typeof SOURCE_WINDOW_FINALITIES)[number];

export const SOURCE_WINDOW_GRANULARITIES = ['DAY', 'WINDOW'] as const;
export type SourceWindowGranularity = (typeof SOURCE_WINDOW_GRANULARITIES)[number];

/** Whether a read covered everything it asked for. PARTIAL is never presented as COMPLETE. */
export type EvidenceCompleteness = 'COMPLETE' | 'PARTIAL';

/**
 * What the source said about the quality of a window. Every field is nullable: NULL means the source did not
 * say, which is different from "false".
 */
export interface SourceWindowQuality {
  /** Share of the data the source sampled, 0-100; NULL when unsampled or not reported. */
  readonly sampledPercent: number | null;
  /** The source withheld rows to protect privacy (GA4 thresholding). */
  readonly thresholded: boolean | null;
  /** Rows were folded into an "(other)" row (GA4 dataLossFromOtherRow). */
  readonly rolledUp: boolean | null;
  /** The source returned fewer rows than exist (a row cap, no pagination). */
  readonly truncated: boolean | null;
  /** Why a window is empty when the source says so; a bounded code, not prose. */
  readonly emptyReason: string | null;
  /** The IANA zone the source's day boundaries are in. */
  readonly timeZone: string | null;
}

export const EMPTY_SOURCE_WINDOW_QUALITY: SourceWindowQuality = Object.freeze({
  sampledPercent: null,
  thresholded: null,
  rolledUp: null,
  truncated: null,
  emptyReason: null,
  timeZone: null,
});

/**
 * The dimensions each external source may store, and the metrics. Search query text and campaign names are
 * ABSENT by decision -- not stored, not modelled, not sent to a model -- so no row can carry one.
 */
export const WEBSITE_SOURCE_CONTRACT: Readonly<Record<string, { readonly dimensions: readonly string[]; readonly metrics: readonly string[] }>> = {
  GOOGLE_ANALYTICS: {
    dimensions: ['TOTAL', 'PAGE_PATH', 'SOURCE_MEDIUM', 'DEVICE_CATEGORY', 'COUNTRY'],
    metrics: ['sessions', 'totalUsers', 'newUsers', 'engagedSessions', 'screenPageViews', 'keyEvents', 'averageSessionDuration', 'bounceRate'],
  },
  GOOGLE_SEARCH_CONSOLE: {
    dimensions: ['TOTAL', 'PAGE', 'DEVICE', 'COUNTRY'],
    metrics: ['clicks', 'impressions', 'ctr', 'position'],
  },
  BING_WEBMASTER: {
    dimensions: ['TOTAL', 'PAGE'],
    metrics: ['clicks', 'impressions', 'ctr', 'position'],
  },
  MICROSOFT_CLARITY: {
    dimensions: ['TOTAL', 'PAGE', 'DEVICE'],
    metrics: ['sessions', 'pagesPerSession', 'scrollDepth', 'activeTime', 'deadClicks', 'rageClicks', 'quickBacks', 'excessiveScrolling', 'scriptErrors'],
  },
};

/** Dimensions no source may carry, whatever its contract says tomorrow. */
export const FORBIDDEN_WEBSITE_DIMENSIONS = ['QUERY', 'SEARCH_QUERY', 'CAMPAIGN', 'CAMPAIGN_NAME', 'KEYWORD'] as const;

/** One stored window of external website evidence. */
export interface WebsiteSourceWindow {
  readonly sourceId: string;
  readonly subjectRef: string;
  readonly dimension: string;
  /** '' for TOTAL. A page dimension carries a normalized path (no query). */
  readonly dimensionValue: string;
  readonly granularity: SourceWindowGranularity;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly finality: SourceWindowFinality;
  readonly metrics: Readonly<Record<string, SourceMetricValue>>;
  readonly quality: SourceWindowQuality;
}

/** Why a window may not be stored. Empty means it may. Codes only. */
export function websiteSourceWindowProblems(w: WebsiteSourceWindow): string[] {
  const problems: string[] = [];
  const source = intelligenceSourceEntry(w.sourceId);
  const contract = WEBSITE_SOURCE_CONTRACT[w.sourceId];
  if (!source || !contract || !source.domains.includes('WEBSITE')) return ['SOURCE_NOT_A_WEBSITE_SOURCE'];
  if ((FORBIDDEN_WEBSITE_DIMENSIONS as readonly string[]).includes(w.dimension)) problems.push('DIMENSION_FORBIDDEN');
  else if (!contract.dimensions.includes(w.dimension)) problems.push('DIMENSION_NOT_IN_CONTRACT');
  if (w.dimension === 'TOTAL' ? w.dimensionValue !== '' : w.dimensionValue === '') problems.push('DIMENSION_VALUE_SHAPE');
  if (w.dimensionValue.length > 256) problems.push('DIMENSION_VALUE_TOO_LONG');
  if (/[?#]/.test(w.dimensionValue) || containsContactDetail(w.dimensionValue)) problems.push('DIMENSION_VALUE_NOT_MINIMIZED');
  if (!w.subjectRef || w.subjectRef.length > 256) problems.push('SUBJECT_REF_SHAPE');
  if (!(SOURCE_WINDOW_GRANULARITIES as readonly string[]).includes(w.granularity)) problems.push('GRANULARITY_UNKNOWN');
  if (!(SOURCE_WINDOW_FINALITIES as readonly string[]).includes(w.finality)) problems.push('FINALITY_UNKNOWN');
  if (!(w.windowEnd.getTime() > w.windowStart.getTime())) problems.push('WINDOW_ORDER');
  const names = Object.keys(w.metrics);
  if (names.length === 0) problems.push('NO_METRICS');
  for (const name of names) {
    if (!contract.metrics.includes(name)) {
      problems.push('METRIC_NOT_IN_CONTRACT');
      continue;
    }
    const v = w.metrics[name];
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) problems.push('METRIC_VALUE_INVALID');
  }
  const q = w.quality;
  if (q.sampledPercent !== null && !(q.sampledPercent >= 0 && q.sampledPercent <= 100)) problems.push('QUALITY_SAMPLED_RANGE');
  if (q.emptyReason !== null && !/^[A-Z][A-Z0-9_]{0,63}$/.test(q.emptyReason)) problems.push('QUALITY_EMPTY_REASON_SHAPE');
  return [...new Set(problems)];
}

/** The stream a website source observes; null for a source that is not a registered website source. */
export function websiteSourceStream(sourceId: string): IntelligenceEvidenceStream | null {
  const s = intelligenceSourceEntry(sourceId);
  return s && s.domains.includes('WEBSITE') ? s.stream : null;
}

/** A metric read back: the number, or null for "not reported". A stored 0 stays 0. */
export function sourceMetricValue(metrics: unknown, name: string): SourceMetricValue {
  if (!metrics || typeof metrics !== 'object') return null;
  const v = (metrics as Record<string, unknown>)[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// --- Organization-owned connections for external website sources -----------------------------------------

/** Where each external website source's organization connection lives (provider_connections). */
export const WEBSITE_SOURCE_CONNECTIONS: Readonly<Record<string, { readonly provider: string; readonly category: 'ANALYTICS' }>> = {
  GOOGLE_ANALYTICS: { provider: 'ga4', category: 'ANALYTICS' },
  GOOGLE_SEARCH_CONSOLE: { provider: 'google_search_console', category: 'ANALYTICS' },
  BING_WEBMASTER: { provider: 'bing_webmaster', category: 'ANALYTICS' },
  MICROSOFT_CLARITY: { provider: 'microsoft_clarity', category: 'ANALYTICS' },
};

export const ORGANIZATION_CONNECTION_STATES = ['NOT_CONNECTED', 'CONNECTED', 'FAILING', 'BACKING_OFF', 'REVOKED'] as const;
export type OrganizationConnectionState = (typeof ORGANIZATION_CONNECTION_STATES)[number];

export interface OrganizationConnectionFacts {
  readonly status: string;
  readonly revokedAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly lastSucceededAt: Date | null;
  readonly lastFailureClass: string | null;
  readonly backoffUntil: Date | null;
}

/**
 * The state of an organization's connection to an external source. A source with no connection row, or one
 * never marked CONNECTED, is NOT_CONNECTED -- a registry entry is a declaration, never a connection. CONNECTED
 * additionally needs one successful read: a connection that has never succeeded is not evidence of anything.
 */
export function organizationConnectionState(row: OrganizationConnectionFacts | null, now: Date): OrganizationConnectionState {
  if (!row) return 'NOT_CONNECTED';
  if (row.revokedAt) return 'REVOKED';
  if (row.status !== 'CONNECTED') return 'NOT_CONNECTED';
  if (row.backoffUntil && row.backoffUntil.getTime() > now.getTime()) return 'BACKING_OFF';
  if (!row.lastSucceededAt) return row.lastFailureClass ? 'FAILING' : 'NOT_CONNECTED';
  if (row.lastFailureClass && row.lastAttemptAt && row.lastAttemptAt.getTime() > row.lastSucceededAt.getTime()) return 'FAILING';
  return 'CONNECTED';
}

// --- Retention -------------------------------------------------------------------------------------------

export interface WebsiteEvidenceRetention {
  readonly category: string;
  readonly days: number;
  readonly tables: readonly string[];
  /** Exactly which rows the window governs, in words. */
  readonly rows: string;
  /** Whether the purge runs. A category may be defined and deliberately not active. */
  readonly active: 'ACTIVE' | 'DISABLED_UNTIL_ENABLED';
  readonly why: string;
}

/** The governed switch that enables the raw website telemetry purge on the worker. Anything but 'on' is off. */
export const WEBSITE_TELEMETRY_RETENTION_FLAG = 'LOOP_WEBSITE_TELEMETRY_RETENTION';

export const WEBSITE_EVIDENCE_RETENTION: readonly WebsiteEvidenceRetention[] = Object.freeze([
  Object.freeze({
    category: 'WEBSITE_RAW_TELEMETRY',
    days: 90,
    tables: Object.freeze(['interactions', 'integration_events']),
    rows: "provider 'website' rows older than the window, and only interactions attached to NO Person (customerId IS NULL)",
    active: 'DISABLED_UNTIL_ENABLED' as const,
    why:
      'Raw visit telemetry is not needed once it has been read; the durable Pipeline fact (a WEB_LEAD) is the Customer row ' +
      'and the form submission attached to it, which this purge never selects. Defined, NOT active: enabling it truncates ' +
      '/crm/analytics history beyond 90 days, so it waits for an explicit decision (LOOP_WEBSITE_TELEMETRY_RETENTION=on).',
  }),
  Object.freeze({
    category: 'WEBSITE_SOURCE_AGGREGATES',
    days: 400,
    tables: Object.freeze(['source_metric_windows']),
    rows: 'windows that ENDED before the window',
    active: 'ACTIVE' as const,
    why: 'Thirteen months keeps a year-over-year comparison of the same month possible; nothing older is read.',
  }),
]);

/** Whether the raw website telemetry purge is enabled by its flag. Fails closed: unset, empty or any other value is off. */
export function websiteTelemetryRetentionEnabled(flag: string | undefined): boolean {
  return String(flag ?? '').trim().toLowerCase() === 'on';
}
