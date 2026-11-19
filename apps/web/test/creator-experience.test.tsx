import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTimeView } from '@emgloop/shared';
import type { PublishedCreatorBrandUpdate } from '@emgloop/database';
import { CreatorSetupChecklist } from '../src/creator/creator-setup-checklist';
import { CreatorPartnershipBoard, creatorRelationshipTimeline } from '../src/creator/creator-brand-updates';

const at = new Date('2026-11-19T17:00:00Z');
const time = createTimeView({ timeZone: 'America/New_York', source: 'device' }, at);
const row: PublishedCreatorBrandUpdate = { id: 'first', brandId: 'one', brand: 'One Brand', stage: 'AWAITING_BRAND', summary: 'A proposal is being reviewed.', nextStep: 'Await the brand’s reply.', generatedAt: at, evidenceAt: at, checkedAt: at, current: true };

test('setup never treats a declared public handle as a connected account', () => {
  const html = renderToStaticMarkup(<CreatorSetupChecklist profile={{ displayName: 'Creator', handle: 'myhandle', bio: 'My work' }} />);
  assert.match(html, /Name and bio saved/);
  assert.match(html, /connections are managed separately/);
  assert.match(html, /profile#social-connections/);
  assert.doesNotMatch(html, /Connected successfully|api\/integrations|<form/);
  const unavailable = renderToStaticMarkup(<CreatorSetupChecklist profile={null} />);
  assert.match(unavailable, /could not be checked/);
  assert.doesNotMatch(unavailable, /Name and bio saved/);
});

test('timeline groups repeated readings without removing revisions or inventing events', () => {
  const earlier = { ...row, id: 'earlier', evidenceAt: new Date(at.getTime() - 86400000) };
  const revision = { ...row, id: 'revision', generatedAt: new Date(at.getTime() + 1000), summary: 'The team is reviewing the same proposal.' };
  const input = [row, revision, earlier];
  assert.deepEqual(creatorRelationshipTimeline(input).map(u => u.id), ['revision', 'earlier']);
  assert.deepEqual(input.map(u => u.id), ['first', 'revision', 'earlier']);
  const html = renderToStaticMarkup(<CreatorPartnershipBoard rows={input} time={time} stage="1" query="" available brandId="one" />);
  assert.match(html, /Relationship timeline · 2 saved updates/);
  assert.match(html, /Summary history · 3 saved versions/);
  assert.doesNotMatch(html, /Contract signed|Payment received/);
});

test('selected relationship links preserve search and filters and expose a direct detail target', () => {
  const html = renderToStaticMarkup(<CreatorPartnershipBoard rows={[row]} time={time} stage="1" query="One" status="AWAITING_BRAND" available brandId="one" />);
  assert.match(html, /status=AWAITING_BRAND#relationship-detail/);
  assert.match(html, /id="relationship-detail"[^>]*data-selected="true"/);
  assert.match(html, /q=One&amp;status=AWAITING_BRAND#brand-one/);
  assert.match(html, /name="brandId" value="one"/);
  assert.match(html, /Only you and your EMG team/);
  assert.doesNotMatch(html, /mail_message:|sourceFingerprint/);
});

test('a filter with no matches has no creator message action or fabricated selected brand', () => {
  const html = renderToStaticMarkup(<CreatorPartnershipBoard rows={[row]} time={time} stage="1" query="missing" available />);
  assert.match(html, /No matching brands/);
  assert.doesNotMatch(html, /Send to EMG|data-selected="true"/);
});
