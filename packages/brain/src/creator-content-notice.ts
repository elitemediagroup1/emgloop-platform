// @emgloop/brain — "What Loop noticed" on one piece of creator content (Creator Hub).
//
// THE LADDER. The panel shows a creator what Loop knows about a Content record as rungs on an
// epistemic ladder, each labelled with how far it may be trusted:
//   FACT            sourced: read from the file, reported by a platform, or seeded demo data.
//                   Every fact names its source. The panel never shows a bare number.
//   OBSERVATION     derived by Loop from facts by arithmetic alone (a delta, a median, a ratio).
//                   Exact, and only ever against the creator's OWN history.
//   INTERPRETATION  inferred from evidence. Carries the sample it rests on and the standing
//                   'proposed' -- never 'verified' -- and is emitted only once the evidence clears
//                   the thresholds below (5 other pieces, a departure of 1.3x or more / 0.7x or less).
//   PROPOSED        a recommendation resting on a NAMED interpretation. Loop never applies it.
//   NOT_YET         a withheld rung: the question Loop cannot answer yet, and exactly what it would
//                   need. It is a first-class answer, not a gap in one: a creator who is told "not
//                   yet, and here is why" can trust every rung above it, whereas a manufactured
//                   conclusion poisons all of them. No scores, no grades, no forecasts.
//
// PURE. No I/O, no clock, no randomness: `now` arrives in the input, and the caller supplies only
// this creator's rows. The caller is the tenancy boundary; nothing here checks it. Comparisons are
// like-for-like by window length: each piece's earliest window of that length is its first window.

import { EVIDENCE_SOURCE_LABELS, SOCIAL_PLATFORM_LABELS, formatSeconds } from '@emgloop/shared';

export interface NoticeVersionFacts {
  versionId: string;
  label: string;
  number: number;
  kind: 'ORIGINAL' | 'EDIT';
  /** Duration and dimensions are what the uploader's browser read from the file; size is what storage holds. */
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  byteSize: number | null;
  readyAt: string | null;
  /** The raw bag the browser reported. Kept for the record; only the typed fields above are read. */
  clientFacts?: Record<string, unknown>;
}

export interface NoticePerformanceRow {
  contentId: string | null;
  platform: string;
  windowStart: string;
  windowEnd: string;
  metrics: Record<string, number>;
  source: 'PLATFORM' | 'SEEDED_DEMO' | string;
  observedAt?: string;
}

export interface NoticeInput {
  contentId: string;
  kind: 'VIDEO' | 'PHOTO';
  state: string;
  versions: NoticeVersionFacts[];
  published: { platform: string; at: string }[];
  /** Rows for THIS content and for the creator's other content. Never another creator's. */
  performance: NoticePerformanceRow[];
  /** ISO instant, passed in. The Brain has no clock. */
  now: string;
}

export type NoticeRung = {
  rung: 'FACT' | 'OBSERVATION' | 'INTERPRETATION' | 'PROPOSED' | 'NOT_YET';
  text: string;
  source: string;
  observedAt?: string | null;
  sample?: number | null;
  standing?: 'proposed' | null;
  restsOn?: string | null;
  limitations?: string[];
};

export interface ContentNotice {
  rungs: NoticeRung[];
  seeded: boolean;
}

const INTERPRET_MIN_SAMPLE = 5;
const COMPARE_MIN_SAMPLE = 3;
const ABOVE = 1.3;
const BELOW = 0.7;

const fact = (text: string, source: string, observedAt: string | null): NoticeRung => ({ rung: 'FACT', text, source, observedAt });
const observation = (text: string, source: string, observedAt: string | null, sample?: number): NoticeRung =>
  sample === undefined ? { rung: 'OBSERVATION', text, source, observedAt } : { rung: 'OBSERVATION', text, source, observedAt, sample };
const notYet = (text: string, source: string): NoticeRung => ({ rung: 'NOT_YET', text, source });

const whole = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const size = (bytes: number): string => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : bytes >= 1000 ? `${Math.round(bytes / 1000)} KB` : `${bytes} B`);
const span = (seconds: number): string => (seconds < 60 ? `${seconds} s` : formatSeconds(seconds));
const platformName = (platform: string): string => (SOCIAL_PLATFORM_LABELS as Record<string, string>)[platform] ?? platform;
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Orientation with the reduced aspect ratio when it is a familiar one (9:16, 16:9, 4:5, 1:1). */
function aspect(width: number, height: number): string {
  const shape = width === height ? 'Square' : height > width ? 'Vertical' : 'Horizontal';
  const g = gcd(width, height);
  const [a, b] = [width / g, height / g];
  return a <= 32 && b <= 32 ? `${shape} (${a}:${b})` : shape;
}

