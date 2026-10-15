export interface SynthesisPerson {
  readonly organizationId: string;
  readonly userId: string;
  readonly timeZone: string;
  readonly hasBriefing: boolean;
}

/** Missing daily briefs first; otherwise a stable rotation, so a reused brief cannot starve others. */
export function synthesisRecipient<T extends SynthesisPerson>(
  people: readonly T[],
  phase: string,
  nowMs: number,
  slot: number,
): T | null {
  if (!Number.isInteger(slot) || slot < 0 || !people.length) return null;
  const missing = phase === 'briefing' ? people.filter((p) => !p.hasBriefing) : [];
  if (missing.length) return missing[slot % missing.length]!;
  const ordered = [...people].sort((a, b) =>
    `${a.organizationId}:${a.userId}`.localeCompare(`${b.organizationId}:${b.userId}`),
  );
  return ordered[(Math.floor(nowMs / (15 * 60000)) + slot) % ordered.length]!;
}
