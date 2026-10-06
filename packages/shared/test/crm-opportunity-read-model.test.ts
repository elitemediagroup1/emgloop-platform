// The staff read model contract of CRM Opportunities (CRM slice 4). Pure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CRM_OPPORTUNITY_LIST_DEFAULT_LIMIT,
  CRM_OPPORTUNITY_LIST_MAX_LIMIT,
  crmOpportunityGaps,
  crmOpportunityListLimit,
} from '../src/crm-opportunity-read-model';

test('a page size is clamped, never trusted', () => {
  assert.equal(crmOpportunityListLimit(undefined), CRM_OPPORTUNITY_LIST_DEFAULT_LIMIT);
  assert.equal(crmOpportunityListLimit('50'), CRM_OPPORTUNITY_LIST_DEFAULT_LIMIT);
  assert.equal(crmOpportunityListLimit(Number.NaN), CRM_OPPORTUNITY_LIST_DEFAULT_LIMIT);
  assert.equal(crmOpportunityListLimit(0), 1);
  assert.equal(crmOpportunityListLimit(-5), 1);
  assert.equal(crmOpportunityListLimit(7.9), 7);
  assert.equal(crmOpportunityListLimit(10_000), CRM_OPPORTUNITY_LIST_MAX_LIMIT);
});

test('gaps are facts about absence, in a fixed order', () => {
  assert.deepEqual(crmOpportunityGaps({ owner: null, brands: [], primaryContacts: [] }), ['NO_OWNER', 'NO_BRAND', 'NO_PRIMARY_CONTACT']);
  assert.deepEqual(crmOpportunityGaps({ owner: {}, brands: [{}, {}], primaryContacts: [{}] }), []);
  assert.deepEqual(crmOpportunityGaps({ owner: {}, brands: [], primaryContacts: [{}] }), ['NO_BRAND']);
});
