// The Brain CDK app, as a function so tests synthesize exactly what the CLI does. Slice B6.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';

import { BrainStack } from './brain-stack';
import { BRAIN_STAGING_TARGET, assertStagingCredentials } from './target';

export const CDK_JSON = join(__dirname, '..', 'cdk.json');

/** The context `cdk.json` gives the CLI: the stage and the pinned feature flags. */
export function cdkJsonContext(): Record<string, unknown> {
  return (JSON.parse(readFileSync(CDK_JSON, 'utf8')) as { context: Record<string, unknown> }).context;
}

export interface BrainAppOptions {
  /** Where `npm run bundle` wrote the function bundles. */
  readonly assetsDir: string;
  /** CDK_DEFAULT_ACCOUNT, as the CLI resolved it from the active credentials. */
  readonly credentialAccount?: string;
  /** Extra context (for example alarmEmail); the cdk.json context always applies. */
  readonly context?: Record<string, unknown>;
  readonly outdir?: string;
}

export function buildBrainApp(options: BrainAppOptions): { app: App; stack: BrainStack } {
  assertStagingCredentials(options.credentialAccount);
  const app = new App({ context: { ...cdkJsonContext(), ...(options.context ?? {}) }, outdir: options.outdir });
  if (app.node.tryGetContext('stage') !== BRAIN_STAGING_TARGET.stage) throw new Error('B6 builds the staging environment only');
  const budget = app.node.tryGetContext('monthlyBudgetUsd');
  const stack = new BrainStack(app, BRAIN_STAGING_TARGET.stackName, {
    stage: BRAIN_STAGING_TARGET.stage,
    env: { account: BRAIN_STAGING_TARGET.account, region: BRAIN_STAGING_TARGET.region },
    assetsDir: options.assetsDir,
    alarmEmail: app.node.tryGetContext('alarmEmail') || undefined,
    budgetEmail: app.node.tryGetContext('budgetEmail') || undefined,
    monthlyBudgetUsd: budget === undefined || budget === '' ? 25 : Number(budget),
    terminationProtection: true,
    description: `Loop Brain execution environment (${BRAIN_STAGING_TARGET.stage}, dark)`,
  });
  return { app, stack };
}
