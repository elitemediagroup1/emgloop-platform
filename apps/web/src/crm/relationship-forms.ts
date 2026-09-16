// Parsing an operator's form into a governed Relationship act. Pure.
//
// THIS FILE DECIDES NOTHING. It reads strings out of a FormData and hands them to
// the service, which validates the vocabulary, resolves every Party through the
// Party Reference contract and authorizes the act. A form parser that "helpfully"
// normalised a kind or defaulted a role would be a second, quieter authority.
//
// An outcome becomes a short code in a redirect, so a server-rendered page can say
// what happened without a client component. The codes are the service's own
// outcomes; none of them is invented here.

export const RELATIONSHIP_OUTCOME_MESSAGES: Record<string, string> = {
  RECORDED: 'Recorded.',
  NOT_AUTHORIZED: 'You do not have authority for that act.',
  NOT_FOUND: 'Not found.',
  DUPLICATE: 'That commercial connection is already recorded and still stands.',
  REASON_REQUIRED: 'A written reason is required, and is kept.',
  ILLEGAL_TRANSITION: 'That is not a move this record can make from where it is.',
  RETRY: 'Somebody else changed this first. Re-read it and try again.',
  INVALID: 'That does not describe a valid commercial connection.',
  PARTY_REFUSED: 'A Party could not be referenced. See the detail below.',
  PARTY_NOT_ESTABLISHED: 'That Party is not established. Establish it first.',
  PARTY_ARCHIVED: 'That Party is archived and takes no new references.',
  PARTY_SUPERSEDED: 'That Party has been superseded. Retry with the canonical id shown.',
  PARTY_NOT_FOUND: 'No such Party in this organization.',
};

export function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The outcome, and for a refused Party the refusal and its canonical id -- so the
 * operator is told which id to retry with and retries DELIBERATELY. Loop never
 * substitutes it for them.
 */
export function outcomeQuery(result: { outcome: string; refusals?: readonly { refusal: string; canonicalPartyId?: string }[] }): string {
  const params = new URLSearchParams({ outcome: result.outcome });
  const refusal = result.refusals?.[0];
  if (refusal) {
    params.set('refusal', refusal.refusal);
    if (refusal.canonicalPartyId) params.set('canonical', refusal.canonicalPartyId);
  }
  return params.toString();
}
