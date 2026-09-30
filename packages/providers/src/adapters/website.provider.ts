// WebsiteProvider -- Loop's first-party website events (the emg-loop.js tracker, or a signed server sender).
//
// Translates raw website events into the provider-agnostic InboundEvent shape. It contains NO business
// logic, writes NO data and decides NO tenancy: which organization a property belongs to is the governed
// property registry's answer (web_properties), resolved by the website webhook after verification. Nothing
// here -- and nothing in a payload -- selects an organization.
//
// WHAT IS KEPT (2026-09-30): only the minimized attribute set in @emgloop/shared `minimizeWebsiteEvent` --
// a page PATH with no query string, bounded labels, pseudonymous visitor/session ids. An email address, a
// phone number, their click targets, the full URL, free-text search, campaign names and every unknown key
// are dropped here, before persistence, and are never handed to the ingestion pipeline as customer
// identity (the tracker's identify() fields do not create or match people).
//
// IDENTITY IS DETERMINISTIC: `web:<property>:<event id>` when the sender supplies an id (the tracker always
// does), else `web:<property>:h:<sha256 of the minimized event>`. A redelivery of the same event dedupes;
// no id is ever derived from the receiving clock. The property prefix keeps two properties' ids apart in the
// globally keyed integration_events table.
//
// Webhook authenticity for the signed tier is an HMAC-SHA256 over the raw body (webhook-security.ts).

import { createHash } from 'crypto';
import { minimizeWebsiteEvent, isWebPropertyKey } from '@emgloop/shared';
import { verifySignedWebhook } from '../webhook-security';
import type { ProviderContext } from '../types';
import type {
  IngestionProvider,
  IngestionCapabilities,
  InboundEvent,
  PollOptions,
  PollResult,
  WebhookVerificationResult,
} from '../interfaces/ingestion.provider';

// ---- Website raw event vocabulary -----------------------------------------
// Websites emit a rich "event" / "type" string. We map each to the canonical
// platform web.* event taxonomy (see @emgloop/shared LOOP_EVENT_TYPES). Tracker
// instrumentation (heartbeat, scroll depth, identify) has its own types, and an
// unknown event is `web.other` -- NEVER a page view, which it once defaulted to and
// so inflated page views with every heartbeat.
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
  // Tracker instrumentation -- about a page already viewed, not a view.
  heartbeat: 'web.heartbeat',
  scroll_depth: 'web.scroll_depth',
  scroll: 'web.scroll_depth',
  identify: 'web.identify',
};

/** Map a raw website event string to the canonical loop event type string. */
export function mapWebsiteEventType(raw: string): string {
  const key = String(raw ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  return WEBSITE_EVENT_MAP[key] ?? 'web.other';
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
        'web.heartbeat',
        'web.scroll_depth',
        'web.identify',
        'web.other',
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
    return verifySignedWebhook(headers, rawBody, {
      secret: ctx.credentials?.['webhookSecret'] ?? '',
      allowUnsigned: ctx.config?.['allowUnsigned'] === true,
      signatureHeaders: ['x-emg-signature', 'x-website-signature', 'x-signature'],
      timestampHeaders: ['x-emg-timestamp', 'x-timestamp'],
    });
  }

  /**
   * Parse a verified website webhook body into InboundEvents. A delivery carries ONE event ({ event, ... })
   * or a BATCH ({ events: [...] }). Each event keeps only its minimized attributes plus the property key it
   * CLAIMS (payload.property) -- a claim the webhook checks against the registry, never trusts. An event
   * whose property is not a well-formed key is kept with property '' so the webhook refuses it by code.
   * No customerEmail / customerPhone is ever returned: website telemetry does not establish identity.
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
    for (const raw of batch) {
      if (!raw || typeof raw !== 'object') continue;
      const data = raw as Record<string, unknown>;

      const claimed = (pick(data, ['property', 'site', 'source_site', 'brand']) ?? topProperty ?? '').toLowerCase();
      const property = isWebPropertyKey(claimed) ? claimed : '';

      const rawEventType =
        pick(data, ['event', 'type', 'event_type', 'name', 'action']) ?? 'page_viewed';

      const occurredRaw = pick(data, ['occurred_at', 'timestamp', 'time', 'created_at']);
      const occurred = occurredRaw ? new Date(occurredRaw) : null;
      const occurredAt = occurred && !Number.isNaN(occurred.getTime()) ? occurred : null;

      const minimized = minimizeWebsiteEvent(data, property);
      const externalId = websiteEventExternalId(property, pick(data, ['id', 'event_id', 'eventId', 'uuid']), {
        rawEventType,
        occurredRaw: occurredRaw ?? null,
        minimized,
      });

      out.push({
        externalId,
        rawEventType,
        // An event without a readable time is stamped at receipt; its IDENTITY never is (see above).
        occurredAt: occurredAt ?? new Date(),
        payload: { ...minimized },
      });
    }
    return out;
  }

  async poll(_ctx: ProviderContext, _options: PollOptions): Promise<PollResult> {
    // Websites are webhook-only in this sprint.
    return { events: [], hasMore: false };
  }
}

const EVENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The deterministic, property-namespaced identity of a website event: `web:<property>:<id>` for a
 * sender-supplied id, else `web:<property>:h:<sha256>` over the minimized event, its raw type and its raw
 * time. Never the receiving clock, so the same event redelivered is the same row.
 */
export function websiteEventExternalId(
  property: string,
  senderId: string | undefined,
  basis: { rawEventType: string; occurredRaw: string | null; minimized: Record<string, unknown> },
): string {
  const ns = `web:${property || 'unregistered'}:`;
  if (senderId && EVENT_ID.test(senderId)) return ns + senderId;
  const canonical = JSON.stringify([
    basis.rawEventType,
    basis.occurredRaw,
    Object.keys(basis.minimized).sort().map((k) => [k, basis.minimized[k]]),
  ]);
  return ns + 'h:' + createHash('sha256').update(canonical).digest('hex').slice(0, 40);
}
