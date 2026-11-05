import { mailEvidenceHash, type ManagedCaptureReading } from './creator-mail-matching';
export interface RelationshipEvidence { captureId: string; generation: string; scopeHash: string; reading: ManagedCaptureReading }
export function relationshipBrandKey(reading: ManagedCaptureReading): string {
  return reading.brandId ?? `candidate:${mailEvidenceHash((reading.candidateBrandName ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, ''))}`;
}
/** Versions include every authorized source, even duplicate copies, to invalidate on withdrawal. */
export function relationshipVersion(items: readonly RelationshipEvidence[]): string {
  return mailEvidenceHash(JSON.stringify(items.map(e => [e.captureId, e.generation, e.scopeHash, e.reading.threadId, e.reading.fingerprint, e.reading.state]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
}
export function relationshipEvents(items: readonly RelationshipEvidence[]): RelationshipEvidence[] {
  const unique = new Map<string, RelationshipEvidence>();
  for (const item of items) {
    const key = item.reading.evidenceKey, previous = unique.get(key);
    if (!previous || item.reading.messageCount > previous.reading.messageCount || item.reading.messageCount === previous.reading.messageCount && item.reading.fingerprint.localeCompare(previous.reading.fingerprint) < 0) unique.set(key, item);
  }
  return [...unique.values()].sort((a,b) => (a.reading.evidenceAt ?? '').localeCompare(b.reading.evidenceAt ?? '') || a.reading.evidenceKey.localeCompare(b.reading.evidenceKey));
}
