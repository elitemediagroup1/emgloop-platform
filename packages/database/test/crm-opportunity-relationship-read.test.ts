import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repository = readFileSync(join(__dirname, '..', 'src', 'repositories', 'crm-opportunity-read-model.repository.ts'), 'utf8');
const service = readFileSync(join(__dirname, '..', 'src', 'services', 'crm-opportunity-read.service.ts'), 'utf8');

test('Relationship-linked Opportunities use explicit relationshipId and organization scope only', () => {
  const start = repository.indexOf('async forRelationship(');
  const end = repository.indexOf('/** One Opportunity in this organization', start);
  assert.ok(start >= 0 && end > start);
  const body = repository.slice(start, end);
  assert.match(body, /where: \{ organizationId, relationshipId \}/);
  assert.doesNotMatch(body, /displayName|email|phone|internalNotes|PRIMARY_CONTACT/);
  assert.match(body, /crmParticipant\.findMany/);
  assert.match(body, /this\.lookups\(/);
  assert.doesNotMatch(body, /getRecord\(/, 'does not N+1 through full Opportunity records');
});

test('the authorized service checks access before reading the Relationship-linked projection', () => {
  const start = service.indexOf('async forRelationship(');
  const end = service.indexOf('async getRecord(', start);
  assert.ok(start >= 0 && end > start);
  const body = service.slice(start, end);
  const access = body.indexOf('await this.access(viewer)');
  const read = body.indexOf('this.readModel.forRelationship');
  assert.ok(access >= 0 && read > access);
  assert.match(body, /if \(!access\) return \{ outcome: 'NOT_AUTHORIZED' \}/);
});
