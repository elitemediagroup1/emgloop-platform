// The stored Loop Briefing for a signed-in person. SERVER ONLY. Loop Intelligence Phase G, 2026-09-26.
//
// Home READS today's Briefing from the person's own work_briefs (composed in the background by the Loop
// Briefing, as the person, for the person); it never composes one during a render. The principal comes from
// the signed session. A Briefing that is not Loop's (a DL brief, another schema) is not shown as one.

import 'server-only';

import { BriefingComposer, BRIEFING_MAX_AGE_MS, briefingFingerprint, ruleBriefing, BRIEFING_RECORD_SCHEMA, WorkBriefRepository, absentUntilMigrated, prisma, type BriefingArtifact, type BriefingGap } from '@emgloop/database';
import { zonedCalendarDay, type BriefingLineKind } from '@emgloop/shared';

export interface StoredBriefingLine {
  readonly kind: BriefingLineKind;
  readonly statement: string;
  /** The Loop parts the line's citations come from (domains, or SITUATION). */
  readonly parts: readonly string[];
}

export interface StoredBriefing {
  readonly headline: string;
  readonly lines: readonly StoredBriefingLine[];
  readonly composer: 'MODEL' | 'RULE';
  readonly limitations: readonly string[];
  readonly generatedAt: Date;
  readonly refreshPending?: boolean;
  /** Historical AI analysis, separately labelled; never substituted for current facts. */
  readonly asOfSummary?: StoredBriefing;
}

const KINDS: readonly string[] = ['NEEDS_YOU', 'CHANGED', 'WATCH', 'AHEAD'];

type BriefingRow = { headline: string | null; items: unknown; coverage: unknown; generatedAt: Date; localDate?: Date };

/** A short historical view, only while every citation it displays remains in the authorized gather. */
function recentModelOf(row: BriefingRow | null, localDay: string, artifacts: readonly BriefingArtifact[], now: Date, historicalRefs?: readonly string[]): StoredBriefing | undefined {
  const model = storedBriefingOf(row);
  if (!model || model.composer !== 'MODEL' || row?.localDate?.toISOString().slice(0, 10) !== localDay) return undefined;
  const age = now.getTime() - model.generatedAt.getTime();
  if (age < 0 || age >= 2 * BRIEFING_MAX_AGE_MS) return undefined;
  const refs = new Set(historicalRefs ?? artifacts.map((a) => a.ref));
  const items = Array.isArray(row.items) ? row.items : [];
  const allowed = (value: unknown) => {
    const citations = (value as { citations?: unknown } | null)?.citations;
    return Array.isArray(citations) && citations.length > 0 && citations.every((c) => typeof c === 'string' && refs.has(c));
  };
  // Validation does not establish line-by-line information flow. If ANY original context has
  // disappeared, hide the whole historical answer, including its headline and limitations.
  const originalRefs = Object.keys((row.coverage as { refs?: Record<string, unknown> }).refs ?? {});
  if (!originalRefs.length || !originalRefs.every((r) => refs.has(r)) || !items.length || !items.every(allowed)) return undefined;
  return model;
}

/** No model calls or writes: current facts and timestamped earlier analysis remain distinct. */
export function currentBriefingOf(row: BriefingRow | null, localDay: string, artifacts: readonly BriefingArtifact[], gaps: readonly BriefingGap[], now: Date, previousModel: BriefingRow | null = null, historicalRefs?: readonly string[]): StoredBriefing | null {
  const stored = storedBriefingOf(row);
  const fingerprint = (row?.coverage as { fingerprint?: unknown } | null)?.fingerprint;
  if (stored && fingerprint === briefingFingerprint(localDay, artifacts, gaps) && now.getTime() >= stored.generatedAt.getTime() && now.getTime() - stored.generatedAt.getTime() < BRIEFING_MAX_AGE_MS) return stored.composer === 'MODEL' ? stored : { ...stored, asOfSummary: recentModelOf(previousModel, localDay, artifacts, now, historicalRefs) };
  if (!artifacts.length && !gaps.length) return null;
  const rule = ruleBriefing(artifacts, gaps);
  const domains = new Map(artifacts.map((a) => [a.ref, a.domain]));
  return {
    ...rule,
    lines: rule.lines.map((l) => ({ kind: l.kind, statement: l.statement, parts: [...new Set(l.citations.map((c) => domains.get(c)).filter((d): d is string => !!d))] })),
    composer: 'RULE',
    asOfSummary: recentModelOf(stored?.composer === 'MODEL' ? row : previousModel, localDay, artifacts, now, historicalRefs),
    refreshPending: true,
    generatedAt: now,
    limitations: ['The AI briefing is awaiting a current reading. These are recorded facts, not an AI-composed summary.', ...rule.limitations],
  };
}

export function storedBriefingOf(row: { headline: string | null; items: unknown; coverage: unknown; generatedAt: Date } | null): StoredBriefing | null {
  if (!row || !row.headline) return null;
  const coverage = (row.coverage ?? {}) as { schema?: unknown; composer?: unknown; limitations?: unknown; refs?: unknown };
  if (coverage.schema !== BRIEFING_RECORD_SCHEMA) return null;
  const refs = (coverage.refs && typeof coverage.refs === 'object' ? coverage.refs : {}) as Record<string, unknown>;
  const lines = (Array.isArray(row.items) ? row.items : []).flatMap((l): StoredBriefingLine[] => {
    const line = l as { kind?: unknown; statement?: unknown; citations?: unknown };
    if (typeof line.statement !== 'string' || !KINDS.includes(String(line.kind))) return [];
    const cites = Array.isArray(line.citations) ? line.citations.filter((c): c is string => typeof c === 'string') : [];
    return [{ kind: line.kind as BriefingLineKind, statement: line.statement, parts: [...new Set(cites.map((c) => String(refs[c] ?? '')).filter(Boolean))] }];
  });
  return {
    headline: row.headline,
    lines,
    composer: coverage.composer === 'MODEL' ? 'MODEL' : 'RULE',
    limitations: Array.isArray(coverage.limitations) ? coverage.limitations.filter((l): l is string => typeof l === 'string') : [],
    generatedAt: row.generatedAt,
  };
}

/** Today's stored Briefing for this person, in their own zone, or null. */
export async function loadStoredBriefing(principal: { readonly organizationId: string; readonly userId: string }, timeZone: string, now: Date): Promise<StoredBriefing | null> {
  const localDate = new Date(`${zonedCalendarDay(now, timeZone)}T00:00:00.000Z`);
  const row = await absentUntilMigrated(new WorkBriefRepository(prisma).forDate(principal, localDate, { schema: BRIEFING_RECORD_SCHEMA }));
  const composer = new BriefingComposer({ prisma, runtime: null, modelEnabled: () => false, now: () => now });
  const { artifacts, gaps, historicalRefs } = await composer.gather(principal, now);
  const previousModel = (row?.coverage as { composer?: unknown } | null)?.composer === 'MODEL' ? null :
    await absentUntilMigrated(new WorkBriefRepository(prisma).forDate(principal, localDate, { schema: BRIEFING_RECORD_SCHEMA, composer: 'MODEL' }));
  return currentBriefingOf(row ?? null, zonedCalendarDay(now, timeZone), artifacts, gaps, now, previousModel ?? null, historicalRefs);
}
