// Whether Loop's domain readings are the model's, and the AI ledger behind them -- a read-only diagnostic
// (2026-09-29). The proof that a governed reading went source -> rule -> model -> ledger -> validation ->
// stored digest, from the two records that already hold it and nothing new:
//
//   intelligence_digests  each reading's scope, domain, status, and from its provenance the producer kind
//                         (RULE / RULE_AND_MODEL), the model-stage code (why a model did or did not read it),
//                         the task, and the invocation id of the call that made it;
//   ai_invocations        that call's provider, outcome (ANSWERED, REJECTED_BY_LOOP, FAILED ...), lane,
//                         failure class and rejection codes -- and every other call in the window.
//
// READ-ONLY, ONE ORGANIZATION, CODES AND COUNTS. Construct it with `readOnlyClient(prisma)`. No content, no
// subject reference, no user id, no prompt, no answer is selected; a PRINCIPAL reading is counted with every
// other person's of its domain, never named.

import type { PrismaClient } from '@prisma/client';

/** Rows read per question. More than this and the answer says it is bounded. */
export const READING_STATE_BOUND = 5_000;

export interface ReadingGroup {
  readonly scope: string;
  readonly domain: string;
  readonly status: string;
  /** RULE or RULE_AND_MODEL (null: a producer before the participation contract). */
  readonly producerKind: string | null;
  /** The model-stage code the reading was written with (null: written before stages were recorded, or no model stage). */
  readonly modelStage: string | null;
  readonly taskId: string | null;
  readonly digests: number;
  /** Of those naming an invocation, how many the ledger holds -- and that call's outcome and provider. */
  readonly withInvocation: number;
  readonly linked: number;
  readonly ledgerOutcomes: Readonly<Record<string, number>>;
  readonly providers: Readonly<Record<string, number>>;
  readonly latestGeneratedAt: Date | null;
}

export interface LedgerGroup {
  readonly taskId: string;
  readonly providerId: string;
  readonly outcome: string;
  readonly lane: string | null;
  readonly failureClass: string | null;
  readonly count: number;
}

export interface ReadingState {
  readonly readings: readonly ReadingGroup[];
  readonly ledger: readonly LedgerGroup[];
  /** Rejection codes by task, over the window's REJECTED calls. */
  readonly rejections: readonly { readonly taskId: string; readonly code: string; readonly count: number }[];
  readonly bounded: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export class IntelligenceReadingStateRepository {
  /** Pass `readOnlyClient(prisma)`. */
  constructor(private readonly db: PrismaClient) {}

  async read(organizationId: string, since: Date, now: Date): Promise<ReadingState> {
    let bounded = false;
    const digests = await this.db.intelligenceDigest.findMany({
      where: { organizationId, expiresAt: { gt: now } },
      select: { scope: true, domain: true, status: true, provenance: true, aiInvocationId: true, generatedAt: true },
      orderBy: { generatedAt: 'desc' },
      take: READING_STATE_BOUND + 1,
    });
    if (digests.length > READING_STATE_BOUND) bounded = true;
    const kept = digests.slice(0, READING_STATE_BOUND);

    // The call behind each model-backed reading, from the ledger (scoped to the organization).
    const invocationIds = [...new Set(kept.map((d) => d.aiInvocationId).filter((x): x is string => !!x))];
    const calls = new Map<string, { outcome: string; providerId: string }>();
    for (let i = 0; i < invocationIds.length; i += 1_000) {
      const rows = await this.db.aiInvocation.findMany({ where: { organizationId, invocationId: { in: invocationIds.slice(i, i + 1_000) } }, select: { invocationId: true, outcome: true, providerId: true } });
      for (const r of rows) calls.set(r.invocationId, { outcome: r.outcome, providerId: r.providerId });
    }

    const groups = new Map<string, { scope: string; domain: string; status: string; producerKind: string | null; modelStage: string | null; taskId: string | null; digests: number; withInvocation: number; linked: number; ledgerOutcomes: Record<string, number>; providers: Record<string, number>; latestGeneratedAt: Date | null }>();
    for (const d of kept) {
      const p = (d.provenance && typeof d.provenance === 'object' ? d.provenance : {}) as Record<string, unknown>;
      const g = { scope: d.scope, domain: d.domain, status: d.status, producerKind: str(p.producerKind), modelStage: str(p.modelStage), taskId: str(p.taskId) };
      const key = JSON.stringify(g);
      const row = groups.get(key) ?? { ...g, digests: 0, withInvocation: 0, linked: 0, ledgerOutcomes: {}, providers: {}, latestGeneratedAt: null };
      row.digests += 1;
      if (!row.latestGeneratedAt || d.generatedAt > row.latestGeneratedAt) row.latestGeneratedAt = d.generatedAt;
      if (d.aiInvocationId) {
        row.withInvocation += 1;
        const call = calls.get(d.aiInvocationId);
        if (call) {
          row.linked += 1;
          row.ledgerOutcomes[call.outcome] = (row.ledgerOutcomes[call.outcome] ?? 0) + 1;
          row.providers[call.providerId] = (row.providers[call.providerId] ?? 0) + 1;
        }
      }
      groups.set(key, row);
    }

    // Every call in the window, by task, provider, outcome, lane and failure class; rejection codes apart.
    const ledgerRows = await this.db.aiInvocation.findMany({
      where: { organizationId, requestedAt: { gte: since, lt: now } },
      select: { taskId: true, providerId: true, outcome: true, lane: true, failureClass: true, rejectionCodes: true },
      orderBy: { requestedAt: 'desc' },
      take: READING_STATE_BOUND + 1,
    });
    if (ledgerRows.length > READING_STATE_BOUND) bounded = true;
    const ledger = new Map<string, LedgerGroup & { count: number }>();
    const rejections = new Map<string, { taskId: string; code: string; count: number }>();
    for (const r of ledgerRows.slice(0, READING_STATE_BOUND)) {
      const g = { taskId: r.taskId, providerId: r.providerId, outcome: r.outcome, lane: r.lane ?? null, failureClass: r.failureClass ?? null };
      const key = JSON.stringify(g);
      const row = ledger.get(key) ?? { ...g, count: 0 };
      row.count += 1;
      ledger.set(key, row);
      for (const code of r.rejectionCodes ?? []) {
        const k = `${r.taskId}\n${code}`;
        rejections.set(k, { taskId: r.taskId, code, count: (rejections.get(k)?.count ?? 0) + 1 });
      }
    }

    const byText = (a: string, b: string) => a.localeCompare(b);
    return {
      readings: [...groups.values()].sort((a, b) => byText(a.scope, b.scope) || byText(a.domain, b.domain) || byText(a.status, b.status) || byText(a.modelStage ?? '', b.modelStage ?? '')),
      ledger: [...ledger.values()].sort((a, b) => byText(a.taskId, b.taskId) || byText(a.outcome, b.outcome) || byText(a.providerId, b.providerId)),
      rejections: [...rejections.values()].sort((a, b) => byText(a.taskId, b.taskId) || b.count - a.count || byText(a.code, b.code)),
      bounded,
    };
  }
}
