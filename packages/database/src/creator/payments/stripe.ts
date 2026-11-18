import { createHash } from 'node:crypto';
import { PLAID_DEPLOY_CONTEXT } from './deploy-context';
import {
  decimalMinor,
  usdAmount,
  type PayoutConfig,
  type PayoutPort,
  type PayoutTransfer,
} from './payout-port';
const VERSION = '2026-10-28.endive';
const id = (s: string) => {
  if (!/^[a-zA-Z0-9_]{3,220}$/.test(s)) throw Error('INVALID_PROVIDER_ID');
  return encodeURIComponent(s);
};
const obj = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
export function stripePayoutConfig(
  env: NodeJS.ProcessEnv = process.env,
  context: string = PLAID_DEPLOY_CONTEXT,
): PayoutConfig | null {
  const mode = env.LOOP_STRIPE_PAYOUT_ENV;
  if (mode !== 'sandbox' && mode !== 'production') return null;
  const live = mode === 'production',
    secret = env.LOOP_STRIPE_PAYOUT_SECRET_KEY ?? '';
  if (
    live
      ? context !== 'production' ||
        env.LOOP_STRIPE_PAYOUT_LIVE_APPROVED !== 'true' ||
        !/^rk_live_/.test(secret)
      : context === 'production' || !/^(sk|rk)_test_/.test(secret)
  )
    return null;
  const key = Buffer.from(env.LOOP_STRIPE_PAYOUT_TOKEN_KEY ?? '', 'base64');
  if (
    key.length !== 32 ||
    !env.LOOP_STRIPE_PAYOUT_ORGANIZATION_ID ||
    !/^fa_[A-Za-z0-9_]+$/.test(env.LOOP_STRIPE_FINANCIAL_ACCOUNT_ID ?? '')
  )
    return null;
  let uri: URL;
  try {
    uri = new URL(env.LOOP_STRIPE_PAYOUT_RETURN_URL ?? '');
  } catch {
    return null;
  }
  if (
    uri.protocol !== 'https:' ||
    uri.pathname !== '/app/creator/earnings' ||
    uri.search ||
    uri.hash ||
    uri.username ||
    uri.password ||
    !(uri.hostname === 'app.emgloop.com' || uri.hostname.endsWith('--emgloop2.netlify.app')) ||
    (live && uri.hostname !== 'app.emgloop.com')
  )
    return null;
  return {
    provider: 'STRIPE',
    environment: mode,
    secret,
    clientId: 'stripe-global-payouts',
    key,
    organizationId: env.LOOP_STRIPE_PAYOUT_ORGANIZATION_ID,
    ledgerId: env.LOOP_STRIPE_FINANCIAL_ACCOUNT_ID!,
    redirectUri: uri.href,
    feeReserveMinor: 150,
    fundingDashboard: 'https://dashboard.stripe.com/treasury',
  };
}
/** Global Payouts v2. All credentials and recipient bank data stay on the server/provider. */
export class StripeGlobalPayoutsApi implements PayoutPort {
  constructor(
    private c: PayoutConfig,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async call(
    path: string,
    body?: Record<string, unknown>,
    key?: string,
    context?: string,
  ): Promise<Record<string, any>> {
    if (this.c.recordingOnly || !this.c.secret) throw Error('STRIPE_NOT_CONFIGURED');
    if (
      !/^\/v2\/(core\/(accounts|account_links)|money_management\/(financial_accounts|payout_methods|payout_intents|outbound_payments))(\/|\?|$)/.test(
        path,
      )
    )
      throw Error('INVALID_PROVIDER_PATH');
    try {
      const r = await this.fetcher('https://api.stripe.com' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${this.c.secret}`,
          'Content-Type': 'application/json',
          'Stripe-Version': VERSION,
          ...(key
            ? {
                'Idempotency-Key': createHash('sha256')
                  .update(`${this.c.environment}:${this.c.organizationId}:${key}`)
                  .digest('hex'),
              }
            : {}),
          ...(context ? { 'Stripe-Context': context } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
      if (!r.ok) throw Error();
      const text = await r.text();
      if (text.length > 1000000) throw Error();
      return obj(JSON.parse(text));
    } catch {
      throw Error('STRIPE_UNAVAILABLE');
    }
  }
  private mode(r: Record<string, any>) {
    if (r.livemode !== (this.c.environment === 'production')) throw Error('PROVIDER_MODE_MISMATCH');
  }
  async ledger() {
    const r = await this.call(`/v2/money_management/financial_accounts/${id(this.c.ledgerId)}`);
    this.mode(r);
    if (
      r.id !== this.c.ledgerId ||
      r.type !== 'storage' ||
      r.status !== 'open' ||
      r.country !== 'US'
    )
      throw Error('INVALID_FUNDING_ACCOUNT');
    const available = r.balance?.available?.usd,
      pending = r.balance?.inbound_pending?.usd;
    if (available?.currency !== 'usd' || pending?.currency !== 'usd')
      throw Error('INVALID_BALANCE');
    return {
      ledger_id: r.id,
      balance: {
        available: usdNonnegative(available.value),
        pending: usdNonnegative(pending.value),
      },
    };
  }
  hostedOnboarding = {
    recipient: async (i: {
      email: string;
      name: string;
      entityType: 'individual' | 'company';
      id: string;
    }) => {
      const r = await this.call(
        '/v2/core/accounts',
        {
          contact_email: i.email,
          display_name: i.name,
          identity: { country: 'us', entity_type: i.entityType },
          configuration: {
            recipient: { capabilities: { bank_accounts: { ach: { requested: true } } } },
          },
          include: ['configuration.recipient', 'identity', 'requirements'],
        },
        `recipient:${i.id}`,
      );
      this.mode(r);
      if (typeof r.id !== 'string' || !r.id.startsWith('acct_')) throw Error('INVALID_RECIPIENT');
      return r.id as string;
    },
    link: async (recipient: string, returnUrl: string) => {
      const refresh = new URL(returnUrl);
      const nonce = refresh.searchParams.get('bank_session');
      if (!nonce) throw Error('INVALID_ONBOARDING_SESSION');
      refresh.searchParams.delete('bank_session');
      refresh.searchParams.set('bank_refresh', nonce);
      const r = await this.call('/v2/core/account_links', {
        account: recipient,
        use_case: {
          type: 'account_onboarding',
          account_onboarding: { return_url: returnUrl, refresh_url: refresh.href },
        },
      });
      const u = new URL(r.url);
      if (
        u.protocol !== 'https:' ||
        !['connect.stripe.com', 'onboarding.stripe.com'].includes(u.hostname) ||
        u.username ||
        u.password
      )
        throw Error('INVALID_ONBOARDING_URL');
      return u.href;
    },
    inspect: async (recipient: string) => {
      const r = await this.call(
        `/v2/core/accounts/${id(recipient)}?include[0]=configuration.recipient&include[1]=identity`,
      );
      this.mode(r);
      if (
        r.id !== recipient ||
        r.identity?.country?.toUpperCase() !== 'US' ||
        r.configuration?.recipient?.capabilities?.bank_accounts?.ach?.status !== 'active'
      )
        return null;
      const methods = await this.call(
        '/v2/money_management/payout_methods?limit=20',
        undefined,
        undefined,
        recipient,
      );
      const list = Array.isArray(methods.data) ? methods.data : [];
      const banks = list.filter(
        (m: any) =>
          m.livemode === (this.c.environment === 'production') &&
          m.type === 'bank_account' &&
          m.bank_account?.country === 'US' &&
          !m.bank_account?.archived &&
          m.bank_account?.supported_currencies?.includes('usd') &&
          m.usage_status?.payments === 'eligible' &&
          /^\d{4}$/.test(m.bank_account?.last4),
      );
      if (methods.next_page_url || banks.length !== 1) return null;
      return {
        accountId: banks[0].id as string,
        mask: banks[0].bank_account.last4 as string,
        institution: String(banks[0].bank_account.bank_name ?? 'Bank account').slice(0, 100),
      };
    },
  };
  async authorize(i: Parameters<PayoutPort['authorize']>[0]) {
    const bank = await this.hostedOnboarding.inspect(i.accessToken);
    if (!bank || bank.accountId !== i.accountId) throw Error('RECIPIENT_NOT_READY');
    const r = await this.call(
      '/v2/money_management/payout_intents',
      {
        from: { financial_account: this.c.ledgerId, currency: 'usd' },
        to: {
          recipient: i.accessToken,
          payout_method: i.accountId,
          payout_method_options: { bank_account: { preferred_networks: ['ach'] } },
        },
        amount: { value: decimalMinor(i.amount), currency: 'usd' },
        confirmation_method: 'manual',
        description: 'EMG creator earnings',
      },
      `prepare:${i.id}`,
    );
    this.mode(r);
    const prepared = this.transfer(r);
    if (
      prepared.recipient_id !== i.accessToken ||
      prepared.account_id !== i.accountId ||
      decimalMinor(prepared.amount) !== decimalMinor(i.amount)
    )
      throw Error('PAYOUT_MISMATCH');
    return {
      id: r.id as string,
      decision:
        r.status === 'requires_action' &&
        r.next_action?.type === 'confirm' &&
        r.next_action?.confirm?.reason === 'manually_requested'
          ? 'approved'
          : 'user_action_required',
    };
  }
  async create(
    authorizationId: string,
    recipient: string,
    method: string,
    payoutId: string,
    expectedAmount: string,
  ) {
    const r = await this.call(`/v2/money_management/payout_intents/${id(authorizationId)}`);
    const t = this.transfer(r);
    if (
      t.id !== authorizationId ||
      decimalMinor(t.amount) !== decimalMinor(expectedAmount) ||
      t.account_id !== method ||
      t.recipient_id !== recipient ||
      r.confirmation_method !== 'manual' ||
      r.status !== 'requires_action' ||
      r.next_action?.type !== 'confirm' ||
      r.next_action?.confirm?.reason !== 'manually_requested'
    )
      throw Error('PAYOUT_REQUIRES_REVIEW');
    const debit = r.from?.debited,
      credit = r.to?.credited;
    if (
      debit?.currency !== 'usd' ||
      credit?.currency !== 'usd' ||
      credit.value !== r.amount?.value ||
      !Number.isSafeInteger(debit.value) ||
      debit.value < credit.value ||
      debit.value - credit.value > (this.c.feeReserveMinor ?? 0) ||
      JSON.stringify(r.to?.payout_method_options?.bank_account?.preferred_networks) !== '["ach"]'
    )
      throw Error('PAYOUT_FEE_REVIEW');
    return this.transfer(
      await this.call(
        `/v2/money_management/payout_intents/${id(authorizationId)}/confirm`,
        {},
        `send:${payoutId}`,
      ),
    );
  }
  async get(i: { transferId?: string; authorizationId?: string }) {
    const reference = i.transferId ?? i.authorizationId;
    if (!reference) throw Error('INVALID_PAYOUT');
    const intent = await this.call(`/v2/money_management/payout_intents/${id(reference)}`);
    const result = this.transfer(intent);
    if (result.id !== reference) throw Error('PAYOUT_MISMATCH');
    const latest = intent.latest_payout?.outbound_payment;
    if (latest) {
      const attempt = await this.call(`/v2/money_management/outbound_payments/${id(latest)}`);
      this.mode(attempt);
      if (
        attempt.id !== latest ||
        attempt.object !== 'v2.money_management.outbound_payment' ||
        attempt.payout_intent !== result.id ||
        attempt.from?.financial_account !== this.c.ledgerId ||
        attempt.to?.recipient !== result.recipient_id ||
        attempt.to?.payout_method !== result.account_id ||
        attempt.amount?.currency !== 'usd' ||
        attempt.amount?.value !== decimalMinor(result.amount)
      )
        throw Error('PAYOUT_ATTEMPT_MISMATCH');
      if (['returned', 'failed', 'canceled'].includes(attempt.status))
        result.status = attempt.status;
    }
    return result;
  }
  private transfer(r: Record<string, any>): PayoutTransfer & { recipient_id: string } {
    this.mode(r);
    if (
      r.object !== 'v2.money_management.payout_intent' ||
      typeof r.id !== 'string' ||
      r.from?.financial_account !== this.c.ledgerId ||
      r.amount?.currency !== 'usd' ||
      !Number.isSafeInteger(r.amount?.value) ||
      r.amount.value <= 0 ||
      typeof r.to?.recipient !== 'string' ||
      typeof r.to?.payout_method !== 'string'
    )
      throw Error('INVALID_PAYOUT_RESPONSE');
    return {
      id: r.id,
      authorization_id: r.id,
      account_id: r.to.payout_method,
      recipient_id: r.to.recipient,
      amount: usdAmount(r.amount.value),
      type: 'credit',
      ledger_id: r.from.financial_account,
      status: typeof r.status === 'string' ? r.status : 'unknown',
    };
  }
  // Hosted Stripe setup replaces Plaid Link. These legacy operations are never invoked by Stripe flows.
  async link(_u: string): Promise<string> {
    throw Error('USE_HOSTED_ONBOARDING');
  }
  async exchange(_t: string): Promise<{ access_token: string; item_id: string }> {
    throw Error('USE_HOSTED_ONBOARDING');
  }
  async accounts(_t: string): Promise<Awaited<ReturnType<PayoutPort['accounts']>>> {
    throw Error('USE_HOSTED_ONBOARDING');
  }
  async remove(_recipient: string) {
    /* Disconnect only the Loop authorization; no third-party data deletion. */
  }
  async deposit(_amount: string, _id: string): Promise<Awaited<ReturnType<PayoutPort['deposit']>>> {
    throw Error('FUND_IN_STRIPE_DASHBOARD');
  }
  async sweep(_id: string): Promise<Awaited<ReturnType<PayoutPort['sweep']>>> {
    throw Error('FUND_IN_STRIPE_DASHBOARD');
  }
}
function usdNonnegative(v: unknown) {
  if (!Number.isSafeInteger(v) || Number(v) < 0) throw Error('INVALID_BALANCE');
  return (Number(v) / 100).toFixed(2);
}
