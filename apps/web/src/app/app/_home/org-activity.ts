// Home's Recent activity, as the organization's Universal Activity feed -- the pure half.
//
// The executive Home used to read the latest audit rows directly, without `audit:view`
// (universal-activity.md §6), so a busy organization whose CallGrid, channel and Brain work
// was all live still read "No business activity recorded yet." It now reads the governed
// `ActivityService` for the ORGANIZATION subject (org-activity-data.ts), and this file holds
// everything about that read that needs no I/O:
//
//   WHICH ADAPTERS. Only organization-level OBSERVABLE-EVENT sources: channel facts
//   (Interaction), CallGrid calls (MarketplaceCall), the audit log, and Brain work events --
//   and of those only the ones the service then authorizes for the viewer. Nothing
//   employee-private is composed: no mail, no Telegram, no source observations, no work items.
//   The list is an allowlist by the adapter's own domain, so a source added to the read model
//   later is excluded from Home until somebody decides it belongs here.
//
//   HOW A ROW READS. Each item keeps the truth category its authority gave it (a fact, a
//   communication, a change, an audit act). These are events, not intelligence: nothing here
//   scores, ranks or interprets them. A title is built from the item's closed vocabulary only.
//
//   WHAT FAILED IS NOT "NONE". A read that could not be made is UNAVAILABLE; a viewer with no
//   readable source is NOT_AUTHORIZED; only a read that ran and returned nothing is empty.
//
// PURE: no database, no clock, no environment.

import type { ActivityItemV1, ActivitySourceReadV1, TimeView } from '@emgloop/shared';
import type { ActivityEntry } from '../_loop-os/activity-item';

/**
 * The organization-level observable-event sources Home composes, by adapter domain. Each is an
 * organization's own record of something that happened; none is one employee's private source.
 */
export const HOME_ACTIVITY_DOMAINS = Object.freeze(['channel', 'callgrid', 'audit', 'brain-execution'] as const);
export type HomeActivityDomain = (typeof HOME_ACTIVITY_DOMAINS)[number];

/** How many items Home asks the feed for: enough for the card and the review's work changes. */
export const ORG_ACTIVITY_LIMIT = 20;

/** The adapters Home composes: organization-lane, allowlisted domain. Everything else is dropped unread. */
export function homeActivityAdapters<A extends { readonly domain: string; supports(subject: { readonly kind: 'ORGANIZATION' }): boolean }>(
  adapters: readonly A[],
): A[] {
  const allowed = HOME_ACTIVITY_DOMAINS as readonly string[];
  return adapters.filter((a) => allowed.includes(a.domain) && a.supports({ kind: 'ORGANIZATION' }));
}

export type OrgActivity =
  | {
      readonly state: 'READ';
      readonly items: readonly ActivityItemV1[];
      /** What the service reported per source (read or skipped), for the card's provenance line. */
      readonly sources: readonly ActivitySourceReadV1[];
      /** Display names of the organization members the items name as actors, by user id. */
      readonly names: ReadonlyMap<string, string>;
    }
  /** The viewer may read none of the composed sources. Not an empty feed. */
  | { readonly state: 'NOT_AUTHORIZED' }
  /** The read could not be made. Never "no activity". */
  | { readonly state: 'UNAVAILABLE' };

/** What each composed source is called on Home. */
const SOURCE_NAME: Readonly<Record<string, string>> = Object.freeze({
  channel: 'channel facts',
  'crm-intake': 'channel facts',
  callgrid: 'CallGrid calls',
  audit: 'the audit log',
  'brain-execution': 'Brain work',
});

export function sourceName(domain: string): string {
  return SOURCE_NAME[domain] ?? domain;
}

/** The sources that were actually read, named, in composition order. */
export function readSourceNames(activity: OrgActivity): string[] {
  if (activity.state !== 'READ') return [];
  return activity.sources.filter((s) => s.skipped === null).map((s) => sourceName(s.domain));
}

// --- Audit vocabulary ---------------------------------------------------------------------------

