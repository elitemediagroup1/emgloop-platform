// WebsiteProvider — Sprint 14 (Website Intelligence — The Brain's Second Sense).
//
// The platform's SECOND real ingestion adapter (after CallGrid). Where CallGrid
// gives the Brain a sense for phone calls, WebsiteProvider gives it a sense for
// EVERY EMG-owned website. It translates raw website interaction events — page
// views, searches, CTA/phone/email clicks, form starts/submits, chat, quizzes,
// planners, downloads, video plays, sessions — into the platform's
// provider-agnostic InboundEvent shape.
//
// Like CallGrid, this adapter contains NO business logic and writes NO data.
// Normalization, identity resolution, persistence, signals, and workflows all
// happen downstream in the NormalizationEngine + IngestionService. A different
// website platform simply produces the same wire payload; nothing else changes.
//
// It is generic across every InMyCity property: ServicesInMyCity, CareInMyCity,
// PetsInMyCity, ConsumerSupportHelp — and any future property — plug in with no
// code duplication, because the adapter keys on a "property" field, never on a
// hard-coded site.
//
// No vendor SDK is imported. Webhook authenticity is verified with an
// HMAC-SHA256 signature over the raw body using a shared secret resolved from
// ProviderContext (never stored in this file). Node's built-in crypto keeps
// dependencies at zero.

import { createHmac, timingSafeEqual } from 'crypto';
import type { ProviderContext } from '../types';
import type {
  IngestionProvider,
  IngestionCapabilities,
  InboundEvent,
  PollOptions,
  PollResult,
  WebhookVerificationResult,
} from '../interfaces/ingestion.provider';

// ---- EMG-owned website properties -----------------------------------------
// The provider is generic: any property string is accepted. These are the
// initially-supported InMyCity properties, exported so callers/UX can list them.
export const WEBSITE_PROPERTIES = [
  'servicesinmycity',
  'careinmycity',
  'petsinmycity',
  'consumersupporthelp',
] as const;
export type WebsiteProperty = (typeof WEBSITE_PROPERTIES)[number];

// ---- Website raw event vocabulary -----------------------------------------
// Websites emit a rich "event" / "type" string. We map each to the canonical
// platform web.* event taxonomy (see @emgloop/shared LOOP_EVENT_TYPES). Unknown
// events map to a generic page view so nothing is silently dropped.
export const WEBSITE_EVENT_MAP: Record<string, string> = {
  // Pages & content
  page_viewed: 'web.page_view',
  page_view: 'web.page_view',
  pageview: 'web.page_view',
  guide_viewed: 'web.guide_view',
  guide_view: 'web.guide_view',
  // Search
  search_performed: 'web.search',
  search: 'web.search',
  zip_search: 'web.search_zip',
  city_search: 'web.search_city',
  category_search: 'web.search_category',
  // CTAs / outbound clicks
  cta_click: 'web.cta_click',
  cta_clicked: 'web.cta_click',
  phone_click: 'web.phone_click',
  click_to_call: 'web.phone_click',
  email_click: 'web.email_click',
  external_link_click: 'web.external_link',
  affiliate_click: 'web.affiliate_click',
  // Forms
  form_started: 'web.form_start',
  form_start: 'web.form_start',
  form_submitted: 'web.form_submit',
  form_submit: 'web.form_submit',
  appointment_requested: 'web.appointment_request',
  newsletter_signup: 'web.newsletter_signup',
  // Chat
  chat_started: 'web.chat_start',
  chat_start: 'web.chat_start',
  chat_completed: 'web.chat_complete',
  chat_complete: 'web.chat_complete',
  // Resources & interactive tools
  resource_download: 'web.download',
  download: 'web.download',
  quiz_started: 'web.quiz_start',
  quiz_completed: 'web.quiz_complete',
  planner_started: 'web.planner_start',
  planner_saved: 'web.planner_save',
  planner_printed: 'web.planner_print',
  video_played: 'web.video_play',
  video_play: 'web.video_play',
  // Errors
  error_encountered: 'web.error',
  error: 'web.error',
  // Session lifecycle
  session_started: 'web.session_start',
  session_start: 'web.session_start',
  session_ended: 'web.session_end',
  session_end: 'web.session_end',
};

