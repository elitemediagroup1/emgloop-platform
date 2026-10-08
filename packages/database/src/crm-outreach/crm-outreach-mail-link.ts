// Linking ONE viewer's own mail to CRM Parties, exactly (CRM slice 6).
//
// THE ONLY LINK IS EXACT EQUALITY OF A KEYED HASH, INSIDE ONE ORGANIZATION. A correspondent's stored
// address is normalized as a Contact Point value is (`normalizeCrmContactPointValue`), hashed under the
// Contact Point namespace with the organization's key, and compared with the organization's current
// EMAIL Contact Points. No value is read from the CRM to do it; no name, no domain, no similarity, no
// model. An address held by two Parties links to neither (AMBIGUOUS): unknown stays unknown.
//
//   INDIVIDUAL (on a PERSON)              -> the Person's own mail.
//   ROLE_INBOX / UNATTRIBUTED (COMPANY)   -> the Company's mail, NEVER a Person's: a shared inbox is
//                                            not a person, and is never made into one.
//
// THE KEY MUST MATCH. Contact Points record the fingerprint of the key their hash was taken under. A
// runtime holding a different key would silently link nothing, so a mismatch is reported, not hidden.

import {
  normalizeCrmContactPointValue,
  qualifyCrmMessage,
  type CrmMessageQualification,
} from '@emgloop/shared';

import { crmContactPointValueHash } from '../repositories/crm-contact-point.repository';
import { identifierKeyFingerprint } from '../repositories/cognitive/hashing';
import type { OutreachCorrespondent, OutreachEvent, OutreachMessage } from '../repositories/work-state/work-outreach.repository';

export interface ContactPointIndexRow {
  readonly partyId: string;
  readonly partyType: string;
  readonly kind: string;
  readonly classification: string;
  readonly valueHash: string;
  readonly hashKeyFingerprint: string;
}

export type CorrespondentLink =
  | { readonly kind: 'PERSON'; readonly partyId: string }
  | { readonly kind: 'COMPANY'; readonly partyId: string }
  | { readonly kind: 'AMBIGUOUS' };

export interface MailLinks {
  /** Correspondent address hash (the viewer's own) -> what it links to. Unlinked addresses are absent. */
  readonly byCorrespondent: ReadonlyMap<string, CorrespondentLink>;
  /** Party id -> the viewer's correspondent hashes that link to it. */
  readonly hashesByParty: ReadonlyMap<string, readonly string[]>;
  /** Contact Points hashed under a key this runtime does not hold: they can never link here. */
  readonly keyMismatchedPoints: number;
}

export function linkCorrespondents(
  organizationId: string,
  correspondents: readonly Pick<OutreachCorrespondent, 'addressHash' | 'displayAddress'>[],
  index: readonly ContactPointIndexRow[],
  keyFingerprint: string = identifierKeyFingerprint(),
): MailLinks {
  const byHash = new Map<string, ContactPointIndexRow[]>();
  let keyMismatchedPoints = 0;
  for (const row of index) {
    if (row.kind !== 'EMAIL') continue;
    if (row.hashKeyFingerprint !== keyFingerprint) {
      keyMismatchedPoints += 1;
      continue;
    }
    const list = byHash.get(row.valueHash) ?? [];
    list.push(row);
    byHash.set(row.valueHash, list);
  }
  const byCorrespondent = new Map<string, CorrespondentLink>();
  const hashesByParty = new Map<string, string[]>();
  for (const c of correspondents) {
    const n = normalizeCrmContactPointValue('EMAIL', c.displayAddress);
    if (!n.ok) continue;
    const holders = byHash.get(crmContactPointValueHash(organizationId, 'EMAIL', n.value));
    if (!holders || holders.length === 0) continue;
    const parties = [...new Set(holders.map((h) => h.partyId))];
    if (parties.length !== 1) {
      byCorrespondent.set(c.addressHash, { kind: 'AMBIGUOUS' });
      continue;
    }
    const holder = holders[0]!;
    const link: CorrespondentLink =
      holder.classification === 'INDIVIDUAL' && holder.partyType === 'PERSON'
        ? { kind: 'PERSON', partyId: holder.partyId }
        : holder.partyType === 'COMPANY'
          ? { kind: 'COMPANY', partyId: holder.partyId }
          : { kind: 'AMBIGUOUS' };
    byCorrespondent.set(c.addressHash, link);
    if (link.kind !== 'AMBIGUOUS') {
      const list = hashesByParty.get(link.partyId) ?? [];
      list.push(c.addressHash);
      hashesByParty.set(link.partyId, list);
    }
  }
  return { byCorrespondent, hashesByParty, keyMismatchedPoints };
}

