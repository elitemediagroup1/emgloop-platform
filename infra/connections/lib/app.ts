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
  /** Where `npm run bundle` wrote the function bundles; tests stub it. */
  readonly assetsDir: string;
  readonly credentialAccount?: string;
  readonly context?: Record<string, unknown>;
  readonly outdir?: string;
}

/** The browser origin the media bucket answers CORS for when no `mediaOrigins` context is given. */
export const DEFAULT_MEDIA_ORIGINS: readonly string[] = Object.freeze(['https://staging--emgloop2.netlify.app']);

/**
 * CDK context `mediaOrigins`: a comma-separated list of browser origins (scheme + host [+ port],
 * no path). Absent or blank means the staging web origin. A malformed entry fails synth rather
 * than deploying a CORS rule no browser would match.
 */
export function mediaOriginsFromContext(raw: unknown): readonly string[] {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return DEFAULT_MEDIA_ORIGINS;
  if (typeof raw !== 'string') throw new Error('mediaOrigins must be a comma-separated string of origins');
  const origins = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (origins.length === 0) return DEFAULT_MEDIA_ORIGINS;
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`mediaOrigins: "${origin}" is not a URL`);
    }
    if (parsed.origin !== origin || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      throw new Error(`mediaOrigins: "${origin}" must be a bare http(s) origin (no path, no trailing slash)`);
    }
  }
  return origins;
}

export function buildConnectionsApp(options: ConnectionsAppOptions): { app: App; stack: ConnectionsStack } {
  assertStagingCredentials(options.credentialAccount);
  const app = new App({ context: { ...cdkJsonContext(), ...(options.context ?? {}) }, outdir: options.outdir });
  if (app.node.tryGetContext('stage') !== CONNECTIONS_STAGING_TARGET.stage) throw new Error('this deployable builds the staging environment only');
  const mediaOrigins = mediaOriginsFromContext(app.node.tryGetContext('mediaOrigins'));

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
    assetsDir: options.assetsDir,
    mediaOrigins,
    terminationProtection: true,
    description: 'Loop connections worker (staging): Teams/Telegram durable observation worker',
    ...(aiActivation ? { aiActivation } : {}),
  });
  return { app, stack };
}