function sourceOf(row: NoticePerformanceRow): string {
  if (row.source === 'SEEDED_DEMO') return EVIDENCE_SOURCE_LABELS.SEEDED_DEMO;
  if (row.source === 'PLATFORM') return `from ${platformName(row.platform)}`;
  return `from ${row.source}`;
}

function views(row: NoticePerformanceRow): number | null {
  const v = row.metrics['views'];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function windowHours(row: NoticePerformanceRow): number | null {
  const h = (Date.parse(row.windowEnd) - Date.parse(row.windowStart)) / 3_600_000;
  return Number.isFinite(h) && h > 0 ? Math.round(h) : null;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// --- 1. Facts from the file -------------------------------------------------------------------

function fileFactRungs(kind: NoticeInput['kind'], v: NoticeVersionFacts): NoticeRung[] {
  const browser = "from the file, as read in the uploader's browser";
  const out: NoticeRung[] = [];
  if (kind === 'VIDEO' && v.durationSeconds !== null) out.push(fact(`${v.label} runs ${formatSeconds(v.durationSeconds)}`, browser, v.readyAt));
  if (v.width !== null && v.height !== null) {
    out.push(fact(`${v.label} is ${v.width}×${v.height}`, browser, v.readyAt));
    out.push(observation(aspect(v.width, v.height), "Loop's reading of the dimensions", v.readyAt));
  }
  if (v.byteSize !== null) out.push(fact(`${v.label} is ${size(v.byteSize)}`, 'from storage', v.readyAt));
  return out;
}

// --- 2. What changed between the latest and the previous READY version --------------------------

function versionDeltaRungs(latest: NoticeVersionFacts, previous: NoticeVersionFacts): NoticeRung[] {
  const source = "Loop's comparison of the versions";
  const prevName = previous.kind === 'ORIGINAL' ? `the ${previous.label}` : previous.label;
  const out: NoticeRung[] = [];
  if (latest.durationSeconds !== null && previous.durationSeconds !== null) {
    const delta = Math.round(latest.durationSeconds - previous.durationSeconds);
    const text =
      delta === 0
        ? `${latest.label} runs the same length as ${prevName} (${formatSeconds(latest.durationSeconds)})`
        : `${latest.label} is ${formatSeconds(latest.durationSeconds)}, ${span(Math.abs(delta))} ${delta < 0 ? 'shorter' : 'longer'} than ${prevName}`;
    out.push(observation(text, source, latest.readyAt));
  }
  const dims = [latest.width, latest.height, previous.width, previous.height];
  if (dims.every((d) => d !== null) && (latest.width !== previous.width || latest.height !== previous.height)) {
    out.push(observation(`${latest.label} is ${latest.width}×${latest.height}; ${prevName} was ${previous.width}×${previous.height}`, source, latest.readyAt));
  }
  return out;
}

// --- 3–5. Reach on each platform it was published to --------------------------------------------

/** The earliest window of `hours` length for each OTHER piece on the platform, one row per piece. */
function otherFirstWindows(input: NoticeInput, platform: string, hours: number | null): NoticePerformanceRow[] {
  const byContent = new Map<string, NoticePerformanceRow>();
  for (const row of input.performance) {
    if (row.contentId === null || row.contentId === input.contentId || row.platform !== platform) continue;
    if (windowHours(row) !== hours || views(row) === null) continue;
    const held = byContent.get(row.contentId);
    if (!held || Date.parse(row.windowStart) < Date.parse(held.windowStart)) byContent.set(row.contentId, row);
  }
  return [...byContent.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
}

function reachRungs(input: NoticeInput, platform: string): { rungs: NoticeRung[]; seeded: boolean } {
  const name = platformName(platform);
  const mine = input.performance.filter((r) => r.contentId === input.contentId && r.platform === platform && views(r) !== null);
  const latest = [...mine].sort((a, b) => Date.parse(b.windowEnd) - Date.parse(a.windowEnd))[0] ?? null;
  if (!latest) return { rungs: [notYet(`How it is doing on ${name}: Loop needs a views report from ${name} for this piece (none yet)`, `Loop's record of ${name} reports`)], seeded: false };

  const count = views(latest)!;
  const hours = windowHours(latest);
  const window = hours === null ? '' : ` over ${hours} hours`;
  const open = Date.parse(latest.windowEnd) > Date.parse(input.now);
  const rungs: NoticeRung[] = [fact(`${name} reports ${whole(count)} views${window}${open ? ' so far (the window is still open)' : ''}`, sourceOf(latest), latest.observedAt ?? latest.windowEnd)];
  let seeded = latest.source === 'SEEDED_DEMO';
  const compareSource = `Loop's comparison with your other pieces on ${name}`;
  if (open) {
    rungs.push(notYet(`How this compares with your other pieces on ${name}: Loop needs this ${hours ?? ''}-hour window to close first`, compareSource));
    return { rungs, seeded };
  }

  const others = otherFirstWindows(input, platform, hours);
  const n = others.length;
  seeded = seeded || others.some((r) => r.source === 'SEEDED_DEMO');
  if (n < COMPARE_MIN_SAMPLE) {
    rungs.push(notYet(`How this compares: Loop needs at least ${COMPARE_MIN_SAMPLE} other published pieces on ${name} to compare (has ${n})`, compareSource));
    return { rungs, seeded };
  }
  const med = median(others.map((r) => views(r)!));
  if (med <= 0) {
    rungs.push(notYet(`How this compares: your other ${n} pieces on ${name} reported no views in this window, so there is nothing to compare against`, compareSource));
    return { rungs, seeded };
  }
  const ratio = Math.round((count / med) * 10) / 10;
  const observed = `${ratio.toFixed(1)}× your median ${hours ?? ''}-hour views (${whole(med)}) across ${n} other pieces on ${name}`;
  rungs.push(observation(observed, compareSource, latest.observedAt ?? latest.windowEnd, n));

  const departs = ratio >= ABOVE || ratio <= BELOW;
  if (n >= INTERPRET_MIN_SAMPLE && departs) {
    const direction = ratio >= ABOVE ? 'above' : 'below';
    const limitations = [`One ${hours ?? ''}-hour window against ${n} other pieces on ${name}; it says nothing about why, and it is not a forecast`];
    if (seeded) limitations.push('Rests partly or wholly on seeded demo data, not on a platform report');
    const interpretation = `This is ${direction} your usual first-window reach on ${name}`;
    rungs.push({ rung: 'INTERPRETATION', text: interpretation, source: `Loop's inference from ${n} other pieces on ${name}`, observedAt: null, sample: n, standing: 'proposed', restsOn: observed, limitations });
    if (direction === 'above') {
      rungs.push({ rung: 'PROPOSED', text: 'Consider a follow-up in the same format', source: "Loop's proposal", observedAt: null, sample: n, standing: 'proposed', restsOn: interpretation });
    }
  } else if (n < INTERPRET_MIN_SAMPLE) {
    rungs.push(notYet(`Whether this is unusual: Loop needs ${INTERPRET_MIN_SAMPLE} other published pieces on ${name} (has ${n})`, compareSource));
  } else {
    rungs.push(notYet(`Whether this is unusual: at ${ratio.toFixed(1)}× your median, Loop does not call it either way; it needs a departure of ${ABOVE}× or more, or ${BELOW}× or less`, compareSource));
  }
  return { rungs, seeded };
}

// --- The notice ---------------------------------------------------------------------------------

export function creatorContentNotice(input: NoticeInput): ContentNotice {
  const ready = input.versions.filter((v) => v.readyAt !== null).sort((a, b) => b.number - a.number);
  const latest = ready[0] ?? null;
  const previous = ready[1] ?? null;

  const fileFacts = latest ? fileFactRungs(input.kind, latest) : [];
  const rungs: NoticeRung[] =
    fileFacts.length > 0
      ? fileFacts
      : [notYet("Loop has not read this file yet. It needs a finished upload whose duration and dimensions the uploader's browser reported", "Loop's record of this content's versions")];
  if (latest && previous) rungs.push(...versionDeltaRungs(latest, previous));

  let seeded = false;
  if (input.published.length > 0) {
    const platforms = [...new Set(input.published.map((p) => p.platform))];
    for (const platform of platforms) {
      const reach = reachRungs(input, platform);
      rungs.push(...reach.rungs);
      seeded = seeded || reach.seeded;
    }
  }
  return { rungs, seeded };
}
