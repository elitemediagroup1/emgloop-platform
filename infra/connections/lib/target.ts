// Where the connections worker staging stack may go. Pinned like the Brain stack: the account and
// region are fixed here, not taken from whatever credentials are active, so a stack cannot land in
// the management account by mistake. Staging only (authorized 2026-09-20).

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

/** Synthesis without credentials is allowed; credentials for any other account are refused. */
export function assertStagingCredentials(credentialAccount: string | undefined): void {
  if (credentialAccount === undefined || credentialAccount === '') return;
  if (credentialAccount !== CONNECTIONS_STAGING_TARGET.account) {
    throw new WrongTargetError(
      `Refusing: the active AWS credentials are for account ${credentialAccount}, not ${CONNECTIONS_STAGING_TARGET.accountName} (${CONNECTIONS_STAGING_TARGET.account}).`,
    );
  }
}
