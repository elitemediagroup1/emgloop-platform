// A test world for the runner: the in-memory Prisma double, real Brain repositories and
// services, an in-process Loop internal API that applies the same checks as the web
// routes, a key-service stand-in, in-memory queues and a replay ledger. No network, no
// provider, no cloud.

import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign as nodeSign, type KeyObject } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  AI_TASK_CASE_EXPLANATION,
  type AiControlFloor,
  type AiRoutingPolicy,
  type AiTaskDefinition,
  type BrainAdvanceMessage,
  type BrainWorkerPurpose,
} from '@emgloop/shared';
import { AI_PROVIDER_SPECIALIZATION_POLICY, AI_ROUTING_POLICY } from '@emgloop/providers';

import { makeCognitivePrisma } from '../../../packages/database/test/helpers/cognitive-prisma-fake';
import { IamRepository } from '../../../packages/database/src/repositories/iam.repository';
import { AiControlRepository } from '../../../packages/database/src/repositories/brain/ai-control.repository';
import { BrainJobRepository } from '../../../packages/database/src/repositories/brain/brain-job.repository';
import { BrainExecutionReferences } from '../../../packages/database/src/repositories/brain/brain-execution-references';
import { iamAiAuthorizer } from '../../../packages/database/src/services/ai-runtime/authorizer';
import { BrainWorkService, type BrainWorkPrincipal } from '../../../packages/database/src/services/brain/brain-work.service';
import { BrainExecutorStore } from '../../../packages/database/src/services/brain/brain-executor-store';
import { BrainInternalService, type BrainContextAssembler, type BrainResultOwnerGate, type BrainTaskContext } from '../../../packages/database/src/services/brain/brain-internal.service';
import { AesGcmBrainPayloadSealer } from '../../../packages/database/src/services/brain/brain-payload-sealer';
import { brainSubjectHref, type BrainSubjectResolver } from '../../../packages/database/src/services/brain/brain-subjects';

import { memoryLogger, type BrainLogger } from '../src/log';
import type { Es256Signer } from '../src/jws';
import { loopStandIn, WORKER_ISSUER, WORKER_SUBJECT } from './loop-stand-in';
import { createLoopClient } from '../src/loop-client';
import type { BrainQueueName, BrainReplayLedger, BrainWorkQueues } from '../src/ports';
import type { BrainSealerSource, BrainWorkerDeps } from '../src/worker';

export const ORG = 'org_exec_a';
export const OTHER = 'org_exec_b';
export const T0 = new Date('2026-09-20T12:00:00.000Z');

/** A durable task that may ask a question. Test-only: the product registers none yet. */
export const REVIEW: AiTaskDefinition = Object.freeze({
  ...AI_TASK_CASE_EXPLANATION,
  taskId: 'test.relationship-review',
  version: '1.0.0',
  resultOwner: Object.freeze({ authority: 'RELATIONSHIPS', subjectType: 'RELATIONSHIP' } as const),
  execution: Object.freeze({
    classes: Object.freeze(['INTERACTIVE', 'DURABLE'] as const),
    interactive: Object.freeze({ presentationBudgetMs: 10_000, executionDeadlineMs: 30_000, streaming: 'NONE' } as const),
    durable: Object.freeze({ executionDeadlineMs: 3_600_000, maxUserWaitMs: 86_400_000 }),
  }),
  invokerRoles: Object.freeze(['OWNER', 'ADMIN', 'MANAGER']),
  outputSchemaId: 'relationship-review.v1',
}) as AiTaskDefinition;
export const TASKS = [AI_TASK_CASE_EXPLANATION, REVIEW];

export const ROUTING: AiRoutingPolicy = {
  version: AI_ROUTING_POLICY.version,
  tasks: { ...AI_ROUTING_POLICY.tasks, [REVIEW.taskId]: { ...AI_ROUTING_POLICY.tasks['case.explanation']!, taskId: REVIEW.taskId, taskVersion: REVIEW.version } },
};
const PRIMARY = AI_ROUTING_POLICY.tasks['case.explanation']!.primary.providerId;
export const FLOOR_ON: AiControlFloor = {
  activation: { enabled: true, organizations: [ORG, OTHER], tasks: TASKS.map((t) => t.taskId), providers: [PRIMARY] },
  killSwitches: [],
};

export const SUBJECTS: Record<string, Record<string, string>> = {
  [ORG]: { CASE: 'case_exec_0001', RELATIONSHIP: 'rel_exec_0001' },
  [OTHER]: { CASE: 'case_exec_0009', RELATIONSHIP: 'rel_exec_0009' },
};

export { WORKER_ISSUER, WORKER_SUBJECT } from './loop-stand-in';
export const WORKER_KID = 'worker-test-1';

