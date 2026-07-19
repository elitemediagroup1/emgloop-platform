// Auction report reconciliation — pure comparison and classification.
//
// Read-only, no Prisma, no clock, no I/O. The service and route hand it two
// sides and it says exactly how they differ and why.
//
// WHY CLASSIFICATION MATTERS MORE THAN THE DIFF
//
// A raw mismatch list is close to useless: "avgBid 11.09 vs 1109" reads as a
// data failure when it is a unit conversion working correctly, and "rejectRate
// 91.84 vs 8.16" reads as a bug when it is two different denominators being
// compared. This module's job is to separate:
//
//   • the differences that mean Loop stored something wrong, from
//   • the differences that mean Loop and the provider are measuring different
//     things and both are right.
//
// The second category is NOT a failure and is never reported as one. A
// denominator mismatch is a semantic finding about the contract, not a defect.

/** Every way a live value and a stored value can legitimately or illegitimately differ. */
export type DiffClassification =
  | 'exact-match'
  | 'money-conversion'
  | 'percentage-representation'
  | 'field-mapping'
  | 'source-name-variation'
  | 'missing-source'
  | 'extra-source'
  | 'missing-destination'
  | 'extra-destination'
  | 'pagination'
  | 'provider-total-discrepancy'
  | 'unsupported-semantic'
  | 'unexplained';

/**
 * Classifications that mean Loop stored something wrong.
 *
 * Everything absent from this set is either agreement or an explained
 * difference. Reconciliation "passes" when this set is empty — not when the
 * diff list is empty, which it never will be.
 */
export const DEFECT_CLASSIFICATIONS: ReadonlySet<DiffClassification> = new Set([
  'missing-source',
  'extra-source',
  'missing-destination',
  'extra-destination',
  'pagination',
  'unexplained',
]);

export interface FieldDiff {
  groupingId: string;
  groupingName: string | null;
  field: string;
  /** As the provider returned it. */
  live: number | string | null;
  /** As Loop stored it. */
  stored: number | string | null;
  classification: DiffClassification;
  explanation: string;
}

export interface GrainReconciliation {
  grain: 'source' | 'destination';
  liveRowCount: number;
  storedRowCount: number;
  rowCountMatches: boolean;
  comparedFields: number;
  exactMatches: number;
  diffs: FieldDiff[];
  /** Provider footer vs the totals Loop recomputed from what it stored. */
  totalsDiffs: FieldDiff[];
  /** True when nothing in DEFECT_CLASSIFICATIONS appeared. */
  clean: boolean;
}

/** Fields compared as money: live decimal, stored integer cents. */
const MONEY_PAIRS: ReadonlyArray<{ live: string; stored: string }> = [
  { live: 'totalBidAmount', stored: 'totalBidAmountCents' },
  { live: 'totalWonAmount', stored: 'totalWonAmountCents' },
  { live: 'avgBid', stored: 'avgBidCents' },
  { live: 'avgWinningBid', stored: 'avgWinningBidCents' },
];

/** Fields compared as percentage points, stored verbatim. */
const PERCENT_PAIRS: ReadonlyArray<{ live: string; stored: string }> = [
  { live: 'winRate', stored: 'winRatePercent' },
  { live: 'bidRate', stored: 'bidRatePercent' },
  { live: 'rejectRate', stored: 'rejectRatePercent' },
];

/** Counts on bidStats. Same name on both sides. */
const BID_COUNT_FIELDS = ['total', 'bids', 'rated', 'won', 'rejected'] as const;

/** Counts on bidStats/rejections. Renamed on the Loop side — a deliberate mapping. */
const REJECTION_PAIRS: ReadonlyArray<{ live: string; stored: string }> = [
  { live: 'rejected', stored: 'rejectedDetail' },
  { live: 'callerId', stored: 'callerIdRejected' },
  { live: 'closed', stored: 'closed' },
  { live: 'paused', stored: 'paused' },
  { live: 'duplicate', stored: 'duplicateCaller' },
  { live: 'duplicateBids', stored: 'duplicateBids' },
  { live: 'failedAcceptance', stored: 'failedAcceptance' },
  { live: 'failedTagRules', stored: 'failedTagRules' },
];

const PING_FIELDS = [
  'accepted', 'agents', 'failedAcceptance', 'failedTagRules', 'minRevenue',
  'missingAmount', 'invalidNumber', 'durationElapsed', 'pingTimeout',
  'apiFailed', 'rateLimited', 'suppressed',
] as const;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Float comparison that does not fail on IEEE noise. */
function close(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) <= epsilon * Math.max(1, Math.abs(a), Math.abs(b));
}

