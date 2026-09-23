// "What Loop noticed" climbs the ladder only as far as the evidence carries it: facts name their
// source, observations are exact arithmetic on the creator's own history, an interpretation needs
// five other pieces and a real departure, a proposal needs an 'above' interpretation, and every
// withheld rung says what Loop still needs. Pure: the same input yields the same notice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creatorContentNotice, type NoticeInput, type NoticePerformanceRow, type NoticeVersionFacts } from '../src/creator-content-notice';

const NOW = '2026-09-22T12:00:00.000Z';
const READY = '2026-09-20T10:00:00.000Z';

const ver = (n: number, over: Partial<NoticeVersionFacts> = {}): NoticeVersionFacts => ({
  versionId: `v${n}`,
  label: n === 0 ? 'Original' : `Edit v${n}`,
  number: n,
  kind: n === 0 ? 'ORIGINAL' : 'EDIT',
  durationSeconds: 47,
  width: 1080,
  height: 1920,
  byteSize: 24_100_000,
  readyAt: READY,
  ...over,
});

const row = (contentId: string, views: number, over: Partial<NoticePerformanceRow> = {}): NoticePerformanceRow => ({
  contentId,
  platform: 'INSTAGRAM',
  windowStart: '2026-09-18T00:00:00.000Z',
  windowEnd: '2026-09-20T00:00:00.000Z',
  metrics: { views },
  source: 'PLATFORM',
  ...over,
});

const base = (over: Partial<NoticeInput> = {}): NoticeInput => ({
  contentId: 'c1',
  kind: 'VIDEO',
  state: 'PUBLISHED',
  versions: [ver(0)],
  published: [{ platform: 'INSTAGRAM', at: '2026-09-18T00:00:00.000Z' }],
  performance: [],
  now: NOW,
  ...over,
});

/** Five other pieces whose 48-hour views have a median of 11,500. */
const FIVE_OTHERS = [9_000, 10_000, 11_500, 13_000, 14_000].map((v, i) => row(`o${i + 1}`, v));

const kinds = (input: NoticeInput) => creatorContentNotice(input).rungs.map((r) => r.rung);

test('no READY version: the only rung is a NOT_YET saying Loop has not read the file', () => {
  for (const versions of [[], [ver(0, { readyAt: null })]]) {
    const notice = creatorContentNotice(base({ versions, published: [] }));
    assert.deepEqual(notice.rungs.map((r) => r.rung), ['NOT_YET']);
    assert.match(notice.rungs[0]!.text, /Loop has not read this file yet/);
    assert.equal(notice.seeded, false);
  }
});

test('file facts: duration, dimensions, derived orientation and size, each with its source', () => {
  const { rungs } = creatorContentNotice(base({ versions: [ver(0, { durationSeconds: 39 })], published: [] }));
  assert.deepEqual(
    rungs.map((r) => [r.rung, r.text, r.source]),
    [
      ['FACT', 'Original runs 0:39', "from the file, as read in the uploader's browser"],
      ['FACT', 'Original is 1080×1920', "from the file, as read in the uploader's browser"],
      ['OBSERVATION', 'Vertical (9:16)', "Loop's reading of the dimensions"],
      ['FACT', 'Original is 24.1 MB', 'from storage'],
    ],
  );
  assert.ok(rungs.every((r) => r.observedAt === READY));
  // A photo has no duration, whatever the browser bag says; a landscape frame reads horizontal.
  const photo = creatorContentNotice(base({ kind: 'PHOTO', versions: [ver(0, { width: 1920, height: 1080 })], published: [] })).rungs;
  assert.deepEqual(photo.map((r) => r.text), ['Original is 1920×1080', 'Horizontal (16:9)', 'Original is 24.1 MB']);
});

test('two READY versions: what changed between the latest and the previous, from Loop\'s comparison', () => {
  const versions = [ver(0, { width: 3840, height: 2160 }), ver(1, { durationSeconds: 47 }), ver(2, { durationSeconds: 39 })];
  const { rungs } = creatorContentNotice(base({ versions, published: [] }));
  const deltas = rungs.filter((r) => r.source === "Loop's comparison of the versions").map((r) => r.text);
  assert.deepEqual(deltas, ['Edit v2 is 0:39, 8 s shorter than Edit v1']);
  // The latest is compared with the previous READY version, not with the Original.
  const skipPending = creatorContentNotice(base({ versions: [versions[0]!, ver(1, { readyAt: null }), versions[2]!], published: [] })).rungs;
  assert.deepEqual(skipPending.filter((r) => r.source === "Loop's comparison of the versions").map((r) => r.text), [
    'Edit v2 is 0:39, 8 s shorter than the Original',
    'Edit v2 is 1080×1920; the Original was 3840×2160',
  ]);
});

test('published with fewer than 3 other pieces: the platform FACT, then a NOT_YET that names the shortfall', () => {
  const performance = [row('c1', 18_400, { observedAt: '2026-09-20T01:00:00.000Z' }), row('o1', 9_000), row('o2', 14_000)];
  const notice = creatorContentNotice(base({ performance }));
  const reach = notice.rungs.slice(4);
  assert.deepEqual(reach.map((r) => [r.rung, r.text, r.source, r.observedAt]), [
    ['FACT', 'Instagram reports 18,400 views over 48 hours', 'from Instagram', '2026-09-20T01:00:00.000Z'],
    ['NOT_YET', 'How this compares: Loop needs at least 3 other published pieces on Instagram to compare (has 2)', "Loop's comparison with your other pieces on Instagram", undefined],
  ]);
  assert.equal(notice.seeded, false);
  // Published but no report at all: still a NOT_YET, never a number.
  assert.deepEqual(kinds(base()).slice(4), ['NOT_YET']);
  // Not published: no reach rungs even if rows exist.
  assert.deepEqual(kinds(base({ published: [], performance })), ['FACT', 'FACT', 'OBSERVATION', 'FACT']);
});

