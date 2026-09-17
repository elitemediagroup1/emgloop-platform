// The runner's ports, bound to AWS: SQS work queues. Slice B6.

import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { BrainQueueName, BrainWorkQueues } from '@emgloop/brain-executor';

export class SqsWorkQueues implements BrainWorkQueues {
  constructor(
    private readonly urls: Partial<Record<BrainQueueName, string>>,
    private readonly client: Pick<SQSClient, 'send'> = new SQSClient({}),
  ) {}

  async send(queue: BrainQueueName, message: Parameters<BrainWorkQueues['send']>[1], options: { readonly delaySeconds?: number } = {}) {
    const url = this.urls[queue];
    if (!url) throw new Error(`no ${queue} queue configured`);
    const out = await this.client.send(
      new SendMessageCommand({ QueueUrl: url, MessageBody: JSON.stringify(message), DelaySeconds: Math.max(0, Math.min(900, Math.trunc(options.delaySeconds ?? 0))) }),
    );
    return { messageId: out.MessageId ?? 'unknown' };
  }
}