export interface QualifiedMessage {
  readonly message: OutreachMessage;
  readonly qualification: CrmMessageQualification;
}

export interface PartyMailEvidence {
  readonly sends: Date[];
  readonly humanReplies: Date[];
  readonly automated: Date[];
  readonly uncertain: Date[];
  readonly messages: QualifiedMessage[];
}

/**
 * Qualify each of the viewer's messages for each Party whose addresses it touches. A message the
 * viewer sent counts for a Party only when one of the Party's addresses is a direct (To) recipient;
 * a message that arrived counts only when it came FROM one of the Party's addresses.
 */
export function qualifyPartyMail(
  hashesByParty: ReadonlyMap<string, readonly string[]>,
  messages: readonly OutreachMessage[],
  addressOf: ReadonlyMap<string, string>,
): Map<string, PartyMailEvidence> {
  const partyOfHash = new Map<string, string>();
  for (const [partyId, hashes] of hashesByParty) for (const h of hashes) partyOfHash.set(h, partyId);
  const out = new Map<string, PartyMailEvidence>();
  const evidence = (partyId: string) => {
    let e = out.get(partyId);
    if (!e) out.set(partyId, (e = { sends: [], humanReplies: [], automated: [], uncertain: [], messages: [] }));
    return e;
  };
  for (const m of messages) {
    if (m.direction === 'OUTBOUND') {
      const touched = new Set<string>();
      for (const h of [...m.toHashes, ...m.ccHashes]) {
        const p = partyOfHash.get(h);
        if (p) touched.add(p);
      }
      for (const partyId of touched) {
        const personInTo = m.toHashes.some((h) => partyOfHash.get(h) === partyId);
        const q = qualifyCrmMessage({ direction: 'OUTBOUND', labels: m.labels, subject: m.subject, personInTo });
        const e = evidence(partyId);
        e.messages.push({ message: m, qualification: q });
        if (q === 'QUALIFYING_SEND') e.sends.push(m.internalDate);
      }
    } else if (m.direction === 'INBOUND' && m.fromHash) {
      const partyId = partyOfHash.get(m.fromHash);
      if (!partyId) continue;
      const q = qualifyCrmMessage({ direction: 'INBOUND', labels: m.labels, subject: m.subject, automationClass: m.automationClass as 'AUTO_SUBMITTED' | 'MAILING_LIST' | 'BULK' | null, senderAddress: addressOf.get(m.fromHash) ?? null });
      const e = evidence(partyId);
      e.messages.push({ message: m, qualification: q });
      if (q === 'HUMAN_REPLY') e.humanReplies.push(m.internalDate);
      else if (q === 'AUTOMATED') e.automated.push(m.internalDate);
      else if (q === 'UNCERTAIN') e.uncertain.push(m.internalDate);
    }
  }
  return out;
}

/** When an event happens: its start instant, or (all-day) the start of its date in UTC. */
export function eventStart(e: Pick<OutreachEvent, 'startsAt' | 'startDate'>): Date | null {
  return e.startsAt ?? e.startDate ?? null;
}

/** The viewer's meetings with each Party: events listing one of the Party's addresses, not cancelled. */
export function partyMeetings(hashesByParty: ReadonlyMap<string, readonly string[]>, events: readonly OutreachEvent[]): Map<string, OutreachEvent[]> {
  const out = new Map<string, OutreachEvent[]>();
  for (const [partyId, hashes] of hashesByParty) {
    const set = new Set(hashes);
    const mine = events.filter((e) => e.status !== 'CANCELLED' && e.attendeeHashes.some((h) => set.has(h)));
    if (mine.length > 0) out.set(partyId, mine);
  }
  return out;
}
