// The connections worker CDK app, as a function so tests synthesize exactly what the CLI does.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import type * as ecs from 'aws-cdk-lib/aws-ecs';

import { ConnectionsStack, type StackProtection } from './connections-stack';
import { assertTargetCredentials, targetFor, type ConnectionsStage } from './target';

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

/** The browser origin the media bucket answers CORS for, per stage, when no `mediaOrigins` context is given. */
export const DEFAULT_MEDIA_ORIGINS: Readonly<Record<ConnectionsStage, readonly string[]>> = Object.freeze({
  staging: Object.freeze(['https://staging--emgloop2.netlify.app']),
  production: Object.freeze(['https://app.emgloop.com']),
});

/**
 * CDK context `mediaOrigins`: a comma-separated list of browser origins (scheme + host [+ port],
 * no path). Absent or blank means the stage's default web origin. A malformed entry fails synth
 * rather than deploying a CORS rule no browser would match.
 */
export function mediaOriginsFromContext(raw: unknown, defaults: readonly string[]): readonly string[] {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return defaults;
  if (typeof raw !== 'string') throw new Error('mediaOrigins must be a comma-separated string of origins');
  const origins = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (origins.length === 0) return defaults;
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

/** The monthly cost ceiling (USD) each stage gets when `monthlyBudgetUsd` context is not given. */
export const DEFAULT_MONTHLY_BUDGET_USD: Readonly<Record<ConnectionsStage, number>> = Object.freeze({ staging: 60, production: 150 });

/**
 * CDK context `alertEmail` and `monthlyBudgetUsd` -> the stack's cost budget and availability alarm.
 * The email is REQUIRED for production (a production stack without an alarm recipient is refused at
 * synth) and optional for staging (absent: no budget and no alarm, and the stack warns). The budget
 * is a whole number of US dollars, defaulting per stage.
 */
export function protectionFromContext(stage: ConnectionsStage, alertEmailRaw: unknown, budgetRaw: unknown): StackProtection | undefined {
  const email = typeof alertEmailRaw === 'string' ? alertEmailRaw.trim() : '';
  if (email === '') {
    if (stage === 'production') throw new Error('production requires CDK context alertEmail: the address the cost budget and the availability alarm notify');
    return undefined;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`alertEmail: "${email}" is not an email address`);
  let monthlyBudgetUsd = DEFAULT_MONTHLY_BUDGET_USD[stage];
  if (budgetRaw !== undefined && budgetRaw !== null && !(typeof budgetRaw === 'string' && budgetRaw.trim() === '')) {
    const n = typeof budgetRaw === 'number' ? budgetRaw : Number(String(budgetRaw).trim());
    if (!Number.isInteger(n) || n <= 0) throw new Error(`monthlyBudgetUsd: "${String(budgetRaw)}" must be a positive whole number of US dollars`);
    monthlyBudgetUsd = n;
  }
  return { alertEmail: email, monthlyBudgetUsd };
}

export function buildConnectionsApp(options: ConnectionsAppOptions): { app: App; stack: ConnectionsStack } {
  // `-c key=value` from the CLI reaches the App through its environment, not through this props
  // object, so the stage and its account are read from the App after construction. Nothing is
  // synthesized until app.synth(), so the credential check still runs before anything is compared.
  const app = new App({ context: { ...cdkJsonContext(), ...(options.context ?? {}) }, outdir: options.outdir });
  const target = targetFor(app.node.tryGetContext('stage'), { productionAccount: app.node.tryGetContext('productionAccount') });
  assertTargetCredentials(target, options.credentialAccount);
  const mediaOrigins = mediaOriginsFromContext(app.node.tryGetContext('mediaOrigins'), DEFAULT_MEDIA_ORIGINS[target.stage]);
  const protection = protectionFromContext(target.stage, app.node.tryGetContext('alertEmail'), app.node.tryGetContext('monthlyBudgetUsd'));

  // AI content triage is operator-activated and fail-closed: it is wired ONLY when the operator
  // supplies a real organization id via CDK context `aiOrganizationId` (the deploy workflow passes
  // it from the CONNECTIONS_<STAGE>_AI_ORG_ID environment variable). No org id is ever read from
  // cdk.json or hardcoded here. An empty/unset value leaves AI off. `aiOpenAiFallback` (context,
  // default off) opts the OpenAI fallback in; without it only the Anthropic primary is activated.
  const aiOrganizationId = app.node.tryGetContext('aiOrganizationId');
  const aiOpenAiFallback = app.node.tryGetContext('aiOpenAiFallback');
  const aiActivation =
    typeof aiOrganizationId === 'string' && aiOrganizationId.trim() !== ''
      ? { organizationId: aiOrganizationId, openAiFallback: aiOpenAiFallback === true || aiOpenAiFallback === 'true' }
      : undefined;

  const stack = new ConnectionsStack(app, target.stackName, {
    stage: target.stage,
    env: { account: target.account, region: target.region },
    image: options.image,
    assetsDir: options.assetsDir,
    mediaOrigins,
    terminationProtection: true,
    // A stack-level tag as well as the per-resource one the stack applies: CloudFormation
    // propagates this to what the CDK tag aspect cannot reach (CDK's own custom-resource provider).
    tags: { 'loop:stage': target.stage },
    description: `Loop connections worker (${target.stage}): Teams/Telegram durable observation worker`,
    ...(protection ? { protection } : {}),
    ...(aiActivation ? { aiActivation } : {}),
  });
  return { app, stack };
}
