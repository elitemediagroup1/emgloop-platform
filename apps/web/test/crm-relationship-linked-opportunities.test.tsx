import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(__dirname, '..', 'src', 'app', 'app', 'crm', 'relationships', '[relationshipId]', 'page.tsx'), 'utf8');
const data = readFileSync(join(__dirname, '..', 'src', 'crm', 'crm-slice-data.ts'), 'utf8');

test('Relationship detail renders only authorized explicitly linked Opportunities', () => {
  assert.match(page, /readOpportunitiesForRelationship\(record\.relationshipId\)/);
  assert.match(page, /linkedOpportunities\?\.outcome === 'OK'/);
  assert.match(page, /No opportunities are linked to this relationship\./);
  assert.match(page, /opportunityHref\(item\.opportunityId\)/);
  assert.match(page, /item\.brands\.length/);
  assert.match(page, /item\.owner \? ownerText/);
  assert.match(page, /item\.stage/);
  assert.match(page, /categoryText\(item\.category\)/);
});

test('Relationship linked-Opportunity section does not load contact values, notes or write controls', () => {
  assert.doesNotMatch(page, /readContactPoints|ContactPointList|internalNotes|noteRecorded|notes\.state/);
  assert.doesNotMatch(page, /assignOwner|addParticipant|endParticipant|voidParticipant|designateOpportunity/);
  assert.match(data, /opportunities\.forRelationship\(\{ organizationId: ctx\.organizationId, userId: ctx\.userId \}, relationshipId\)/);
});

test('denied Opportunity access leaks no linked Opportunity section or count', () => {
  assert.match(page, /const linkedItems = linkedOpportunities\?\.outcome === 'OK' \? linkedOpportunities\.value : null/);
  assert.match(page, /linkedItems === null/);
  assert.match(page, /linkedItems !== null \?/);
});