/** Map a raw website event string to the canonical loop event type string. */
export function mapWebsiteEventType(raw: string): string {
  const key = String(raw ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  return WEBSITE_EVENT_MAP[key] ?? 'web.page_view';
}

/** Pull a string field from a raw payload trying several common key spellings. */
function pick(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

// ---- Provider --------------------------------------------------------------

export class WebsiteProvider implements IngestionProvider {
  readonly info = {
    id: 'website',
    category: 'ingestion' as const,
    displayName: 'EMG Websites',
  };

  async healthCheck(_ctx: ProviderContext) {
    // Webhook-driven, like CallGrid: health is "ok" while the adapter is
    // registered and resolvable. No outbound network call in this sprint.
    return { ok: true, checkedAt: new Date().toISOString() };
  }

  capabilities(): IngestionCapabilities {
    return {
      webhooks: true,
      polling: false,
      streaming: false,
      eventTypes: [
        'web.session_start',
        'web.session_end',
        'web.page_view',
        'web.guide_view',
        'web.search',
        'web.search_zip',
        'web.search_city',
        'web.search_category',
        'web.cta_click',
        'web.phone_click',
        'web.email_click',
        'web.external_link',
        'web.affiliate_click',
        'web.form_start',
        'web.form_submit',
        'web.appointment_request',
        'web.newsletter_signup',
        'web.chat_start',
        'web.chat_complete',
        'web.download',
        'web.quiz_start',
        'web.quiz_complete',
        'web.planner_start',
        'web.planner_save',
        'web.planner_print',
        'web.video_play',
        'web.error',
      ],
    };
  }

  /**
   * Verify an inbound website webhook with an HMAC-SHA256 signature. The shared
   * secret comes from ProviderContext.credentials.webhookSecret. If no secret is
   * configured the request is rejected (fail closed), except when
   * ctx.config.allowUnsigned === true (used only for the sandbox/test connection
   * so reviewers can exercise the pipeline without a real secret).
   */
  async verifyWebhook(
    ctx: ProviderContext,
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<WebhookVerificationResult> {
    const secret = ctx.credentials?.['webhookSecret'] ?? '';
    const allowUnsigned = ctx.config?.['allowUnsigned'] === true;

    if (!secret) {
      return allowUnsigned
        ? { valid: true, reason: 'unsigned-allowed' }
        : { valid: false, reason: 'no-secret-configured' };
    }

    const provided =
      headers['x-emg-signature'] ??
      headers['x-website-signature'] ??
      headers['x-signature'] ??
      '';
    if (!provided) {
      return { valid: false, reason: 'missing-signature-header' };
    }

    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided.replace(/^sha256=/, ''), 'utf8');
    const valid = a.length === b.length && timingSafeEqual(a, b);
    return valid ? { valid: true } : { valid: false, reason: 'signature-mismatch' };
  }

  /**
   * Parse a verified website webhook body into InboundEvents. A single delivery
   * may carry ONE event ({ event, ... }) OR a BATCH ({ events: [...] }) so a
   * site can flush a whole session at once. Every raw attribute is preserved on
   * .payload (with a normalized "property") so the NormalizationEngine and the
   * customer timeline keep the full website context (page, search, city,
   * category, sessionId, visitorId, source, etc.).
   */
  async parseWebhook(
    _ctx: ProviderContext,
    payload: Record<string, unknown>,
  ): Promise<InboundEvent[]> {
    const batch = Array.isArray(payload['events'])
      ? (payload['events'] as unknown[])
      : [payload];

    const topProperty = pick(payload, ['property', 'site', 'source_site', 'brand']);

    const out: InboundEvent[] = [];
    for (let i = 0; i < batch.length; i++) {
      const raw = batch[i];
      if (!raw || typeof raw !== 'object') continue;
      const data = raw as Record<string, unknown>;

      const property =
        pick(data, ['property', 'site', 'source_site', 'brand']) ?? topProperty ?? 'website';

      const rawEventType =
        pick(data, ['event', 'type', 'event_type', 'name', 'action']) ?? 'page_viewed';

      const externalId =
        pick(data, ['id', 'event_id', 'eventId', 'uuid']) ??
        'web-' + property + '-' + Date.now() + '-' + i;

      const occurredRaw = pick(data, ['occurred_at', 'timestamp', 'time', 'created_at']);
      const occurredAt = occurredRaw ? new Date(occurredRaw) : new Date();

      const customerEmail = pick(data, ['email', 'customer_email', 'user_email']);
      const customerPhone = pick(data, ['phone', 'customer_phone', 'tel']);

      // Surface common website dimensions onto the payload so the signal
      // registry + analytics can read them without re-parsing nested shapes.
      const enriched: Record<string, unknown> = {
        ...data,
        property,
        page: pick(data, ['page', 'path', 'url', 'page_path', 'page_url']),
        title: pick(data, ['title', 'page_title']),
        query: pick(data, ['query', 'q', 'search', 'search_term', 'keyword']),
        zip: pick(data, ['zip', 'zipcode', 'postal_code']),
        city: pick(data, ['city']),
        category: pick(data, ['category', 'service', 'vertical']),
        source: pick(data, ['source', 'utm_source', 'referrer', 'channel']),
        cta: pick(data, ['cta', 'cta_label', 'label', 'button']),
        sessionId: pick(data, ['session_id', 'sessionId', 'session']),
        visitorId: pick(data, ['visitor_id', 'visitorId', 'anonymous_id', 'client_id', 'cookie_id']),
      };

      out.push({
        externalId,
        rawEventType,
        occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
        payload: enriched,
        customerEmail,
        customerPhone,
      });
    }
    return out;
  }

  async poll(_ctx: ProviderContext, _options: PollOptions): Promise<PollResult> {
    // Websites are webhook-only in this sprint.
    return { events: [], hasMore: false };
  }
}
