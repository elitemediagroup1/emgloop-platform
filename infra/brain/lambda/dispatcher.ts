// Dispatcher: a ring (after the authorizer) or a sweeper hand-over -> a queued reference. Slice B6.
//
// Connects to Neon as `loop_brain_dispatcher`: it can read commands, jobs and waits and
// record a dispatch, and nothing else.

import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { BrainDoorbellClaims } from '@emgloop/shared';
import { BrainExecutorStore } from '@emgloop/database/src/services/brain/brain-executor-store';
import { dispatch, jsonLogger, parseNameList, BRAIN_EXECUTOR_REVISION } from '@emgloop/brain-executor';

import { SqsWorkQueues } from '../src/aws/queues';
import { cachedParameter, requiredEnv } from '../src/config';
import { databaseUrl, prismaFor } from '../src/database';
import { DISPATCHER_RECOVERY_SOURCE } from '../src/recovery';

type RingContext = Record<string, string | number>;
type RecoveryEvent = { readonly source: string; readonly kind: string; readonly commandId: string };

const prefix = requiredEnv('BRAIN_PARAMETER_PREFIX');
const issuers = cachedParameter(`${prefix}/doorbell/trusted-issuers`, 60_000);
const callers = cachedParameter(`${prefix}/doorbell/trusted-callers`, 60_000);
const queues = new SqsWorkQueues({ INTERACTIVE: requiredEnv('BRAIN_INTERACTIVE_QUEUE_URL'), DURABLE: requiredEnv('BRAIN_DURABLE_QUEUE_URL') });
const databaseSecret = requiredEnv('BRAIN_DATABASE_SECRET');

function claimsFrom(context: RingContext | undefined): BrainDoorbellClaims | null {
  if (!context) return null;
  let aud: unknown;
  try {
    aud = JSON.parse(String(context.aud));
  } catch {
    return null;
  }
  return {
    iss: String(context.iss),
    sub: String(context.sub),
    aud: aud as string | readonly string[],
    scope: String(context.scope),
    jti: String(context.jti),
    iat: Number(context.iat),
    exp: Number(context.exp),
  };
}

function isRecovery(event: unknown): event is RecoveryEvent {
  const e = event as Partial<RecoveryEvent> | null;
  return !!e && e.source === DISPATCHER_RECOVERY_SOURCE && e.kind === 'RECOVERY' && typeof e.commandId === 'string';
}

export async function handler(
  event: APIGatewayProxyEventV2WithLambdaAuthorizer<RingContext> | RecoveryEvent,
): Promise<APIGatewayProxyStructuredResultV2 | { outcome: string }> {
  const correlationId = 'requestContext' in event ? event.requestContext.requestId : null;
  const log = jsonLogger({ component: 'dispatcher', revision: BRAIN_EXECUTOR_REVISION, correlationId });
  const store = new BrainExecutorStore(prismaFor(await databaseUrl(databaseSecret)));
  const deps = {
    store,
    queues,
    trust: { trustedIssuers: parseNameList(await issuers()), trustedCallers: parseNameList(await callers()) },
    now: () => new Date(),
    log,
  };
  if (isRecovery(event)) return { outcome: await dispatch({ kind: 'RECOVERY', commandId: event.commandId }, deps) };
  if (!('requestContext' in event) || !event.requestContext?.http) throw new Error('unrecognized event');
  const claims = claimsFrom(event.requestContext.authorizer?.lambda);
  if (!claims) return { statusCode: 401, body: '' };
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  const outcome = await dispatch({ kind: 'RING', claims, rawBody: raw }, deps);
  // After authentication the caller learns only whether the ring was well formed.
  return outcome === 'BAD_REQUEST'
    ? { statusCode: 400, headers: { 'content-type': 'application/json' }, body: '{"received":false}' }
    : { statusCode: 202, headers: { 'content-type': 'application/json' }, body: '{"received":true}' };
}