/** A key-service stand-in: returns DER signatures, as the real one does. */
export function testSigner(kid = WORKER_KID): Es256Signer & { readonly publicKey: KeyObject; calls: number } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signer = {
    keyId: kid,
    publicKey,
    calls: 0,
    async sign(input: Uint8Array) {
      signer.calls += 1;
      return new Uint8Array(nodeSign('sha256', input, { key: privateKey, dsaEncoding: 'der' }));
    },
  };
  return signer;
}

export function memoryQueues(): BrainWorkQueues & { readonly sent: { queue: BrainQueueName; message: BrainAdvanceMessage; delaySeconds: number }[]; take(): { queue: BrainQueueName; message: BrainAdvanceMessage } | undefined } {
  const sent: { queue: BrainQueueName; message: BrainAdvanceMessage; delaySeconds: number }[] = [];
  let n = 0;
  return {
    sent,
    async send(queue, message, options = {}) {
      sent.push({ queue, message, delaySeconds: options.delaySeconds ?? 0 });
      n += 1;
      return { messageId: `msg-${n}` };
    },
    take() {
      return sent.shift();
    },
  };
}

export function memoryReplay(): BrainReplayLedger & { readonly seen: Map<string, number> } {
  const seen = new Map<string, number>();
  return {
    seen,
    async recordOnce(tokenId, expiresAt) {
      if (seen.has(tokenId)) return false;
      seen.set(tokenId, expiresAt);
      return true;
    },
  };
}

export function contextFor(job: { organizationId: string; principalUserId: string; taskId: string }, ref = `relationship:${SUBJECTS[ORG]!.RELATIONSHIP}`): BrainTaskContext {
  return {
    package: {
      organizationId: job.organizationId,
      viewerUserId: job.principalUserId,
      taskId: job.taskId,
      sensitivityCeiling: 'OPERATIONAL',
      items: [
        {
          blockId: `${job.organizationId}::summary`,
          kind: 'STRUCTURED',
          trust: 'GOVERNED_FACT',
          sourceRef: ref,
          content: 'SECRET-CONTEXT-CONTENT settlements stopped',
          sensitivity: 'OPERATIONAL',
          readUnder: { resource: 'commercialIntelligence', action: 'view' },
        },
      ],
    },
    supplied: [{ ref, trust: 'GOVERNED_FACT' }],
    support: {},
    withheld: { notes: 2 },
  };
}

export interface WorldOptions {
  readonly contexts?: Record<string, BrainContextAssembler>;
  readonly owners?: readonly BrainResultOwnerGate[];
}

