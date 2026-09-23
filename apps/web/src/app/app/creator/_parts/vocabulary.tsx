// The creator seat's presentation vocabulary (Creator Hub, 2026-09-22). PURE.
//
// What a state LOOKS like on the creator's surfaces: the tone of each lifecycle,
// compensation and opportunity state, the words for a refusal, and the small
// formatters these pages share. Nothing here reads a row or a clock; the words
// come from @emgloop/shared and the tones from the Loop palette's four semantic
// states (good, attention, critical, neutral) plus the accent for "in motion".
//
// No runtime import from @emgloop/database: the record body and the panels below
// render in a plain test process, and a client leaf may import this file.

import type { CompensationState, ContentState, CreatorVisibleOpportunityState } from '@emgloop/shared';

export type Tone = 'good' | 'attention' | 'critical' | 'neutral' | 'info';

export const CONTENT_STATE_TONES: Record<ContentState, Tone> = {
  RAW: 'neutral',
  IN_PRODUCTION: 'info',
  YOUR_REVIEW: 'attention',
  CHANGES_REQUESTED: 'info',
  APPROVED_BY_YOU: 'attention',
  FINAL: 'good',
  PUBLISHED: 'good',
};

export const COMPENSATION_TONES: Record<CompensationState, Tone> = {
  EXPECTED: 'neutral',
  PENDING: 'attention',
  RECEIVED_BY_EMG: 'info',
  AVAILABLE: 'good',
  TRANSFER_PENDING: 'attention',
  PAID: 'good',
};

export const OPPORTUNITY_TONES: Record<CreatorVisibleOpportunityState, Tone> = {
  BRAND_INTEREST: 'neutral',
  PITCHING: 'info',
  NEGOTIATING: 'attention',
  CONFIRMED: 'good',
  DIDNT_GO_AHEAD: 'neutral',
};

/** A lifecycle pill. The Loop pill primitive takes a SubjectState; the creator seat also needs the accent ("in motion"). */
export function Pill({ tone, children, small }: { tone: Tone; children: React.ReactNode; small?: boolean }) {
  return <span className={`loop-pill loop-pill--${tone}${small ? ' ch-pill--sm' : ''}`}>{children}</span>;
}

/** Minor units in a currency, e.g. 125000 USD -> $1,250.00. Never a rounded-away cent, never "$0" for unknown. */
export function moneyMinor(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

/** 18412 -> "18.4K"; 1234567 -> "1.2M"; below a thousand, the exact number. */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return n.toLocaleString('en-US');
}

/** The words for a service refusal, keyed by the reason the redirect carried. Unknown reasons say so. */
export function refusalText(reason: string, detail: string | null): { title: string; body: string } {
  const bodyFor: Record<string, string> = {
    PRODUCTION_ACTIVE: 'This content is already in production. Add a note to the current production instead of starting another.',
    NO_ACTIVE_PRODUCTION: 'Nothing is in production for this content, so there is nothing to add a note to or send changes on.',
    NOT_YOUR_STEP: 'Nothing is waiting for your review right now.',
    VERSION_NOT_READY: 'That version has not finished uploading, so it cannot be used yet.',
    NOT_ALLOWED: 'This content is not ready for that.',
    NOT_FOUND: 'Loop could not find that version or content.',
    INVALID: 'Something the form needed was missing.',
    BAD_NOTES: 'Your notes could not be read. Check that each one has a time and some words.',
    BAD_DATE: 'The date you entered could not be read.',
    BAD_PLATFORM: 'Choose one of the platforms Loop knows.',
    BAD_URL: 'A link must start with http:// or https://.',
  };
  const body = bodyFor[reason] ?? 'Loop did not carry out that action.';
  return { title: 'That did not go through.', body: detail ? `${body} ${detail}` : body };
}

/** The value of a search parameter that may arrive as a string, an array or nothing. */
export function param(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' && value !== '' ? value : null;
}
