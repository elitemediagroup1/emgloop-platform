// Sweeper: scheduled recovery of lost rings, expired questions and stale leases. Slice B6.
//
// Connects to Neon as `loop_brain_sweeper`, which can only read. Lost commands go to the
// dispatcher; everything else goes to the durable queue as a reference.

import { BrainExecutionReferences } from '@emgloop/database/src/repositories/brain/brain-execution-references';
import { jsonLogger, sweep, BRAIN_EXECUTOR_REVISION } from '@emgloop/brain-executor';

import { LambdaDispatcherInvoker } from '../src/aws/invoker';
import { SqsWorkQueues } from '../src/aws/queues';
import { requiredEnv } from '../src/config';
import { databaseUrl, prismaFor } from '../src/database';

const dispatcher = new LambdaDispatcherInvoker(requiredEnv('BRAIN_DISPATCHER_FUNCTION'));
const queues = new SqsWorkQueues({ DURABLE: requiredEnv('BRAIN_DURABLE_QUEUE_URL') });
const databaseSecret = requiredEnv('BRAIN_DATABASE_SECRET');

export async function handler(): Promise<{ recovered: number; timers: number; takeovers: number; errors: number }> {
  const log = jsonLogger({ component: 'sweeper', revision: BRAIN_EXECUTOR_REVISION });
  const refs = new BrainExecutionReferences(prismaFor(await databaseUrl(databaseSecret)));
  return sweep({ refs, dispatcher, queues, now: () => new Date(), log });
}