export async function world(options: WorldOptions = {}) {
  const fake: any = makeCognitivePrisma({
    also: [
      'organization',
      'invitation',
      'organizationMembership',
      'permission',
      'aiInvocation',
      'brainJob',
      'brainJobTransition',
      'brainJobStep',
      'brainJobWait',
      'brainCommand',
      'brainEvent',
      'aiControl',
      'aiControlCurrent',
    ],
  });
  let seq = 0;
  for (const name of ['brainJob', 'brainCommand']) {
    const create = fake[name].create.bind(fake[name]);
    fake[name].create = ({ data, ...rest }: { data: Record<string, unknown> }) =>
      create({ data: { id: `c${name.slice(5, 8).toLowerCase()}${String(++seq).padStart(20, '0')}`, ...data }, ...rest });
  }
  fake.organization.__rows.push({ id: ORG, name: 'A', timezone: 'UTC' }, { id: OTHER, name: 'B', timezone: 'UTC' });
  const prisma = fake as PrismaClient;
  const iam = new IamRepository(prisma);
  const hire = async (role: string, org = ORG): Promise<BrainWorkPrincipal> => {
    const u = await iam.createUser({ organizationId: org, email: `${role.toLowerCase()}-${++seq}@exec.test`, systemRole: role, name: role });
    await iam.activateUser(org, u.id);
    return { organizationId: org, userId: u.id };
  };
  const people = { owner: await hire('OWNER'), manager: await hire('MANAGER'), outsider: await hire('OWNER', OTHER) };

  const controls = new AiControlRepository(prisma);
  for (const [scope, value] of [
    ['GLOBAL', null],
    ['TASK', AI_TASK_CASE_EXPLANATION.taskId],
    ['TASK', REVIEW.taskId],
    ['PROVIDER', PRIMARY],
  ] as const) {
    const out = await controls.recordPlatformControl({ scope, value, state: 'ACTIVE', reason: 'test', expectedVersion: 0, operationsReference: 'test-1', now: T0 });
    assert.equal(out.ok, true);
  }
  for (const [org, actor] of [
    [ORG, people.owner.userId],
    [OTHER, people.outsider.userId],
  ] as const) {
    assert.equal((await controls.recordOrganizationControl(org, { scope: 'ORGANIZATION', state: 'ACTIVE', reason: 'test', expectedVersion: 0, actorUserId: actor, now: T0 })).ok, true);
  }

  let clockMs = T0.getTime();
  const now = () => new Date(clockMs);
  const subjects: BrainSubjectResolver = {
    async exists(organizationId, subject) {
      return SUBJECTS[organizationId]?.[subject.type] === subject.id;
    },
    href: brainSubjectHref,
  };
  const rings: string[] = [];
  const work = new BrainWorkService(prisma, {
    authorize: iamAiAuthorizer(prisma),
    controlFloor: () => FLOOR_ON,
    routing: ROUTING,
    specialization: AI_PROVIDER_SPECIALIZATION_POLICY,
    tasks: TASKS,
    subjects,
    ring: async (commandId) => {
      rings.push(commandId);
      return 'RUNG';
    },
    now,
  });

  const assembled: string[] = [];
  const defaultAssembler: BrainContextAssembler = async ({ job }) => {
    assembled.push(job.jobId);
    return contextFor(job);
  };
  const internal = new BrainInternalService(prisma, {
    authorize: iamAiAuthorizer(prisma),
    tasks: TASKS,
    contexts: options.contexts ?? { [REVIEW.taskId]: defaultAssembler, 'case.explanation': defaultAssembler },
    owners: options.owners ?? [],
    readInput: (o, j) => new BrainJobRepository(prisma).input(o, j),
    now,
  });

  const signer = testSigner();
  const trustedKeys = new Map<string, KeyObject>([[WORKER_KID, signer.publicKey]]);
  const loopCalls: { purpose: BrainWorkerPurpose; status: number }[] = [];
  let loopDown = false;
  const loopFetch = loopStandIn({
    prisma,
    internal,
    keys: trustedKeys,
    nowSeconds: () => Math.floor(clockMs / 1000),
    calls: loopCalls,
    isDown: () => loopDown,
  });

  const loop = createLoopClient(
    { baseUrl: 'http://127.0.0.1:3999', issuer: WORKER_ISSUER, subject: WORKER_SUBJECT },
    { signer, fetch: loopFetch, nowSeconds: () => Math.floor(clockMs / 1000) },
  );

  const key = randomBytes(32);
  const sealer = new AesGcmBrainPayloadSealer('test/checkpoint-key:v1', key);
  const sealers: BrainSealerSource = {
    async current() {
      return sealer;
    },
    async forKeyRef(keyRef) {
      return keyRef === 'test/checkpoint-key:v1' ? sealer : null;
    },
  };

  const queues = memoryQueues();
  const store = new BrainExecutorStore(prisma);
  const log = memoryLogger({ component: 'worker', revision: 'test' });
  const switches = { enabled: true, floor: FLOOR_ON as AiControlFloor };
  const workerDeps = (holder = 'worker-a', overrides: Partial<BrainWorkerDeps> = {}): BrainWorkerDeps => ({
    store,
    loop,
    sealers,
    queues,
    switches: { workerEnabled: async () => switches.enabled, aiFloor: async () => switches.floor },
    tasks: TASKS,
    holder,
    leaseMs: 60_000,
    now,
    log,
    mode: 'DARK',
    ...overrides,
  });

  return {
    fake,
    prisma,
    iam,
    people,
    controls,
    work,
    internal,
    store,
    refs: new BrainExecutionReferences(prisma),
    queues,
    rings,
    assembled,
    loopCalls,
    signer,
    trustedKeys,
    log: log as BrainLogger & { lines: Record<string, unknown>[] },
    switches,
    workerDeps,
    now,
    advance: (ms: number) => {
      clockMs += ms;
    },
    setLoopDown: (down: boolean) => {
      loopDown = down;
    },
    jobs: new BrainJobRepository(prisma),
  };
}

export type World = Awaited<ReturnType<typeof world>>;

export const reviewSubmission = (over: Record<string, unknown> = {}) => ({
  taskId: REVIEW.taskId,
  subject: { type: 'RELATIONSHIP', id: SUBJECTS[ORG]!.RELATIONSHIP },
  executionClass: 'DURABLE',
  idempotencyKey: 'idem-exec-0001',
  input: { horizonDays: 90 },
  ...over,
});

export const caseSubmission = (over: Record<string, unknown> = {}) => ({
  taskId: 'case.explanation',
  subject: { type: 'CASE', id: SUBJECTS[ORG]!.CASE },
  executionClass: 'INTERACTIVE',
  idempotencyKey: 'idem-exec-case-1',
  input: {},
  ...over,
});
