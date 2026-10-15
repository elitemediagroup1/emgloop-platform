import test from 'node:test';
import assert from 'node:assert/strict';
import { aiOutputContract, BRIEFING_LIMITS } from '@emgloop/shared';
import {
  BriefingComposer,
  BRIEFING_RECORD_SCHEMA,
  type BriefingArtifact,
} from '../src/services/intelligence-fabric/briefing';
import { IamRepository } from '../src/repositories/iam.repository';
import { WorkBriefRepository } from '../src/repositories/work-state/work-brief.repository';
import {
  renderBriefingInstructions,
  BRIEFING_TEMPLATE_VERSION,
} from '../src/services/ai-runtime/templates/briefing';
import type { AiRunRequest } from '../src/services/ai-runtime/gateway';

const principal = { organizationId: 'our-org', userId: 'our-user' };
const now = new Date('2026-10-15T20:00:00Z');
const artifact: BriefingArtifact = {
  ref: 'digest:mail',
  domain: 'MAIL',
  title: 'Your mail',
  statement: 'An unresolved conversation needs attention.',
  status: 'ATTENTION',
  signals: [],
  basis: 'original-evidence',
  coverage: 'CONNECTED_PARTIAL',
  limitations: ['Only part of the mailbox was read.'],
};
function database() {
  const rows: any[] = [];
  const queries: any[] = [];
  return {
    rows,
    queries,
    prisma: {
      workBrief: {
        findMany: async (q: any) => {
          queries.push(q);
          return rows
            .filter(
              (r) =>
                r.organizationId === q.where.organizationId &&
                r.userId === q.where.userId &&
                r.localDate.getTime() === q.where.localDate.getTime() &&
                (!q.where.coverage || r.coverage?.schema === q.where.coverage.equals),
            )
            .sort((a, b) => b.version - a.version)
            .slice(0, q.take);
        },
        create: async ({ data }: any) => {
          const row = { ...data, id: `brief-${rows.length}` };
          rows.push(row);
          return row;
        },
      },
    },
  };
}
function validated(statement: string, req: AiRunRequest) {
  const contract = aiOutputContract('loop-briefing.v1')!;
  const output = contract.parse({
    schemaId: 'loop-briefing.v1',
    headline: 'Some work needs attention.',
    lines: [{ kind: 'NEEDS_YOU', statement, citations: [artifact.ref] }],
    limitations: ['Only part of the mailbox was read.'],
  })!;
  const rejections = contract.validate(
    output,
    req.task,
    new Set(req.context.items.map((i) => i.sourceRef)),
    req.evidence,
  );
  const provenance = {
    invocationId: 'briefing-invocation',
    requestedModel: { providerId: 'anthropic' },
  };
  return (
    rejections.length
      ? { outcome: 'REJECTED_OUTPUT', rejections, provenance }
      : { outcome: 'ANSWERED', output, provenance }
  ) as never;
}
test('the prompt supplies every size limit enforced by the briefing contract', () => {
  const prompt = renderBriefingInstructions([artifact.ref]);
  assert.match(prompt, new RegExp(`${BRIEFING_LIMITS.maxLineChars} characters`));
  assert.match(prompt, new RegExp(`at most ${BRIEFING_LIMITS.maxLimitations} limitations`));
  assert.match(prompt, /Do not calculate/);
  assert.equal(BRIEFING_TEMPLATE_VERSION, '4');
});
test('an unrelated daily brief cannot shadow a stored Loop briefing, and schema filtering remains person scoped', async () => {
  const db = database(),
    localDate = new Date('2026-10-15T00:00:00Z');
  db.rows.push(
    {
      ...principal,
      id: 'loop',
      localDate,
      version: 1,
      headline: 'Real Loop briefing',
      coverage: { schema: BRIEFING_RECORD_SCHEMA },
    },
    {
      ...principal,
      id: 'daily',
      localDate,
      version: 2,
      headline: null,
      coverage: { schema: 'daily-loop.v1' },
    },
    {
      organizationId: 'another-org',
      userId: 'another-user',
      id: 'foreign',
      localDate,
      version: 3,
      coverage: { schema: BRIEFING_RECORD_SCHEMA },
    },
  );
  const repo = new WorkBriefRepository(db.prisma as never);
  assert.equal((await repo.forDate(principal, localDate))!.id, 'daily');
  assert.equal(
    (await repo.forDate(principal, localDate, { schema: BRIEFING_RECORD_SCHEMA }))!.id,
    'loop',
  );
  assert.deepEqual(db.queries[1].where, {
    ...principal,
    localDate,
    coverage: { path: ['schema'], equals: BRIEFING_RECORD_SCHEMA },
  });
});
test('a length rejection gets one repair from original evidence and only a validated answer is stored as MODEL', async (t) => {
  const db = database(),
    requests: AiRunRequest[] = [];
  const composer = new BriefingComposer({
    prisma: db.prisma as never,
    modelEnabled: () => true,
    now: () => now,
    runtime: {
      run: async (_, req) => {
        requests.push(req);
        return validated(requests.length === 1 ? 'x'.repeat(241) : artifact.statement, req);
      },
    },
  });
  t.mock.method(composer, 'gather', async () => ({ artifacts: [artifact], gaps: [] }));
  assert.equal((await composer.compose(principal, 'America/New_York')).outcome, 'COMPOSED');
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.context, requests[0]!.context);
  assert.equal(requests[1]!.evidence, requests[0]!.evidence);
  assert.match(requests[1]!.instructions, /ANSWER_TOO_LONG/);
  assert.doesNotMatch(requests[1]!.instructions, /x{241}/);
  assert.equal(db.rows[0].coverage.composer, 'MODEL');
  assert.equal((await composer.compose(principal, 'America/New_York')).outcome, 'REUSED');
  assert.equal(requests.length, 2);
});
test('two invalid answers retain an honest RULE briefing and content-free rejection codes', async (t) => {
  const db = database();
  let calls = 0;
  const composer = new BriefingComposer({
    prisma: db.prisma as never,
    modelEnabled: () => true,
    now: () => now,
    runtime: {
      run: async (_, req) => {
        calls++;
        return validated('x'.repeat(241), req);
      },
    },
  });
  t.mock.method(composer, 'gather', async () => ({ artifacts: [artifact], gaps: [] }));
  const result = await composer.compose(principal, 'America/New_York');
  assert.equal(calls, 2);
  assert.equal(result.outcome, 'RULE');
  assert.equal(db.rows[0].coverage.modelStage, 'REJECTED_OUTPUT:ANSWER_TOO_LONG');
  assert.equal(db.rows[0].coverage.composer, 'RULE');
});