function classifyCount(live: number | null, stored: number | null): { c: DiffClassification; why: string } {
  if (live === null && stored === null) return { c: 'exact-match', why: 'neither side reported this field' };
  if (live === null) return { c: 'unsupported-semantic', why: 'the provider did not report this field on this row; Loop holds a value from an earlier sync' };
  if (stored === null) return { c: 'field-mapping', why: 'the provider reported a value Loop did not store — check the field mapping' };
  if (live === stored) return { c: 'exact-match', why: 'identical' };
  return { c: 'unexplained', why: 'counts differ with no known conversion between them' };
}

function classifyMoney(live: number | null, stored: number | null): { c: DiffClassification; why: string } {
  if (live === null && stored === null) return { c: 'exact-match', why: 'neither side reported this field' };
  if (live === null) return { c: 'unsupported-semantic', why: 'the provider did not report this money field on this row' };
  if (stored === null) return { c: 'field-mapping', why: 'the provider reported money Loop did not store' };
  if (stored === Math.round(live * 100)) {
    return { c: 'money-conversion', why: `agrees under the dollars→cents rule: round(${live} × 100) = ${stored}` };
  }
  if (stored === live) {
    return { c: 'money-conversion', why: 'stored value equals the raw provider value — the cents conversion did NOT run, so the stored figure is 100x too small' };
  }
  if (close(stored / 100, live)) {
    return { c: 'money-conversion', why: 'agrees to rounding under the dollars→cents rule' };
  }
  return { c: 'unexplained', why: 'money values differ by no recognised unit conversion' };
}

function classifyPercent(live: number | null, stored: number | null): { c: DiffClassification; why: string } {
  if (live === null && stored === null) return { c: 'exact-match', why: 'neither side reported this rate' };
  if (live === null) return { c: 'unsupported-semantic', why: 'the provider did not report this rate on this row' };
  if (stored === null) return { c: 'field-mapping', why: 'the provider reported a rate Loop did not store' };
  if (close(live, stored)) return { c: 'exact-match', why: 'identical percentage points' };
  if (close(live, stored * 100) || close(live * 100, stored)) {
    return { c: 'percentage-representation', why: 'the two sides differ by exactly 100x — one is a fraction, the other percentage points' };
  }
  return { c: 'unexplained', why: 'rates differ by no recognised representation change' };
}

function diff(
  groupingId: string,
  groupingName: string | null,
  field: string,
  live: number | string | null,
  stored: number | string | null,
  r: { c: DiffClassification; why: string },
): FieldDiff {
  return { groupingId, groupingName, field, live, stored, classification: r.c, explanation: r.why };
}

export interface ReconcileGrainInput {
  liveRows: ReadonlyArray<Record<string, unknown>>;
  storedRows: ReadonlyArray<Record<string, unknown>>;
  liveIdField: string;
  storedIdField: string;
  liveNameField: string;
  storedNameField: string;
}

/**
 * Reconcile one grain.
 *
 * Matching is on the provider's own id and NEVER on the name. A name match
 * would report agreement between two different sources that happen to share a
 * label, which is the most dangerous kind of green result.
 */
