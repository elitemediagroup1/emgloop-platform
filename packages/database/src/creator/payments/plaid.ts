import { PLAID_DEPLOY_CONTEXT } from './deploy-context';
import type { PayoutConfig as PlaidConfig, PayoutPort as PlaidPort, PayoutTransfer as PlaidTransfer, PayoutSweep as PlaidSweep } from './payout-port';
export { sealBank, openBank, bankAAD, usdAmount, decimalMinor, payoutState } from './payout-port';
export type { PayoutConfig as PlaidConfig, PayoutPort as PlaidPort, PayoutTransfer as PlaidTransfer, PayoutSweep as PlaidSweep } from './payout-port';
/** Live traffic requires all independent production gates. A preview never uses live credentials. */
export function plaidConfig(
  env: NodeJS.ProcessEnv = process.env,
  deployContext: string = PLAID_DEPLOY_CONTEXT,
): PlaidConfig | null {
  const environment = env.LOOP_PLAID_ENV;
  if (environment !== 'sandbox' && environment !== 'production') return null;
  if (
    environment === 'production' &&
    (deployContext !== 'production' ||
      env.LOOP_PLAID_LIVE_APPROVED !== 'true' ||
      !env.LOOP_PLAID_LEDGER_ID ||
      !env.LOOP_PLAID_FUNDING_ACCOUNT_ID ||
      !env.LOOP_PLAID_FUNDING_ACCOUNT_LABEL ||
      env.LOOP_PLAID_REDIRECT_URI !== 'https://app.emgloop.com/app/creator/earnings')
  )
    return null;
  // A production workspace never displays sandbox funds or links a sandbox bank.
  if (environment === 'sandbox' && deployContext === 'production') return null;
  let redirectUri: string | undefined;
  if (env.LOOP_PLAID_REDIRECT_URI) {
    try {
      const uri = new URL(env.LOOP_PLAID_REDIRECT_URI);
      if (
        uri.protocol !== 'https:' ||
        uri.pathname !== '/app/creator/earnings' ||
        uri.search ||
        uri.hash ||
        uri.username ||
        uri.password ||
        !(uri.hostname === 'app.emgloop.com' || uri.hostname.endsWith('--emgloop2.netlify.app'))
      )
        return null;
      redirectUri = uri.href;
    } catch {
      return null;
    }
  }
  const key = Buffer.from(env.LOOP_PLAID_TOKEN_KEY ?? '', 'base64');
  if (
    key.length !== 32 ||
    !env.PLAID_CLIENT_ID ||
    !env.PLAID_SECRET ||
    !env.LOOP_PLAID_ORGANIZATION_ID
  )
    return null;
  return {
    environment,
    clientId: env.PLAID_CLIENT_ID,
    secret: env.PLAID_SECRET,
    key,
    organizationId: env.LOOP_PLAID_ORGANIZATION_ID,
    ledgerId: env.LOOP_PLAID_LEDGER_ID ?? '',
    redirectUri,
    fundingAccountId: env.LOOP_PLAID_FUNDING_ACCOUNT_ID,
    fundingAccountLabel: env.LOOP_PLAID_FUNDING_ACCOUNT_LABEL?.slice(0, 100),
  };
}
/** Fixed hosts and endpoint allowlist; provider responses and credentials never appear in thrown errors. */
export class PlaidApi implements PlaidPort {
  constructor(
    private c: PlaidConfig,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (this.c.recordingOnly || !this.c.clientId || !this.c.secret)
      throw Error('PLAID_NOT_CONFIGURED');
    const response = await this.fetcher(
      `https://${this.c.environment === 'production' ? 'production' : 'sandbox'}.plaid.com${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: this.c.clientId, secret: this.c.secret, ...body }),
        signal: AbortSignal.timeout(8000),
      },
    ).catch(() => {
      throw Error('PLAID_UNAVAILABLE');
    });
    if (!response.ok) throw Error('PLAID_UNAVAILABLE');
    const text = await response.text();
    if (text.length > 1000000) throw Error('PLAID_UNAVAILABLE');
    try {
      return JSON.parse(text) as T;
    } catch {
      throw Error('PLAID_UNAVAILABLE');
    }
  }
  ledger() {
    return this.call<{ ledger_id: string; balance: { available: string; pending: string } }>(
      '/transfer/ledger/get',
      { ...(this.c.ledgerId ? { ledger_id: this.c.ledgerId } : {}) },
    );
  }
  async deposit(amount: string, id: string) {
    if (!this.c.fundingAccountId) throw Error('FUNDING_NOT_CONFIGURED');
    return (
      await this.call<{ sweep: PlaidSweep }>('/transfer/ledger/deposit', {
        ledger_id: this.c.ledgerId,
        funding_account_id: this.c.fundingAccountId,
        amount,
        network: 'ach',
        description: 'EMG funds',
        idempotency_key: `fund_${id}`,
      })
    ).sweep;
  }
  async sweep(id: string) {
    return (await this.call<{ sweep: PlaidSweep }>('/transfer/sweep/get', { sweep_id: id })).sweep;
  }
  async link(userId: string) {
    const r = await this.call<{ link_token: string }>('/link/token/create', {
      user: { client_user_id: userId },
      client_name: 'EMG Loop',
      products: ['transfer'],
      country_codes: ['US'],
      language: 'en',
      ...(this.c.redirectUri ? { redirect_uri: this.c.redirectUri } : {}),
      account_filters: { depository: { account_subtypes: ['checking', 'savings'] } },
    });
    if (typeof r.link_token !== 'string') throw Error('PLAID_UNAVAILABLE');
    return r.link_token;
  }
  exchange(publicToken: string) {
    return this.call<{ access_token: string; item_id: string }>('/item/public_token/exchange', {
      public_token: publicToken,
    });
  }
  async accounts(accessToken: string) {
    return (
      await this.call<{ accounts: Awaited<ReturnType<PlaidPort['accounts']>> }>('/accounts/get', {
        access_token: accessToken,
      })
    ).accounts;
  }
  async remove(accessToken: string) {
    await this.call('/item/remove', { access_token: accessToken });
  }
  async authorize(i: Parameters<PlaidPort['authorize']>[0]) {
    const r = await this.call<{ authorization: { id: string; decision: string } }>(
      '/transfer/authorization/create',
      {
        access_token: i.accessToken,
        account_id: i.accountId,
        user: { legal_name: i.legalName },
        amount: i.amount,
        type: 'credit',
        network: 'ach',
        ach_class: 'ppd',
        idempotency_key: i.id,
        ...(this.c.ledgerId ? { ledger_id: this.c.ledgerId } : {}),
      },
    );
    return r.authorization;
  }
  async create(authorizationId: string, accessToken: string, accountId: string, payoutId: string) {
    return (
      await this.call<{ transfer: PlaidTransfer }>('/transfer/create', {
        authorization_id: authorizationId,
        access_token: accessToken,
        account_id: accountId,
        description: 'Creator payout',
        metadata: { payout_id: payoutId },
      })
    ).transfer;
  }
  async get(i: { transferId?: string; authorizationId?: string }) {
    return (
      await this.call<{ transfer: PlaidTransfer }>(
        '/transfer/get',
        i.transferId ? { transfer_id: i.transferId } : { authorization_id: i.authorizationId },
      )
    ).transfer;
  }
}
/** Allows real manager bookkeeping before Plaid is enabled; no provider operation is permitted. */
export function plaidLedgerConfig(
  organizationId: string,
  deployContext: string = PLAID_DEPLOY_CONTEXT,
): PlaidConfig {
  return {
    organizationId,
    environment: deployContext === 'production' ? 'production' : 'sandbox',
    clientId: '',
    secret: '',
    key: Buffer.alloc(32),
    ledgerId: '',
    recordingOnly: true,
  };
}
