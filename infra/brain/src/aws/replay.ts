// The runner's ports, bound to AWS: the DynamoDB replay ledger. Slice B6.

import { ConditionalCheckFailedException, DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { BrainReplayLedger } from '@emgloop/brain-executor';

export class DynamoReplayLedger implements BrainReplayLedger {
  constructor(
    private readonly table: string,
    private readonly client: Pick<DynamoDBClient, 'send'> = new DynamoDBClient({}),
  ) {}

  async recordOnce(tokenId: string, expiresAtSeconds: number): Promise<boolean> {
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.table,
          Item: { jti: { S: tokenId }, expiresAt: { N: String(Math.trunc(expiresAtSeconds)) } },
          ConditionExpression: 'attribute_not_exists(jti)',
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException || (err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  }
}