test('partial coverage cannot become an all-clear briefing even when structural validation passes', async (t) => {
  const db = database();
  let calls = 0;
  const composer = new BriefingComposer({
    prisma: db.prisma as never,
    modelEnabled: () => true,
    now: () => now,
    runtime: {
      run: async (_, req) => {
        calls++;
        return validated(calls === 1 ? 'Nothing is pressing today.' : artifact.statement, req);
      },
    },
  });
  t.mock.method(composer, 'gather', async () => ({ artifacts: [artifact], gaps: [] }));
  assert.equal((await composer.compose(principal, 'America/New_York')).outcome, 'COMPOSED');
  assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(db.rows[0].items), /nothing is pressing/i);
});
test('permission failures and cancelled validation failures do not start a repair', async (t) => {
  for (const mode of ['policy', 'cancelled']) {
    const db = database(),
      controller = new AbortController();
    let calls = 0;
    const composer = new BriefingComposer({
      prisma: db.prisma as never,
      signal: controller.signal,
      modelEnabled: () => true,
      now: () => now,
      runtime: {
        run: async (_, req) => {
          calls++;
          if (mode === 'policy')
            return { outcome: 'REFUSED_BY_LOOP', refusals: ['POLICY_DENIED'] } as never;
          controller.abort();
          return validated('x'.repeat(241), req);
        },
      },
    });
    t.mock.method(composer, 'gather', async () => ({ artifacts: [artifact], gaps: [] }));
    assert.equal((await composer.compose(principal, 'America/New_York')).outcome, 'RULE');
    assert.equal(calls, 1);
  }
});

test('scheduled delivery prioritizes an eligible person missing a briefing over a recently served person', async (t) => {
  t.mock.method(IamRepository.prototype, 'can', async () => true);
  const db = database();
  const ids = ['a-served', 'z-missing', 'inactive'];
  db.rows.push({
    ...principal,
    userId: 'a-served',
    id: 'existing',
    localDate: new Date('2026-10-15T00:00:00Z'),
    version: 1,
    generatedAt: now,
    coverage: { schema: BRIEFING_RECORD_SCHEMA },
  });
  const prisma = {
    ...db.prisma,
    intelligenceDigest: {
      findMany: async () =>
        ids.map((userId) => ({ organizationId: principal.organizationId, userId })),
    },
    employeeWorkPreferences: { findFirst: async () => ({ timeZone: 'America/New_York' }) },
    user: {
      findFirst: async ({ where }: any) => ({
        id: where.id,
        organizationId: principal.organizationId,
        status: 'ACTIVE',
        metadata: { systemRole: 'EMPLOYEE' },
      }),
    },
    organizationMembership: {
      findFirst: async ({ where }: any) =>
        where.userId === 'inactive'
          ? null
          : {
              id: 'member',
              ...where,
              status: 'ACTIVE',
              systemRole: 'EMPLOYEE',
              effectiveFrom: new Date('2020-01-01'),
              effectiveTo: null,
            },
    },
  };
  const composer = new BriefingComposer({
    prisma: prisma as never,
    modelEnabled: () => false,
    runtime: null,
    now: () => now,
  });
  assert.deepEqual(
    (await composer.people(now)).map((p) => p.userId),
    ['z-missing', 'a-served'],
  );
});