test('five others and a 1.6x ratio: OBSERVATION, an INTERPRETATION standing proposed, and a PROPOSED resting on it', () => {
  const performance = [row('c1', 18_400, { source: 'SEEDED_DEMO' }), ...FIVE_OTHERS];
  const notice = creatorContentNotice(base({ performance }));
  const [factRung, obs, interp, proposed] = notice.rungs.slice(4);
  assert.equal(factRung!.source, 'seeded demo data');
  assert.equal(obs!.rung, 'OBSERVATION');
  assert.equal(obs!.text, '1.6× your median 48-hour views (11,500) across 5 other pieces on Instagram');
  assert.equal(obs!.sample, 5);
  assert.equal(interp!.rung, 'INTERPRETATION');
  assert.equal(interp!.text, 'This is above your usual first-window reach on Instagram');
  assert.equal(interp!.standing, 'proposed');
  assert.equal(interp!.sample, 5);
  assert.equal(interp!.restsOn, obs!.text);
  assert.ok(interp!.limitations!.some((l) => /seeded demo data/.test(l)));
  assert.equal(proposed!.rung, 'PROPOSED');
  assert.equal(proposed!.text, 'Consider a follow-up in the same format');
  assert.equal(proposed!.restsOn, interp!.text);
  assert.equal(notice.rungs.length, 8);
  assert.equal(notice.seeded, true);
  // A platform report compared against seeded history is still seeded; all-platform evidence is not.
  assert.equal(creatorContentNotice(base({ performance: [row('c1', 18_400), ...FIVE_OTHERS.map((r) => ({ ...r, source: 'SEEDED_DEMO' }))] })).seeded, true);
  const clean = creatorContentNotice(base({ performance: [row('c1', 18_400), ...FIVE_OTHERS] }));
  assert.equal(clean.seeded, false);
  assert.equal(clean.rungs[6]!.limitations!.length, 1);
});

test('below the band interprets but never proposes; inside the band, or under 5 others, withholds', () => {
  const below = creatorContentNotice(base({ performance: [row('c1', 4_600), ...FIVE_OTHERS] })).rungs.slice(4);
  assert.deepEqual(below.map((r) => r.rung), ['FACT', 'OBSERVATION', 'INTERPRETATION']);
  assert.equal(below[2]!.text, 'This is below your usual first-window reach on Instagram');

  const even = creatorContentNotice(base({ performance: [row('c1', 11_500), ...FIVE_OTHERS] })).rungs.slice(4);
  assert.deepEqual(even.map((r) => r.rung), ['FACT', 'OBSERVATION', 'NOT_YET']);
  assert.match(even[1]!.text, /^1\.0× your median/);
  assert.match(even[2]!.text, /^Whether this is unusual: at 1\.0× your median, Loop does not call it either way/);

  const four = creatorContentNotice(base({ performance: [row('c1', 18_400), ...FIVE_OTHERS.slice(0, 4)] })).rungs.slice(4);
  assert.deepEqual(four.map((r) => r.rung), ['FACT', 'OBSERVATION', 'NOT_YET']);
  assert.equal(four[2]!.text, 'Whether this is unusual: Loop needs 5 other published pieces on Instagram (has 4)');
});

test('comparisons are like-for-like: only other pieces with a window of the same length, one row each', () => {
  const performance = [
    row('c1', 18_400),
    ...FIVE_OTHERS,
    row('o1', 99_000, { windowStart: '2026-09-18T00:00:00.000Z', windowEnd: '2026-09-25T00:00:00.000Z' }), // a 7-day window: ignored
    row('o2', 99_000, { windowStart: '2026-09-20T00:00:00.000Z', windowEnd: '2026-09-22T00:00:00.000Z' }), // a later 48h window: not the first
    row(null as unknown as string, 99_000), // unattributed: ignored
    row('c1', 25_000, { windowStart: '2026-09-11T00:00:00.000Z', windowEnd: '2026-09-13T00:00:00.000Z' }), // an older window of this piece: the FACT uses the latest
  ];
  const obs = creatorContentNotice(base({ performance })).rungs[5]!;
  assert.equal(obs.text, '1.6× your median 48-hour views (11,500) across 5 other pieces on Instagram');
});

test('pure: `now` comes from the input, the same input gives the same notice, and nothing is mutated', () => {
  const input = base({ versions: [ver(2), ver(0), ver(1, { readyAt: null })], performance: [row('c1', 18_400), ...FIVE_OTHERS] });
  const before = structuredClone(input);
  assert.deepEqual(creatorContentNotice(input), creatorContentNotice(input));
  assert.deepEqual(input, before);
  // Version order in the input does not matter: v2 is the latest READY, compared with the Original (v1 is pending).
  assert.equal(creatorContentNotice(input).rungs[4]!.text, 'Edit v2 runs the same length as the Original (0:47)');
  // An earlier `now` puts the window still open: the FACT says so and the comparison is withheld.
  const open = creatorContentNotice({ ...input, now: '2026-09-19T00:00:00.000Z' }).rungs.slice(5);
  assert.deepEqual(open.map((r) => r.rung), ['FACT', 'NOT_YET']);
  assert.equal(open[0]!.text, 'Instagram reports 18,400 views over 48 hours so far (the window is still open)');
  assert.match(open[1]!.text, /needs this 48-hour window to close first/);
});
