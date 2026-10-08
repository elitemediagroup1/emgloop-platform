// "Possible New People": addresses in ONE person's own mail that look like real people they work
// with and are not in the CRM yet (CRM slice 6). Decision record: docs/architecture/crm-people-command-center.md.
//
// A QUEUE, NEVER AN ACT. Nothing here creates, matches, affiliates or dismisses. A candidate becomes a
// Person only when a human adds it, through the Party and Contact Point authorities; until then it is
// a row in one viewer's private queue, derived from that viewer's own mail on every read.
//
// DETERMINISTIC. Every decision is a fixed rule over stored metadata -- counts, labels, the address
// itself -- with the reason recorded. No model, no fuzzy matching, and no Company from a domain.
//
// PURE. No clock, no I/O, no hashing.

import { crmAutomatedAddress } from './crm-outreach';

export const CRM_DISCOVERY_DISMISS_REASONS = ['IGNORE', 'NOT_A_PERSON', 'INTERNAL', 'AUTOMATED', 'NOT_RELEVANT'] as const;
export type CrmDiscoveryDismissReason = (typeof CRM_DISCOVERY_DISMISS_REASONS)[number];

export const CRM_DISCOVERY_DISMISS_LABELS: Readonly<Record<CrmDiscoveryDismissReason, string>> = Object.freeze({
  IGNORE: 'Ignore',
  NOT_A_PERSON: 'Not a person',
  INTERNAL: 'Internal',
  AUTOMATED: 'Automated',
  NOT_RELEVANT: 'Not relevant',
});

export function isCrmDiscoveryDismissReason(value: unknown): value is CrmDiscoveryDismissReason {
  return typeof value === 'string' && (CRM_DISCOVERY_DISMISS_REASONS as readonly string[]).includes(value);
}

/**
 * Public mailbox providers. A colleague who signs in with one of these does not make every address
 * at that provider "internal": only an organization's own domains are.
 */
export const CRM_PUBLIC_MAIL_DOMAINS: readonly string[] = Object.freeze([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'mail.com',
  'zoho.com', 'yandex.com', 'fastmail.com', 'hey.com',
]);

/** Local parts of shared, list and bulk mailboxes: never a person. */
const LIST_OR_ROLE_LOCAL = /^(?:info|hello|hi|team|support|help|sales|contact|admin|billing|accounts?|office|marketing|press|media|partnerships?|careers|jobs|hr|legal|privacy|security|abuse|webmaster|list|lists|listserv|majordomo|owner-[^@]*|[^@]*-request|bounce[^@]*|unsubscribe[^@]*|reply|replies|mail|email|news)$/i;

export interface CrmDiscoveryCorrespondentFacts {
  readonly address: string;
  readonly domain: string | null;
  /** Messages this viewer sent with the address as a direct (To) recipient, not drafts/spam/trash. */
  readonly directSends: number;
  /** Messages from the address that qualify as a human reply. */
  readonly humanInbound: number;
  /** Messages from the address that are automated or uncertain. */
  readonly nonHumanInbound: number;
  readonly suppressed: boolean;
}

export type CrmDiscoveryExclusion =
  | 'OWN_ADDRESS'
  | 'INTERNAL'
  | 'AUTOMATED_SENDER'
  | 'ROLE_OR_LIST_MAILBOX'
  | 'ALREADY_IN_CRM'
  | 'DISMISSED'
  | 'SUPPRESSED'
  | 'NO_DIRECT_EXCHANGE'
  | 'ONLY_AUTOMATED_MAIL';

export type CrmDiscoveryReason = 'YOU_EMAILED_THEM' | 'THEY_REPLIED';

export type CrmDiscoveryDecision =
  | { readonly surfaced: true; readonly reasons: readonly CrmDiscoveryReason[] }
  | { readonly surfaced: false; readonly exclusion: CrmDiscoveryExclusion };

