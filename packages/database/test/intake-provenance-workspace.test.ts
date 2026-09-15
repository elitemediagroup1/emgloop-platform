// Intake Record workspace carries its read-time provenance segment. Intake slice, part 2.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { CrmRepository } from '../src/repositories/crm.repository';

test('the workspace names how the Intake Record was created, and a cross-org id is not found', async () => {
  const fake: any = makeCognitivePrisma({ also: ['customer', 'interaction', 'booking', 'signal', 'conversation'] });
  const repo = new CrmRepository(fake as PrismaClient);
  const call = (await fake.customer.create({ data: { organizationId: 'org_a', firstName: 'Caller', externalId: null, tags: [], attributes: {}, metadata: { createdFrom: 'callgrid' } } })).id;
  const visitor = (await fake.customer.create({ data: { organizationId: 'org_a', firstName: 'Visitor', externalId: 'web-visitor:v', tags: [], attributes: {}, metadata: {} } })).id;
  const theirs = (await fake.customer.create({ data: { organizationId: 'org_b', firstName: 'Theirs', externalId: null, tags: [], attributes: {}, metadata: {} } })).id;

  assert.equal((await repo.getWorkspace('org_a', call))?.provenanceSegment, 'INGESTION_CALL');
  assert.equal((await repo.getWorkspace('org_a', visitor))?.provenanceSegment, 'INGESTION_WEB_VISITOR');
  assert.equal(await repo.getWorkspace('org_a', theirs), null);
});
