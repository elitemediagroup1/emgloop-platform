// Where the Brain staging stack may go. Slice B6.
//
// The workload account and region are fixed here, not taken from whatever credentials
// happen to be active: an account id is not a secret, and a stack that follows the
// caller's credentials can land in the management account by mistake.
//
// Account setup (Matt, 2026-09-17): AWS Organization "EMG Loop Production" (management
// account) with the dedicated member account "Loop Brain Staging"; IAM Identity Center
// organization instance; no long-lived IAM credentials.

export const BRAIN_STAGING_TARGET = Object.freeze({
  accountName: 'Loop Brain Staging',
  account: '065148797865',
  region: 'us-east-1',
  stackName: 'LoopBrain-staging',
  stage: 'staging' as const,
  /** The default CDK bootstrap qualifier; the bootstrap stack is `CDKToolkit`. */
  bootstrapQualifier: 'hnb659fds',
});

export class WrongTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WrongTargetError';
  }
}

/**
 * The CDK CLI sets CDK_DEFAULT_ACCOUNT from the active credentials. Synthesis without
 * credentials is allowed (CI, local checks); credentials for any other account are refused
 * before anything is compared or deployed.
 */
export function assertStagingCredentials(credentialAccount: string | undefined): void {
  if (credentialAccount === undefined || credentialAccount === '') return;
  if (credentialAccount !== BRAIN_STAGING_TARGET.account) {
    throw new WrongTargetError(
      `Refusing: the active AWS credentials are for account ${credentialAccount}, not ${BRAIN_STAGING_TARGET.accountName} (${BRAIN_STAGING_TARGET.account}).`,
    );
  }
}