/**
 * Whether an address belongs in the queue, in a fixed order, the first exclusion winning:
 *   OWN_ADDRESS        one of the viewer's own addresses;
 *   INTERNAL           a member of this organization, or an address at one of its own (non-public) domains;
 *   ALREADY_IN_CRM     an exact Contact Point already holds it (a Person, or a Company's role inbox);
 *   DISMISSED          the viewer dismissed it (until they restore it);
 *   SUPPRESSED         the viewer told Mail never to flag this sender;
 *   AUTOMATED_SENDER   a machine's local part (no-reply, notifications, ...);
 *   ROLE_OR_LIST_MAILBOX a shared, list or bulk mailbox's local part (info@, support@, ...-request@);
 *   NO_DIRECT_EXCHANGE the viewer never wrote to the address directly (To): inbound alone -- a pitch,
 *                      a newsletter, a cold email -- is not evidence of someone the viewer works with;
 *   ONLY_AUTOMATED_MAIL everything from them was automated (and they never replied as a person).
 * Surfaced with its reasons: YOU_EMAILED_THEM (always, by the rule above) and THEY_REPLIED when a
 * human reply was observed.
 */
export function decideCrmDiscovery(
  c: CrmDiscoveryCorrespondentFacts,
  context: { readonly ownAddresses: ReadonlySet<string>; readonly memberAddresses: ReadonlySet<string>; readonly internalDomains: ReadonlySet<string>; readonly inCrm: boolean; readonly dismissed: boolean },
): CrmDiscoveryDecision {
  const address = c.address.trim().toLowerCase();
  const domain = (c.domain ?? address.split('@')[1] ?? '').toLowerCase();
  if (context.ownAddresses.has(address)) return { surfaced: false, exclusion: 'OWN_ADDRESS' };
  if (context.memberAddresses.has(address) || (domain && context.internalDomains.has(domain))) return { surfaced: false, exclusion: 'INTERNAL' };
  if (context.inCrm) return { surfaced: false, exclusion: 'ALREADY_IN_CRM' };
  if (context.dismissed) return { surfaced: false, exclusion: 'DISMISSED' };
  if (c.suppressed) return { surfaced: false, exclusion: 'SUPPRESSED' };
  if (crmAutomatedAddress(address)) return { surfaced: false, exclusion: 'AUTOMATED_SENDER' };
  if (LIST_OR_ROLE_LOCAL.test(address.split('@')[0] ?? '')) return { surfaced: false, exclusion: 'ROLE_OR_LIST_MAILBOX' };
  if (c.directSends < 1) return { surfaced: false, exclusion: 'NO_DIRECT_EXCHANGE' };
  if (c.humanInbound === 0 && c.nonHumanInbound > 0) return { surfaced: false, exclusion: 'ONLY_AUTOMATED_MAIL' };
  return { surfaced: true, reasons: c.humanInbound > 0 ? ['YOU_EMAILED_THEM', 'THEY_REPLIED'] : ['YOU_EMAILED_THEM'] };
}

/** An organization's own domains: its members' address domains, minus public mailbox providers. */
export function crmInternalDomains(memberAddresses: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const a of memberAddresses) {
    const d = a.trim().toLowerCase().split('@')[1];
    if (d && !CRM_PUBLIC_MAIL_DOMAINS.includes(d)) out.add(d);
  }
  return out;
}

export const CRM_DISCOVERY_REASON_LABELS: Readonly<Record<CrmDiscoveryReason, string>> = Object.freeze({
  YOU_EMAILED_THEM: 'You emailed them directly',
  THEY_REPLIED: 'They replied as a person',
});

/**
 * The name proposed for a new Person: the display name their own mail carried, when it is a
 * plausible personal name. NEVER derived from the address (no "john.smith@" -> "John Smith"). Null
 * means the person adding them types it.
 */
export function crmDiscoveryProposedName(displayName: string | null | undefined): string | null {
  if (typeof displayName !== 'string') return null;
  const name = displayName.replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 120) return null;
  if (/[@<>]/.test(name)) return null;
  if (/\d{3,}/.test(name)) return null;
  return name;
}
