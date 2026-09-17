// The runner's ports, bound to AWS: the sweeper's hand-over to the dispatcher. Slice B6.

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { BrainDispatcherInvoker } from '@emgloop/brain-executor';

import { DISPATCHER_RECOVERY_SOURCE } from '../recovery';

/** Hands a lost command to the dispatcher, asynchronously. */
export class LambdaDispatcherInvoker implements BrainDispatcherInvoker {
  constructor(
    private readonly functionName: string,
    private readonly client: Pick<LambdaClient, 'send'> = new LambdaClient({}),
  ) {}

  async recover(commandId: string): Promise<void> {
    await this.client.send(
      new InvokeCommand({
        FunctionName: this.functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ source: DISPATCHER_RECOVERY_SOURCE, kind: 'RECOVERY', commandId })),
      }),
    );
  }
}
