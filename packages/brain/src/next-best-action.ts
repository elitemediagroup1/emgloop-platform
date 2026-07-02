// @emgloop/brain — Next Best Action capability.
//
// Phase 1 (Brain Boundary): the deterministic "what should happen next" DECISION
// logic now lives in the Brain — the center of the platform — instead of the
// data/services layer. Services (e.g. @emgloop/database's NextBestActionService)
// INVOKE this capability; they no longer own the decision. Persistence and I/O
// remain in the service layer; the Brain stays pure (no DB, no provider coupling,
// depends solely on @emgloop/shared).
//
// The rules below are a behaviour-preserving port of the previously shipping
// rules-based engine, so callers observe IDENTICAL ranked output. No AI reasoning
// is used: every recommendation is deterministic, provider-agnostic and auditable.

/**
 * The catalog of operational Next Best Action kinds the platform emits today.
 * NOTE: this is the concrete, SHIPPING operational set. It is intentionally kept
 * separate from the broader aspirational Recommendation catalog in
 * ./recommendation so that porting the live engine changes NO observable output.
 */
export type NbaKind =
  | 'assign_ai_employee'
  | 'assign_human'
  | 'create_follow_up'
  | 'recommend_workflow'
  | 'recommend_channel'
  | 'operational_recommendation';

/** A single, ranked operational recommendation. */
export interface NbaAction {
  kind: NbaKind;
  priority: number; // 1 (highest) .. 5 (lowest)
  title: string;
  detail: string;
  /** Optional machine hints for downstream automation (workflow, channel, ...). */
  hint?: Record<string, unknown>;
}

/** The minimal interaction shape the decision needs. */
export interface NbaInteraction {
  channel: string | null;
  direction: string | null;
  summary: string | null;
  metadata?: Record<string, unknown>;
}

/** Everything the Brain needs to decide — pure inputs, no DB handles. */
export interface NbaContext {
  interaction: NbaInteraction;
  /** Accumulated signal keys for the customer (e.g. 'phone_preference'). */
  signalKeys: Iterable<string>;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Compute the ranked Next Best Actions for a context. Pure function over the
 * inputs — no DB reads, no side effects — so it is trivial to test and audit.
 * This is the single source of truth for the NBA decision.
 */
export function recommendNextBestActions(ctx: NbaContext): NbaAction[] {
  const actions: NbaAction[] = [];
  const signalKeys = new Set<string>(ctx.signalKeys);
  const meta = asObject(ctx.interaction.metadata);
  const eventType = typeof meta['eventType'] === 'string' ? (meta['eventType'] as string) : '';

  // Rule 1 — a missed inbound call is the highest-urgency operational event.
  if (eventType === 'call.missed' || ctx.interaction.summary?.toLowerCase().includes('missed')) {
    actions.push({
      kind: 'create_follow_up',
      priority: 1,
      title: 'Call back missed caller',
      detail: 'An inbound call was missed. Return the call promptly to avoid losing the lead.',
      hint: { channel: 'phone', dueWithinMinutes: 15 },
    });
    actions.push({
      kind: 'recommend_workflow',
      priority: 2,
      title: 'Run missed-call recovery workflow',
      detail: 'Trigger the missed-call follow-up automation to tag and queue the customer.',
      hint: { eventName: 'integration.call.missed' },
    });
  }

  // Rule 2 — emergency intent should be assigned to a human immediately.
  if (signalKeys.has('emergency_intent')) {
    actions.push({
      kind: 'assign_human',
      priority: 1,
      title: 'Assign to a human agent (emergency)',
      detail: 'Emergency intent detected. Route to a human dispatcher for immediate handling.',
      hint: { reason: 'emergency_intent' },
    });
  }

  // Rule 2b — Sprint 14: website appointment intent is a hot, sales-ready lead.
  if (signalKeys.has('appointment_intent') || eventType === 'web.appointment_request') {
    actions.push({
      kind: 'create_follow_up',
      priority: 1,
      title: 'Confirm the requested appointment',
      detail: 'The customer requested an appointment on the website. Confirm the booking quickly while intent is high.',
      hint: { reason: 'web_appointment_intent', dueWithinMinutes: 30 },
    });
  }

  // Rule 2c — Sprint 14: website buying intent FOLLOWED by a call is high-confidence.
  // Reads both senses from the shared signal pool — the cross-channel boost.
  if (signalKeys.has('buying_intent') && ctx.interaction.channel === 'PHONE') {
    actions.push({
      kind: 'assign_human',
      priority: 2,
      title: 'Prioritize — researched online, now calling',
      detail: 'This customer showed buying intent on the website and is now on a call. Treat as a high-confidence, sales-ready lead.',
      hint: { reason: 'web_then_call', confidence: 'high' },
    });
  }

  // Rule 2d — Sprint 14: research-only website behaviour deserves nurturing.
  if (
    (signalKeys.has('research_intent') || signalKeys.has('comparison_shopper')) &&
    !signalKeys.has('buying_intent') &&
    !signalKeys.has('appointment_intent')
  ) {
    actions.push({
      kind: 'recommend_channel',
      priority: 4,
      title: 'Nurture an active researcher',
      detail: 'The customer is researching but has not converted. Share a helpful guide or follow up by email to stay top-of-mind.',
      hint: { reason: 'web_research', channel: 'email' },
    });
  }

  // Rule 3 — a new inbound contact with no owner gets an AI Employee first-touch.
  if (
    (ctx.interaction.direction === 'INBOUND') &&
    !signalKeys.has('emergency_intent')
  ) {
    actions.push({
      kind: 'assign_ai_employee',
      priority: 3,
      title: 'Assign default AI Employee for first response',
      detail: 'Let the default AI Employee acknowledge and qualify this new inbound contact.',
      hint: { reason: 'first_touch' },
    });
  }

  // Rule 4 — phone-preferring customers should be reached by phone.
  if (signalKeys.has('phone_preference') || ctx.interaction.channel === 'PHONE') {
    actions.push({
      kind: 'recommend_channel',
      priority: 4,
      title: 'Prefer phone for outreach',
      detail: 'This customer engages by phone. Use a call for the next outreach attempt.',
      hint: { channel: 'phone' },
    });
  }

  // Rule 5 — service interest without a booking is an operational follow-up.
  if (signalKeys.has('service_interest') && !signalKeys.has('booking_created')) {
    actions.push({
      kind: 'operational_recommendation',
      priority: 3,
      title: 'Send a quote / book the service',
      detail: 'Service interest is present but no booking exists. Provide a quote or schedule the job.',
      hint: { reason: 'service_interest_no_booking' },
    });
  }

  // Always provide at least one baseline action.
  if (actions.length === 0) {
    actions.push({
      kind: 'operational_recommendation',
      priority: 5,
      title: 'Review interaction',
      detail: 'No urgent rule matched. Review the interaction and update the pipeline as needed.',
    });
  }

  return actions.sort((a, b) => a.priority - b.priority);
}
