// Loop Intelligence Phase F: situations on Home, the Headlines workspace and the Case page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTimeView } from '@emgloop/shared';

import { SituationRecordSection, SituationsPanel } from '../src/intelligence/situations-view';

const src = (...p: string[]) => readFileSync(join(__dirname, '..', 'src', ...p), 'utf8');
const TIME = createTimeView({ timeZone: 'UTC', source: 'device' }, new Date('2026-09-26T12:00:00Z'));

const view = (visibility: 'PRINCIPAL' | 'ORGANIZATION', state = 'UNAVAILABLE') => ({
  id: `case_${visibility}`,
  visibility,
  title: 'A campaign is moving in two places',
  summary: 'The same campaign appears in two readings in the same week.',
  severity: 'HIGH',
  state: 'NEEDS_REVIEW',
  firstDetectedAt: new Date('2026-09-25T00:00:00Z'),
  lastDetectedAt: new Date('2026-09-26T00:00:00Z'),
  record: {
    schema: 'loop-situation.v1' as const,
    clusterKey: 'sc_x',
    fingerprint: 'situation:x',
    narrative: 'The same campaign appears in two readings in the same week.',
    refs: ['provider_member:callgrid:campaign:c1'],
    citations: ['digest:a/b'],
    domains: ['CALLGRID', 'CAMPAIGNS'],
    claims: [{ kind: 'CONNECTION', statement: 'Both readings name the same campaign.', citations: ['digest:a/b'], verdict: state === 'VERIFIED' ? ('SUPPORTED' as const) : null }],
    limitations: [],
    verification: { state: state as never, providerId: null },
    synthesis: { invocationId: 'i', providerId: 'anthropic', taskId: 'situation.synthesis', taskVersion: '1.0.0' },
    windowStart: '2026-09-20T00:00:00.000Z',
    windowEnd: '2026-09-26T00:00:00.000Z',
  },
});

test('the Situations panel: nothing when there is nothing; "Only you" on a private one; the check said as it happened', () => {
  assert.equal(renderToStaticMarkup(<SituationsPanel read={{ personal: [], organization: [] }} time={TIME} caseHref={null} />), '');
  const html = renderToStaticMarkup(<SituationsPanel read={{ personal: [view('PRINCIPAL')], organization: [view('ORGANIZATION', 'VERIFIED')] }} time={TIME} caseHref={(id) => `/app/admin/cases/${id}`} />);
  assert.match(html, /Only you/);
  assert.match(html, /No independent check is available/);
  assert.match(html, /Independently checked: every claim supported/);
  assert.match(html, /\(Supported\)/);
  assert.match(html, /href="\/app\/admin\/cases\/case_ORGANIZATION"/);
  assert.doesNotMatch(html, /href="\/app\/admin\/cases\/case_PRINCIPAL"/, 'a private situation never links into the organization Case surface');
});

test('the Case page section says what it is and is not', () => {
  const html = renderToStaticMarkup(<SituationRecordSection view={view('ORGANIZATION', 'PARTIAL')} time={TIME} />);
  assert.match(html, /What Loop connected/);
  assert.match(html, /does not say that one caused another/);
});

test('reads are scoped by the session: private as the viewer, organization only with every cited domain’s authority', () => {
  const code = src('intelligence', 'situations.ts');
  assert.match(code, /repo\.open\(\{ scope: 'PRINCIPAL', organizationId: session\.organizationId, userId: session\.userId \}/);
  assert.match(code, /for \(const d of domains\) if \(!\(await may\(d\)\)\) ok = false;/);
  assert.doesNotMatch(code, /searchParams|formData|SituationService|\.pass\(/, 'a page render never synthesizes');
  const kase = src('app', 'app', 'admin', 'cases', '[id]', 'page.tsx');
  assert.match(kase, /situationCaseFor\(session, params\.id\)[\s\S]*if \(situation\.kind === 'HIDDEN'\) notFound\(\);/);
});

test('both Home seats and the Headlines workspace render situations from the one loader', () => {
  assert.match(src('app', 'app', '_home', 'front-door-data.ts'), /loadSituations\(session\)/);
  assert.match(src('app', 'app', '_home', 'admin-home.tsx'), /<SituationsPanel read=\{front\.situations\}/);
  assert.match(src('app', 'app', '_home', 'module-home.tsx'), /<SituationsPanel read=\{front\.situations\} time=\{time\} caseHref=\{null\}/);
  assert.match(src('app', 'app', 'admin', 'headlines', 'page.tsx'), /loadSituations\(session\)/);
});
