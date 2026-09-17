// Doorbell authorizer (HTTP API, payload 2.0, simple responses, no caching). Slice B6.
//
// Reads pinned public keys and trusted names from Parameter Store and records the token
// id once in the replay table. No database, no queue, no secret.

import type { APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda';
import { authorizeRing, jsonLogger, parseNameList, pinnedKeysFromJson, BRAIN_EXECUTOR_REVISION } from '@emgloop/brain-executor';

import { DynamoReplayLedger } from '../src/aws/replay';
import { cachedParameter, requiredEnv } from '../src/config';

const prefix = requiredEnv('BRAIN_PARAMETER_PREFIX');
const publicKeys = cachedParameter(`${prefix}/doorbell/public-keys`, 60_000);
const issuers = cachedParameter(`${prefix}/doorbell/trusted-issuers`, 60_000);
const callers = cachedParameter(`${prefix}/doorbell/trusted-callers`, 60_000);
const replay = new DynamoReplayLedger(requiredEnv('BRAIN_REPLAY_TABLE'));

export async function handler(event: APIGatewayRequestAuthorizerEventV2): Promise<{ isAuthorized: boolean; context?: Record<string, string | number> }> {
  const log = jsonLogger({ component: 'authorizer', revision: BRAIN_EXECUTOR_REVISION, correlationId: event.requestContext?.requestId ?? null });
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  const out = await authorizeRing(header, {
    trust: { keys: pinnedKeysFromJson((await publicKeys()) ?? ''), trustedIssuers: parseNameList(await issuers()), trustedCallers: parseNameList(await callers()) },
    replay,
    nowSeconds: Math.floor(Date.now() / 1000),
    log,
  });
  if (!out.authorized) return { isAuthorized: false };
  const c = out.claims;
  return {
    isAuthorized: true,
    context: { iss: c.iss, sub: c.sub, aud: JSON.stringify(c.aud), scope: c.scope, jti: c.jti, iat: c.iat, exp: c.exp },
  };
}