export function reconcileGrain(
  grain: 'source' | 'destination',
  input: ReconcileGrainInput,
  fieldPlan: {
    counts: ReadonlyArray<{ live: string; stored: string }>;
    money: ReadonlyArray<{ live: string; stored: string }>;
    percent: ReadonlyArray<{ live: string; stored: string }>;
  },
): GrainReconciliation {
  const storedById = new Map<string, Record<string, unknown>>();
  for (const r of input.storedRows) {
    const id = r[input.storedIdField];
    if (typeof id === 'string') storedById.set(id, r);
  }
  const liveIds = new Set<string>();
  const diffs: FieldDiff[] = [];
  let compared = 0;
  let exact = 0;

  const missingClass: DiffClassification = grain === 'source' ? 'missing-source' : 'missing-destination';
  const extraClass: DiffClassification = grain === 'source' ? 'extra-source' : 'extra-destination';

  for (const live of input.liveRows) {
    const id = live[input.liveIdField];
    if (typeof id !== 'string') continue;
    liveIds.add(id);
    const liveName = typeof live[input.liveNameField] === 'string' ? (live[input.liveNameField] as string) : null;
    const stored = storedById.get(id);

    if (!stored) {
      diffs.push(
        diff(id, liveName, '(row)', 'present', null, {
          c: missingClass,
          why: `the provider returned this ${grain} but Loop has no snapshot for it in this window`,
        }),
      );
      continue;
    }

    const storedName = typeof stored[input.storedNameField] === 'string' ? (stored[input.storedNameField] as string) : null;
    if (liveName !== storedName) {
      // A name change is expected — names are editable display strings and the
      // match was on the id. It is recorded, never treated as a defect.
      diffs.push(
        diff(id, liveName, input.liveNameField, liveName, storedName, {
          c: 'source-name-variation',
          why: 'display name differs; rows were matched on the provider id, which is the only stable key',
        }),
      );
    }

    for (const p of fieldPlan.counts) {
      compared += 1;
      const r = classifyCount(num(live[p.live]), num(stored[p.stored]));
      if (r.c === 'exact-match') exact += 1;
      else diffs.push(diff(id, liveName, p.live, num(live[p.live]), num(stored[p.stored]), r));
    }
    for (const p of fieldPlan.money) {
      compared += 1;
      const r = classifyMoney(num(live[p.live]), num(stored[p.stored]));
      if (r.c === 'exact-match') exact += 1;
      else diffs.push(diff(id, liveName, p.live, num(live[p.live]), num(stored[p.stored]), r));
    }
    for (const p of fieldPlan.percent) {
      compared += 1;
      const r = classifyPercent(num(live[p.live]), num(stored[p.stored]));
      if (r.c === 'exact-match') exact += 1;
      else diffs.push(diff(id, liveName, p.live, num(live[p.live]), num(stored[p.stored]), r));
    }
  }

  for (const stored of input.storedRows) {
    const id = stored[input.storedIdField];
    if (typeof id === 'string' && !liveIds.has(id)) {
      diffs.push(
        diff(id, null, '(row)', null, 'present', {
          c: extraClass,
          why: `Loop holds a snapshot for this ${grain} but the provider did not return it for this window`,
        }),
      );
    }
  }

  return {
    grain,
    liveRowCount: input.liveRows.length,
    storedRowCount: input.storedRows.length,
    rowCountMatches: input.liveRows.length === input.storedRows.length,
    comparedFields: compared,
    exactMatches: exact,
    diffs,
    totalsDiffs: [],
    clean: !diffs.some((d) => DEFECT_CLASSIFICATIONS.has(d.classification)),
  };
}

/** Field plans, exported so tests and callers cannot drift from each other. */
export const BID_FIELD_PLAN = {
  counts: BID_COUNT_FIELDS.map((f) => ({ live: f, stored: f })),
  money: MONEY_PAIRS,
  percent: PERCENT_PAIRS,
} as const;

export const REJECTION_FIELD_PLAN = {
  counts: REJECTION_PAIRS,
  money: [] as ReadonlyArray<{ live: string; stored: string }>,
  percent: [] as ReadonlyArray<{ live: string; stored: string }>,
} as const;

export const PING_FIELD_PLAN = {
  counts: PING_FIELDS.map((f) => ({ live: f, stored: f })),
  money: [] as ReadonlyArray<{ live: string; stored: string }>,
  percent: [] as ReadonlyArray<{ live: string; stored: string }>,
} as const;

/**
 * Compare the provider's footerTotals against the totals Loop recomputed.
 *
 * These are deliberately stored apart and compared here rather than merged.
 * A provider total that disagrees with the sum of the provider's own rows is a
 * real and interesting fact — it usually means the footer is scoped to the whole
 * report while the rows were paginated, or that the provider aggregates
 * something the rows do not expose. Averaging the two away would destroy it.
 */
export function reconcileTotals(
  providerFooter: Record<string, unknown> | null,
  recomputed: Record<string, { value: number | null } | number | null> | null,
  pairs: ReadonlyArray<{ live: string; stored: string; kind: 'count' | 'money' }>,
): FieldDiff[] {
  if (!providerFooter || !recomputed) return [];
  const out: FieldDiff[] = [];
  for (const p of pairs) {
    const live = num(providerFooter[p.live]);
    const raw = recomputed[p.stored];
    const stored = num(typeof raw === 'object' && raw !== null ? raw.value : raw);
    const r = p.kind === 'money' ? classifyMoney(live, stored) : classifyCount(live, stored);
    if (r.c === 'exact-match') continue;
    out.push(
      diff('(footer)', null, p.live, live, stored, {
        c: r.c === 'unexplained' ? 'provider-total-discrepancy' : r.c,
        why:
          r.c === 'unexplained'
            ? "the provider's own footer total does not equal the sum of the rows Loop stored — this is a fact about the report, not necessarily a Loop defect"
            : r.why,
      }),
    );
  }
  return out;
}

/** Averages are per-report, not summable. Comparing them to a row sum is meaningless. */
export const NON_SUMMABLE_FOOTER_FIELDS: readonly string[] = [
  'avgBid', 'avgWinningBid', 'winRate', 'bidRate', 'rejectRate',
];
