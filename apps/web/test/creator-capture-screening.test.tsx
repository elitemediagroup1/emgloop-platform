import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreatorCaptureScreening } from '../src/creator/creator-capture-screening';

test('manager breakdown distinguishes pre-AI brand and creator gates from unavailable AI by source', () => {
  const html = renderToStaticMarkup(<CreatorCaptureScreening sources={[
    { label: 'Staff source', readings: [{ state: 'UNMAPPED_BRAND' }, { state: 'UNMAPPED_BRAND' }, { state: 'UNMATCHED_CREATOR' }] },
    { label: 'Assigned source', readings: [{ state: 'MODEL_UNAVAILABLE' }, { state: 'CURRENT' }] },
  ]} />);
  assert.match(html, /company matched in subject or external domain<\/th><td>2<\/td><td>0<\/td>/);
  assert.match(html, /Creator not matched in staff subject or body<\/th><td>1<\/td><td>0<\/td>/);
  assert.match(html, /AI summary unavailable<\/th><td>0<\/td><td>1<\/td>/);
  assert.match(html, /Accepted summary \(may be stale\)<\/th><td>0<\/td><td>1<\/td>/);
  assert.match(html, /An unmatched or unmapped thread stops before AI/);
  assert.doesNotMatch(html, /Unclassified result/);
});

test('unknown results stay count-only and candidate/private fields never render', () => {
  const privateReading = { state: 'PRIVATE_UNKNOWN_STATE', brandId: 'PRIVATE_BRAND', subject: 'PRIVATE_SUBJECT', threadId: 'PRIVATE_THREAD', update: { summary: 'PRIVATE_OUTPUT' } };
  const html = renderToStaticMarkup(<CreatorCaptureScreening sources={[{ label: 'Authorized source', readings: [privateReading] }]} />);
  assert.match(html, /Unclassified result<\/th><td>1<\/td>/);
  assert.doesNotMatch(html, /PRIVATE_/);
  assert.equal(renderToStaticMarkup(<CreatorCaptureScreening sources={[{ label: 'Authorized source', readings: [] }]} />), '');
});

test('validation retry diagnostics count only allowlisted reasons and never reveal source fields', () => {
  const html = renderToStaticMarkup(<CreatorCaptureScreening sources={[
    { label: 'Staff source', readings: [{ state: 'MODEL_UNAVAILABLE', rejections: ['UNSUPPORTED_NUMBER_IN_TEXT', 'PRIVATE_PROVIDER_TEXT'] }] },
    { label: 'Other source', readings: [{ state: 'CURRENT', rejections: ['UNSUPPORTED_NUMBER_IN_TEXT'] }] },
  ]} />);
  assert.match(html, /UNSUPPORTED_NUMBER_IN_TEXT<\/th><td>1<\/td><td>0<\/td>/);
  assert.match(html, /remaining queue continues/);
  assert.doesNotMatch(html, /PRIVATE_/);
});
