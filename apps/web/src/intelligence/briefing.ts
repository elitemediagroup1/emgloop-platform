// The stored Loop Briefing for a signed-in person. SERVER ONLY. Loop Intelligence Phase G, 2026-09-26.
//
// Home READS today's Briefing from the person's own work_briefs (composed in the background by the Loop
// Briefing, as the person, for the person); it never composes one during a render. The principal comes from
// the signed session. A Briefing that is not Loop's (a DL brief, another schema) is not shown as one.

import 'server-only';

import { BRIEFING_RECORD_SCHEMA, WorkBriefRepository, absentUntilMigrated, prisma } from '@emgloop/database';
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
}

const KINDS: readonly string[] = ['NEEDS_YOU', 'CHANGED', 'WATCH', 'AHEAD'];

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
  const row = await absentUntilMigrated(new WorkBriefRepository(prisma).forDate(principal, localDate));
  return storedBriefingOf(row ?? null);
}
