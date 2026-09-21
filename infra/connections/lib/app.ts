// The connections worker CDK app, as a function so tests synthesize exactly what the CLI does.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import type * as ecs from 'aws-cdk-lib/aws-ecs';

import { ConnectionsStack } from './connections-stack';
import { CONNECTIONS_STAGING_TARGET, assertStagingCredentials } from './target';

export const CDK_JSON = join(__dirname, '..', 'cdk.json');

export function cdkJsonContext(): Record<string, unknown> {
  return (JSON.parse(readFileSync(CDK_JSON, 'utf8')) as { context: Record<string, unknown> }).context;
}

export interface ConnectionsAppOptions {
  /** The worker container image. bin/ builds it from the Dockerfile; tests inject a registry image. */
  readonly image: ecs.ContainerImage;
  readonly credentialAccount?: string;
  readonly context?: Record<string, unknown>;
  readonly outdir?: string;
}

export function buildConnectionsApp(options: ConnectionsAppOptions): { app: App; stack: ConnectionsStack } {
  assertStagingCredentials(options.credentialAccount);
  const app = new App({ context: { ...cdkJsonContext(), ...(options.context ?? {}) }, outdir: options.outdir });
  if (app.node.tryGetContext('stage') !== CONNECTIONS_STAGING_TARGET.stage) throw new Error('this deployable builds the staging environment only');

  // AI content triage is operator-activated and fail-closed: it is wired ONLY when the operator
  // supplies a real staging organization id via CDK context `aiOrganizationId` (the deploy workflow
  // passes it from the CONNECTIONS_STAGING_AI_ORG_ID environment variable). No org id is ever read
  // from cdk.json or hardcoded here. An empty/unset value leaves AI off. `aiOpenAiFallback` (context,
  // default off) opts the OpenAI fallback in; without it only the Anthropic primary is activated.
  const aiOrganizationId = app.node.tryGetContext('aiOrganizationId');
  const aiOpenAiFallback = app.node.tryGetContext('aiOpenAiFallback');
  const aiActivation =
    typeof aiOrganizationId === 'string' && aiOrganizationId.trim() !== ''
      ? { organizationId: aiOrganizationId, openAiFallback: aiOpenAiFallback === true || aiOpenAiFallback === 'true' }
      : undefined;

  const stack = new ConnectionsStack(app, CONNECTIONS_STAGING_TARGET.stackName, {
    stage: CONNECTIONS_STAGING_TARGET.stage,
    env: { account: CONNECTIONS_STAGING_TARGET.account, region: CONNECTIONS_STAGING_TARGET.region },
    image: options.image,
    terminationProtection: true,
    description: 'Loop connections worker (staging): Teams/Telegram durable observation worker',
    ...(aiActivation ? { aiActivation } : {}),
  });
  return { app, stack };
}
