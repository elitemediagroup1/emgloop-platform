// Party form contract -- identity slice P1.
//
// Pure parsing and result shaping for the Party write actions in
// `party-actions.ts`, kept out of the 'use server' module so it can be tested and
// imported by any UI. Nothing here reads a session, an organization or a
// database: the organization and actor always come from the signed session, in
// the action.

import type { PartyWriteResult } from '@emgloop/database';

export interface CreatePartyInput {
  partyType: string;
  displayName: string | null;
}

export interface EstablishPartyInput {
  partyId: string;
  basis: string;
}

/**
 * What a Party write action returns to the UI. It names the outcome and the Party
 * it concerns, and nothing more: the UI re-reads the record through the read
 * model rather than trusting a write's echo.
 */
export type PartyActionResult =
  | { outcome: 'RECORDED' | 'ALREADY_ESTABLISHED'; partyId: string; partyType: 'PERSON' | 'COMPANY'; established: boolean }
  | { outcome: 'NOT_AUTHORIZED' }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'INVALID'; reason: 'NOT_A_PARTY_TYPE' | 'NOT_A_GOVERNED_BASIS' | 'ARCHIVED' | 'MISSING_FIELD' };

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

/** Party type and an optional display name. The type is validated by `PartyService`, not here. */
export function parseCreatePartyForm(formData: FormData): CreatePartyInput {
  const displayName = field(formData, 'displayName');
  return { partyType: field(formData, 'partyType'), displayName: displayName.length > 0 ? displayName : null };
}

/**
 * The Party to establish and the governed basis. There is no default basis:
 * establishing canonical identity is a deliberate act, so a missing basis is refused.
 */
export function parseEstablishPartyForm(formData: FormData): EstablishPartyInput | null {
  const partyId = field(formData, 'partyId');
  const basis = field(formData, 'basis');
  if (!partyId || !basis) return null;
  return { partyId, basis };
}

export function toPartyActionResult(result: PartyWriteResult): PartyActionResult {
  switch (result.outcome) {
    case 'RECORDED':
    case 'ALREADY_ESTABLISHED':
      return {
        outcome: result.outcome,
        partyId: result.party.id,
        partyType: result.party.partyType,
        established: result.party.establishment.established,
      };
    case 'INVALID':
      return { outcome: 'INVALID', reason: result.reason };
    case 'NOT_AUTHORIZED':
      return { outcome: 'NOT_AUTHORIZED' };
    default:
      return { outcome: 'NOT_FOUND' };
  }
}
