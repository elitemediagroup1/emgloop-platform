// Where a connections worker stack may go. Pinned like the Brain stack: the account and region are
// fixed here, not taken from whatever credentials are active, so a stack cannot land in the
// management account by mistake.
//
// Two stages, one architecture:
//   - staging:    Loop Brain Staging (065148797865), pinned below (authorized 2026-09-20).
//   - production: a DEDICATED workload account that does not exist yet (design approved 2026-09-24),
//                 so its id is not in source. It arrives as CDK context `productionAccount` and is
//                 refused unless it is a 12-digit id that is neither the management account nor the
//                 staging account. The management account is governance-only and is never a target.

export type ConnectionsStage = 'staging' | 'production';

export interface ConnectionsTarget {
  readonly accountName: string;
  readonly account: string;
  readonly region: string;
  readonly stackName: string;
  readonly stage: ConnectionsStage;
  readonly bootstrapQualifier: string;
}

/** The AWS Organization's management account: governance only, refused as a deploy target. */
export const MANAGEMENT_ACCOUNT = '670682108352';

/** Both stages live in us-east-1; the stack's availability-zone pin depends on it. */
export const CONNECTIONS_REGION = 'us-east-1';

export const CONNECTIONS_STAGING_TARGET = Object.freeze({
  accountName: 'Loop Brain Staging',
  account: '065148797865',
  region: 'us-east-1',
  stackName: 'LoopConnections-staging',
  stage: 'staging' as const,
  bootstrapQualifier: 'hnb659fds',
});

export class WrongTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WrongTargetError';
  }
}

/**
 * The production target, from the account id the operator supplies (CDK context `productionAccount`,
 * set by the deploy workflow from the connections-production environment variable
 * CONNECTIONS_PRODUCTION_ACCOUNT_ID). Fails closed: absent, malformed, or one of the two accounts
 * that must never host production, and no target is produced.
 */
export function productionTarget(productionAccount: unknown): ConnectionsTarget {
  if (typeof productionAccount !== 'string' || !/^\d{12}$/.test(productionAccount)) {
    throw new Error('production requires CDK context productionAccount: the 12-digit id of the dedicated production workload account');
  }
  if (productionAccount === MANAGEMENT_ACCOUNT) {
    throw new WrongTargetError(`Refusing: ${MANAGEMENT_ACCOUNT} is the management account (governance only), never a deploy target.`);
  }
  if (productionAccount === CONNECTIONS_STAGING_TARGET.account) {
    throw new WrongTargetError(`Refusing: ${productionAccount} is ${CONNECTIONS_STAGING_TARGET.accountName}, not the production workload account.`);
  }
  return Object.freeze({
    accountName: 'Loop Production',
    account: productionAccount,
    region: CONNECTIONS_REGION,
    stackName: 'LoopConnections-production',
    stage: 'production',
    bootstrapQualifier: CONNECTIONS_STAGING_TARGET.bootstrapQualifier,
  });
}

/** Resolve the target for a stage. Staging is pinned; production needs `productionAccount` context. */
export function targetFor(stage: unknown, context: { readonly productionAccount?: unknown }): ConnectionsTarget {
  if (stage === 'staging') return CONNECTIONS_STAGING_TARGET;
  if (stage === 'production') return productionTarget(context.productionAccount);
  throw new Error(`unknown stage ${JSON.stringify(stage)}: this deployable builds 'staging' or 'production'`);
}

/** Synthesis without credentials is allowed; credentials for any account but the target's are refused. */
export function assertTargetCredentials(target: ConnectionsTarget, credentialAccount: string | undefined): void {
  if (credentialAccount === undefined || credentialAccount === '') return;
  if (credentialAccount !== target.account) {
    throw new WrongTargetError(
      `Refusing: the active AWS credentials are for account ${credentialAccount}, not ${target.accountName} (${target.account}).`,
    );
  }
}
