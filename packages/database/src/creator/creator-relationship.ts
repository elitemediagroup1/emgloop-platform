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

/** Minimized hashes of the complete authorization/evidence basis, not private email content. */
export function relationshipBasis(items: readonly RelationshipEvidence[]) {
  const version = (e: RelationshipEvidence) => relationshipVersion([e]);
  return { sourceVersions: items.map(version).sort(), eventVersions: relationshipEvents(items).map(version) };
}
/** Reuse a completed fold only for a strictly append-only chronological extension.
 * Changed messages, removed sources, reassignment, or older backfill require rebuilding.
 */
export function relationshipContinuation(record: { fingerprint: string; processed: number; history: unknown }, items: readonly RelationshipEvidence[]): number {
  if (!Array.isArray(record.history)) return 0;
  const latest = record.history.at(-1);
  if (!latest || latest.fingerprint !== record.fingerprint || !Array.isArray(latest.sourceVersions) || !latest.sourceVersions.length || !Array.isArray(latest.eventVersions) || latest.eventVersions.length !== record.processed) return 0;
  const basis = relationshipBasis(items), sources = new Set(basis.sourceVersions);
  if (record.processed >= basis.eventVersions.length || !latest.sourceVersions.every((v: unknown) => typeof v === 'string' && sources.has(v))) return 0;
  return latest.eventVersions.every((v: unknown, i: number) => v === basis.eventVersions[i]) ? record.processed : 0;
}
