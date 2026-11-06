import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_TASK_CREATOR_ANALYTICS_READING } from '@emgloop/shared';
import { metaAnalyticsContext, metaAnalyticsFingerprint, MetaAnalyticsService } from '../src/services/meta/meta-analytics.service';
import { iamAiAuthorizer } from '../src/services/ai-runtime/authorizer';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import type { PrismaClient } from '@prisma/client';
import type { MetaConnectionRepository } from '../src/repositories/meta-connection.repository';
const p = { organizationId: 'org-a', userId: 'creator-a', creatorProfileId: 'profile-a' };
const rows = [{ id: 'observation-a', observedAt: new Date('2026-11-06T12:00:00Z'), report: { platform: 'INSTAGRAM', accountId: '987654321', name: 'private-handle', followers: 123, windowStart: '2026-10-09T00:00:00Z', windowEnd: '2026-11-06T00:00:00Z', metrics: [{ name: 'views', value: 456, failure: null }], media: [{ id: '87654321', type: 'REELS', permalink: 'https://instagram.com/private-url', publishedAt: '2026-11-01T12:00:00Z', metrics: [{ name: 'views', value: 22, failure: null }] }], limitations: ['Small sample.'] } }];
test('AI context contains only own numerical analytics, timestamps and source references', () => {
  const built = metaAnalyticsContext(p, rows);
  const serialized = JSON.stringify(built.context);
  assert.doesNotMatch(serialized, /private-handle|private-url|987654321|87654321/);
  assert.match(serialized, /meta_observation:observation-a/);
  assert.equal(built.context.viewerUserId, p.userId);
  assert.equal(built.context.organizationId, p.organizationId);
  assert.ok(built.evidence.figures.get('meta_observation:observation-a')?.has(456));
  assert.equal(metaAnalyticsFingerprint(rows), metaAnalyticsFingerprint([{ ...rows[0]!, observedAt: new Date() }]));
  assert.notEqual(metaAnalyticsFingerprint(rows), metaAnalyticsFingerprint([{ ...rows[0]!, report: { ...rows[0]!.report, followers: 124 } }]));
});
test('only the exact creator analytics task is admitted through a bound active creator profile; no org IAM grant', async () => {
  const fake = makeCognitivePrisma({ also: ['organizationMembership', 'creatorProfile'] });
  await fake.user.create({ data: { id: p.userId, organizationId: p.organizationId, status: 'ACTIVE', metadata: { systemRole: 'CREATOR' } } });
  await fake.organizationMembership.create({ data: { organizationId: p.organizationId, userId: p.userId, status: 'ACTIVE', systemRole: 'CREATOR', effectiveFrom: new Date(0) } });
  await fake.creatorProfile.create({ data: { id: p.creatorProfileId, organizationId: p.organizationId, userId: p.userId } });
  let orgChecks = 0;
  const authorize = iamAiAuthorizer(fake as unknown as PrismaClient, { can: async () => { orgChecks++; return false; } });
  assert.equal(await authorize(p, AI_TASK_CREATOR_ANALYTICS_READING), true);
  assert.equal(orgChecks, 0);
  assert.equal(await authorize(p, { ...AI_TASK_CREATOR_ANALYTICS_READING }), false, 'a caller cannot forge the special admission definition');
  assert.equal(await authorize({ ...p, organizationId: 'other' }, AI_TASK_CREATOR_ANALYTICS_READING), false);
  await fake.creatorProfile.deleteMany({ where: { id: p.creatorProfileId } });
  assert.equal(await authorize(p, AI_TASK_CREATOR_ANALYTICS_READING), false);
});
test('unchanged evidence skips model spend and releases analysis lease', async () => {
  let finished = false;
  const repo = { claimAnalysis: async () => ({ connection: { id: 'connection-a' }, observations: rows, leaseId: 'lease-a' }), reading: async () => ({ id: 'existing' }), finishAnalysis: async () => { finished = true; return true; } } as unknown as MetaConnectionRepository;
  const service = new MetaAnalyticsService(repo, { run: async () => { throw new Error('must not spend'); } });
  assert.equal(await service.analyze(p), 'UNCHANGED');
  assert.equal(finished, true);
});
test('AI refusal records an unavailable outcome and never publishes a canned analysis', async () => {
  let failure: unknown;
  const repo = { claimAnalysis: async () => ({ connection: { id: 'connection-a' }, observations: rows, leaseId: 'lease-a' }), reading: async () => null, finishAnalysis: async (_p: unknown, _c: unknown, _l: unknown, result: unknown) => { failure = result; return true; } } as unknown as MetaConnectionRepository;
  const service = new MetaAnalyticsService(repo, { run: async () => ({ outcome: 'REFUSED_BY_LOOP', refusals: [] }) });
  assert.equal(await service.analyze(p), 'REFUSED_BY_LOOP');
  assert.deepEqual(failure, { failure: 'REFUSED_BY_LOOP' });
});
