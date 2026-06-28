// operational-filters.ts — Sprint 15 hotfix (real-data, production-safe views).
//
// Shared, deterministic helpers that keep Live Operations, Traffic and Revenue
// Intelligence HONEST. They do three things and nothing else:
//   1. Identify obvious demo / QA / E2E / test records so active operational
//      views can EXCLUDE them (records are never deleted — only filtered).
//   2. Reject fabricated attribution labels (e.g. 'Vendor A', 'Buyer X',
//      'E2E Traffic Partner A') so missing attribution is shown honestly as
//      'Unknown ...' rather than a fake partner name.
//   3. Provide recency windows and canonical EMG property names.
//
// No schema changes: detection uses existing columns (tags, email, phone,
// externalId) and Interaction.metadata only.

// --- Recency windows (ms) -------------------------------------------------
export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const LIVE_ACTIVITY_WINDOW_MS = DAY; // last 24h
export const LIVE_CALLS_WINDOW_MS = DAY; // last 24h
export const LIVE_WEBSITE_WINDOW_MS = 60 * MINUTE; // last 60 min (active sessions)
export const TRAFFIC_DEFAULT_WINDOW_MS = 7 * DAY; // last 7 days
export const REVENUE_DEFAULT_WINDOW_MS = 7 * DAY; // last 7 days

export function since(windowMs: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - windowMs);
}

// --- EMG properties -------------------------------------------------------
// The canonical EMG web properties, in display order. The Live Website Feed
// property selector is driven by this list.
export interface EmgProperty {
  key: string; // canonical machine key, e.g. 'servicesinmycity'
  name: string; // display name, e.g. 'ServicesInMyCity'
  domains: string[]; // raw property/website strings that map to this property
}

export const EMG_PROPERTIES: EmgProperty[] = [
  { key: 'servicesinmycity', name: 'ServicesInMyCity', domains: ['servicesinmycity', 'servicesinmycity.com'] },
  { key: 'consumersupporthelp', name: 'ConsumerSupportHelp', domains: ['consumersupporthelp', 'consumersupporthelp.com'] },
  { key: 'careinmycity', name: 'CareInMyCity', domains: ['careinmycity', 'careinmycity.com'] },
  { key: 'petsinmycity', name: 'PetsInMyCity', domains: ['petsinmycity', 'petsinmycity.com'] },
  { key: 'marriageinmycity', name: 'MarriageInMyCity', domains: ['marriageinmycity', 'marriageinmycity.com'] },
  { key: 'gamedayinmycity', name: 'GameDayInMyCity', domains: ['gamedayinmycity', 'gamedayinmycity.com'] },
];

// Map a raw property/website string to a canonical EMG property key, or null.
export function propertyKeyOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const r = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  for (const p of EMG_PROPERTIES) {
    if (p.domains.some((d) => r === d || r.startsWith(d + '/') || r.startsWith(d))) return p.key;
  }
  return null;
}

export function propertyNameOf(raw: string | null | undefined): string | null {
  const key = propertyKeyOf(raw);
  if (!key) return null;
  return EMG_PROPERTIES.find((p) => p.key === key)?.name ?? null;
}

// --- Excluded (demo / QA / E2E / test) record detection -------------------
// Tags that mark a record as non-production. Matched case-insensitively.
const EXCLUDED_TAGS = new Set(['demo', 'test', 'qa', 'e2e', 'sample', 'seed', 'fixture', 'archived', 'sprint-14-archive']);

// Email domains used only by QA / fixtures.
const TEST_EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net', 'test.com', 'qa.test', 'mailinator.com'];

// Reserved 'fictional use' phone ranges (NANP 555-0100..555-0199) plus the
// generic 555 placeholder block widely used in seed/E2E data.
export function isPlaceholderPhone(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const digits = phone.replace(/[^0-9]/g, '');
  if (!digits) return false;
  // 555-01xx reserved fictional range (……555 01 xx)
  if (/555014[0-9]|5550199|55501[0-9][0-9]/.test(digits)) return true;
  // generic 555 placeholder exchange e.g. +1 312 555 xxxx
  if (/^1?\d{3}555\d{4}$/.test(digits)) return true;
  return false;
}

export interface CustomerLike {
  tags?: string[] | null;
  email?: string | null;
  phone?: string | null;
  externalId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

// True when a customer is an obvious demo / QA / E2E / test record that must
// NOT appear in active operational views. Conservative: only excludes records
// with explicit non-production signals.
export function isExcludedCustomer(c: CustomerLike | null | undefined): boolean {
  if (!c) return false;
  const tags = (c.tags ?? []).map((t) => String(t).toLowerCase());
  if (tags.some((t) => EXCLUDED_TAGS.has(t))) return true;
  const email = (c.email ?? '').toLowerCase();
  if (email && TEST_EMAIL_DOMAINS.some((d) => email.endsWith('@' + d))) return true;
  const ext = (c.externalId ?? '').toLowerCase();
  if (ext.startsWith('demo-') || ext.startsWith('e2e-') || ext.startsWith('test-') || ext.startsWith('qa-') || ext.startsWith('hotfix-verify')) return true;
  if (isPlaceholderPhone(c.phone)) return true;
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').toLowerCase();
  if (name === 'maria gonzalez') return true; // known seed demo persona
  return false;
}

// External IDs (provider event ids / session ids) created by tests.
export function isExcludedExternalId(externalId: string | null | undefined): boolean {
  if (!externalId) return false;
  const e = externalId.toLowerCase();
  return e.startsWith('e2e-') || e.startsWith('test-') || e.startsWith('qa-') || e.startsWith('hotfix-verify') || e.startsWith('demo-');
}

// --- Fabricated attribution labels ----------------------------------------
// Labels that are placeholders/fixtures, NOT real production partners. If an
// attribution value matches one of these it is treated as MISSING.
const FABRICATED_LABEL_PATTERNS: RegExp[] = [
  /^vendor\s+[a-z]$/i, // 'Vendor A', 'Vendor X'
  /^buyer\s+[a-z]$/i, // 'Buyer X'
  /^source\s+[a-z]$/i,
  /^campaign\s+[a-z]$/i,
  /^partner\s+[a-z]$/i,
  /^e2e\b/i, // 'E2E Traffic Partner A'
  /^demo\b/i, // 'Demo Vendor'
  /^test\b/i,
  /^sample\b/i,
  /^\(unattributed\)$/i,
  /^unknown$/i,
];

export function isFabricatedLabel(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (!v) return false;
  return FABRICATED_LABEL_PATTERNS.some((re) => re.test(v));
}

// Honest 'missing attribution' display values.
export const UNKNOWN = {
  vendor: 'Unknown vendor',
  source: 'Unknown source',
  campaign: 'Unknown campaign',
  buyer: 'Unknown buyer',
} as const;

// Returns a real attribution value, or null when it is missing/fabricated.
// The caller decides how to render null (e.g. 'Unknown vendor').
export function realAttr(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  if (isFabricatedLabel(v)) return null;
  return v;
}
