// Worker: one SQS record = one advance of one job. Slice B6.
//
// Connects to Neon as `loop_brain_worker`, signs its requests to Loop with the key
// service, seals checkpoints with the checkpoint secret. Revision 1 is dark: it reads no
// provider secret and has no provider client.

import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { AI_TASKS } from '@emgloop/shared';
import { BrainExecutorStore } from '@emgloop/database/src/services/brain/brain-executor-store';
import {
  advanceJob,
  createLoopClient,
  jsonLogger,
  parseAiFloor,
  parseSwitch,
  MalformedAdvanceMessage,
  RetryDelivery,
  BRAIN_EXECUTOR_REVISION,
} from '@emgloop/brain-executor';

import { SqsWorkQueues } from '../src/aws/queues';
import { SecretsSealerSource } from '../src/aws/sealers';
import { KmsEs256Signer } from '../src/aws/signer';
import { cachedParameter, requiredEnv } from '../src/config';
import { databaseUrl, prismaFor } from '../src/database';

/** Longer than the function timeout (120 s), so a live worker is never taken over. */
const LEASE_MS = 150_000;

const prefix = requiredEnv('BRAIN_PARAMETER_PREFIX');
const enabled = cachedParameter(`${prefix}/worker/enabled`, 5_000);
const floor = cachedParameter(`${prefix}/ai/floor`, 5_000);
const loopBase = cachedParameter(`${prefix}/loop/internal-base-url`, 60_000);
const keyLabel = cachedParameter(`${prefix}/worker/key-id`, 60_000);
const queues = new SqsWorkQueues({ INTERACTIVE: requiredEnv('BRAIN_INTERACTIVE_QUEUE_URL'), DURABLE: requiredEnv('BRAIN_DURABLE_QUEUE_URL') });
const sealers = new SecretsSealerSource(requiredEnv('BRAIN_CHECKPOINT_SECRET'));
const databaseSecret = requiredEnv('BRAIN_DATABASE_SECRET');
const signingKeyArn = requiredEnv('BRAIN_SIGNING_KEY_ARN');
const issuer = requiredEnv('BRAIN_WORKER_ISSUER');
const subject = requiredEnv('BRAIN_WORKER_SUBJECT');

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];
  const store = new BrainExecutorStore(prismaFor(await databaseUrl(databaseSecret)));
  const signer = new KmsEs256Signer((await keyLabel()) ?? 'UNSET', signingKeyArn);
  const loop = createLoopClient({ baseUrl: (await loopBase()) ?? 'UNSET', issuer, subject }, { signer });
  for (const record of event.Records) {
    const log = jsonLogger({ component: 'worker', revision: BRAIN_EXECUTOR_REVISION, mode: 'DARK', correlationId: context.awsRequestId, messageId: record.messageId });
    let body: unknown;
    try {
      body = JSON.parse(record.body);
    } catch {
      body = null;
    }
    try {
      await advanceJob(body, {
        store,
        loop,
        sealers,
        queues,
        switches: { workerEnabled: async () => parseSwitch(await enabled()), aiFloor: async () => parseAiFloor(await floor()) },
        tasks: AI_TASKS,
        holder: `${context.functionName}/${context.awsRequestId}`,
        leaseMs: LEASE_MS,
        now: () => new Date(),
        log,
        mode: 'DARK',
      });
    } catch (err) {
      const code = err instanceof MalformedAdvanceMessage ? 'MALFORMED' : err instanceof RetryDelivery ? err.code : 'UNEXPECTED';
      log.error('worker.delivery_failed', { outcome: 'REDELIVER', failureClass: code.slice(0, 64).replace(/[^A-Z0-9_]/gi, '_').toUpperCase() });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
