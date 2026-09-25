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

/** The providers the worker can be given a key for. Listing one makes it callable, never approved. */
export const AI_PROVIDERS = Object.freeze(['anthropic', 'openai'] as const);
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** What `aiProviders` / `aiTasks` mean when unset or empty: the Anthropic primary, Telegram content triage. */
export const DEFAULT_AI_PROVIDERS: readonly AiProvider[] = Object.freeze(['anthropic']);
export const DEFAULT_AI_TASKS: readonly string[] = Object.freeze(['telegram.content.triage']);

const AI_TASK_ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

/** A comma-separated context list: undefined when unset or blank (the caller's default applies). */
function contextList(key: string, raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return undefined;
  if (typeof raw !== 'string') throw new Error(`${key} must be a comma-separated string`);
  const items = raw.split(',').map((s) => s.trim());
  if (items.some((s) => s === '')) throw new Error(`${key}: "${raw}" has an empty entry`);
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) throw new Error(`${key}: "${item}" is listed twice`);
    seen.add(item);
  }
  return items;
}

/**
 * CDK context `aiProviders`: the providers the worker is given a key for, in order (the order is the
 * worker's preference). Only `anthropic` and `openai`; unset or blank means `anthropic`. An unknown
 * or repeated provider fails synth rather than deploying a list the worker would half-honour.
 * (This replaced the boolean `aiOpenAiFallback`, which no workflow ever passed.)
 */
export function aiProvidersFromContext(raw: unknown): readonly AiProvider[] {
  const items = contextList('aiProviders', raw);
  if (items === undefined) return DEFAULT_AI_PROVIDERS;
  for (const item of items) {
    if (!(AI_PROVIDERS as readonly string[]).includes(item)) throw new Error(`aiProviders: "${item}" is not one of ${AI_PROVIDERS.join(', ')}`);
  }
  return items as AiProvider[];
}

/**
 * CDK context `aiTasks`: the task ids the worker runs (dotted lowercase, e.g. telegram.content.triage).
 * Unset or blank means `telegram.content.triage`. A malformed or repeated id fails synth.
 */
export function aiTasksFromContext(raw: unknown): readonly string[] {
  const items = contextList('aiTasks', raw);
  if (items === undefined) return DEFAULT_AI_TASKS;
  for (const item of items) {
    if (!AI_TASK_ID.test(item)) throw new Error(`aiTasks: "${item}" is not a task id (dotted lowercase, e.g. telegram.content.triage)`);
  }
  return items;
}

/**
 * The PR 1 synth guard (a provider not verified against triage schema v4 refused beside
 * telegram.content.triage) RETIRED with that schema in Chats v5 (Loop Intelligence Phase B, 2026-09-26):
 * triage schema v5 is portable, so no provider is ineligible for it. Which providers may actually serve
 * a task is still decided at run time by the recorded provider policy, the worker's activation and the
 * routing policy -- listing a provider here does not commission it. An infra test checks the shared
 * exemption list and the providers' verified-provider policy are both empty, so a new exemption cannot
 * appear without a guard coming back.
 */

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
  // cdk.json or hardcoded here. An empty/unset value leaves AI off, whatever the lists below say.
  // Which providers the worker may call and which tasks it runs come from `aiProviders` and
  // `aiTasks` (CONNECTIONS_<STAGE>_AI_PROVIDERS / _AI_TASKS); unset or empty means the defaults.
  const aiOrganizationId = app.node.tryGetContext('aiOrganizationId');
  const aiProviders = aiProvidersFromContext(app.node.tryGetContext('aiProviders'));
  const aiTasks = aiTasksFromContext(app.node.tryGetContext('aiTasks'));
  const aiActivation =
    typeof aiOrganizationId === 'string' && aiOrganizationId.trim() !== ''
      ? { organizationId: aiOrganizationId, providers: aiProviders, tasks: aiTasks }
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