const AUDIT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'organization.setup.completed': 'Owner setup completed',
  'organization.updated': 'Organization updated',
  'user.created': 'Team member added',
  'user.invited': 'Employee invited',
  'user.updated': 'Team member updated',
  'user.disabled': 'Team member disabled',
  'invitation.created': 'Invitation sent',
  'invitation.accepted': 'Invitation accepted',
  'customer.created': 'Customer created',
  'customer.updated': 'Customer updated',
  'work.created': 'Work created',
  'work.completed': 'Work completed',
  'work.assigned': 'Work assigned',
  'login.succeeded': 'Signed in',
});

/** A readable label for an audit action; unknown actions keep their own last word. */
export function auditActionLabel(action: string): string {
  const known = AUDIT_LABELS[action];
  if (known) return known;
  const seg = action.split('.').pop() ?? action;
  return seg.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The business areas of the audit vocabulary; anything else (sign-ins, settings) is housekeeping. */
export function auditArea(action: string): 'Work' | 'CRM' | 'Team' | null {
  if (action.startsWith('work.')) return 'Work';
  if (action.startsWith('customer.')) return 'CRM';
  if (action.startsWith('invitation.') || action.startsWith('user.')) return 'Team';
  return null;
}

// --- Rows ---------------------------------------------------------------------------------------

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function actorName(item: ActivityItemV1, names: ReadonlyMap<string, string>): string | null {
  if (item.actor.userId) return names.get(item.actor.userId) ?? 'A workspace member';
  if (item.actor.kind === 'SYSTEM') return 'Loop';
  return null;
}

/** One line, from the item's closed vocabulary only. Never a summary, a body or a contact value. */
export function activityStory(item: ActivityItemV1, names: ReadonlyMap<string, string>): string {
  const domain = item.authority.domain;
  let what: string;
  if (domain === 'audit') what = auditActionLabel(item.type);
  else if (domain === 'callgrid') what = `CallGrid ${item.display.title}`;
  else what = capitalize(item.display.title);
  const who = actorName(item, names);
  return who ? `${what} · ${who}` : what;
}

function instantOf(item: ActivityItemV1): string {
  return item.time.occurredAt ?? item.time.recordedAt;
}

const BASIS_WORDS: Readonly<Record<string, string>> = Object.freeze({
  PROVIDER_REPORTED: 'Reported by the source',
  LOOP_CLOCK: 'Loop’s clock when it was recorded',
});

/** The card's rows: the latest `limit` items, each labelled with its truth category by the primitive. */
export function activityEntries(activity: OrgActivity, time: TimeView, limit: number): ActivityEntry[] {
  if (activity.state !== 'READ') return [];
  return activity.items.slice(0, limit).map((item) => {
    const at = instantOf(item);
    return {
      key: item.key,
      category: item.category,
      story: activityStory(item, activity.names),
      when: time.relative(at),
      whenIso: time.iso(at),
      evidence: [
        { label: 'Source', value: capitalize(sourceName(item.authority.domain)) },
        { label: 'When', value: time.dateTime(at) },
        { label: 'How the time is known', value: BASIS_WORDS[item.time.occurredAtBasis] ?? null, unknownText: 'Not stated by the source' },
        ...(item.provenance.limitations.length > 0 ? [{ label: 'Limitations', value: item.provenance.limitations.join('; ') }] : []),
      ],
    } satisfies ActivityEntry;
  });
}

/** The review's WORK changes: the audit adapter's business acts, in the words Home's review already uses. */
export interface AuditUpdate {
  readonly id: string;
  readonly at: Date;
  readonly who: string;
  readonly what: string;
  readonly area: 'Work' | 'CRM' | 'Team';
}

export function auditUpdates(activity: OrgActivity | null): AuditUpdate[] {
  if (!activity || activity.state !== 'READ') return [];
  const out: AuditUpdate[] = [];
  for (const item of activity.items) {
    if (item.authority.domain !== 'audit') continue;
    const area = auditArea(item.type);
    if (!area) continue;
    out.push({
      id: item.authority.recordId,
      at: new Date(instantOf(item)),
      who: actorName(item, activity.names) ?? 'Loop',
      what: auditActionLabel(item.type),
      area,
    });
  }
  return out;
}
