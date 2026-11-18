import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripePayoutConfig, StripeGlobalPayoutsApi } from '../src/creator/payments/stripe';
import { payoutState, type PayoutConfig } from '../src/creator/payments/payout-port';
const env = {
  LOOP_STRIPE_PAYOUT_ENV: 'sandbox',
  LOOP_STRIPE_PAYOUT_SECRET_KEY: 'sk_test_fixture',
  LOOP_STRIPE_PAYOUT_TOKEN_KEY: Buffer.alloc(32, 4).toString('base64'),
  LOOP_STRIPE_PAYOUT_ORGANIZATION_ID: 'emg',
  LOOP_STRIPE_FINANCIAL_ACCOUNT_ID: 'fa_test_emg',
  LOOP_STRIPE_PAYOUT_RETURN_URL:
    'https://deploy-preview-99--emgloop2.netlify.app/app/creator/earnings',
};
const config = stripePayoutConfig(env, 'deploy-preview')!;
function payout(extra: Record<string, unknown> = {}) {
  return {
    id: 'poi_test_a',
    object: 'v2.money_management.payout_intent',
    livemode: false,
    status: 'requires_action',
    confirmation_method: 'manual',
    next_action: { type: 'confirm', confirm: { reason: 'manually_requested' } },
    from: { financial_account: 'fa_test_emg', debited: { value: 10050, currency: 'usd' } },
    to: {
      recipient: 'acct_test_creator',
      payout_method: 'usba_test_own',
      credited: { value: 10000, currency: 'usd' },
      payout_method_options: { bank_account: { preferred_networks: ['ach'] } },
    },
    amount: { value: 10000, currency: 'usd' },
    ...extra,
  };
}
const bank = {
  id: 'usba_test_own',
  livemode: false,
  type: 'bank_account',
  bank_account: {
    country: 'US',
    archived: false,
    supported_currencies: ['usd'],
    last4: '1234',
    bank_name: 'Test bank',
  },
  usage_status: { payments: 'eligible' },
};
function api(handler: (url: string, init: RequestInit) => unknown, c: PayoutConfig = config) {
  return new StripeGlobalPayoutsApi(
    c,
    (async (url, init) =>
      new Response(JSON.stringify(handler(String(url), init!)), { status: 200 })) as typeof fetch,
  );
}
test('Stripe deployment gates reject live keys in previews and sandbox money in production', () => {
  assert.ok(config);
  assert.equal(stripePayoutConfig(env, 'production'), null);
  const live = {
    ...env,
    LOOP_STRIPE_PAYOUT_ENV: 'production',
    LOOP_STRIPE_PAYOUT_SECRET_KEY: 'rk_live_fixture',
    LOOP_STRIPE_PAYOUT_LIVE_APPROVED: 'true',
    LOOP_STRIPE_PAYOUT_RETURN_URL: 'https://app.emgloop.com/app/creator/earnings',
  };
  assert.ok(stripePayoutConfig(live, 'production'));
  assert.equal(stripePayoutConfig(live, 'deploy-preview'), null);
  assert.equal(
    stripePayoutConfig({ ...live, LOOP_STRIPE_PAYOUT_SECRET_KEY: 'sk_live_fixture' }, 'production'),
    null,
  );
  assert.equal(
    stripePayoutConfig(
      { ...live, LOOP_STRIPE_PAYOUT_RETURN_URL: 'https://attacker.invalid/app/creator/earnings' },
      'production',
    ),
    null,
  );
});
test('Stripe balance verifies source account, mode, currency and available funds rather than pending', async () => {
  const a = api(() => ({
    id: 'fa_test_emg',
    livemode: false,
    type: 'storage',
    country: 'US',
    status: 'open',
    balance: {
      available: { usd: { value: 10000, currency: 'usd' } },
      inbound_pending: { usd: { value: 50000, currency: 'usd' } },
    },
  }));
  assert.deepEqual((await a.ledger()).balance, { available: '100.00', pending: '500.00' });
  await assert.rejects(() => api(() => ({ id: 'other', livemode: true })).ledger());
});
test('hosted setup verifies the recipient and never accepts an arbitrary browser bank identifier', async () => {
  const a = api((url) =>
    url.includes('core/accounts')
      ? {
          id: 'acct_test_creator',
          livemode: false,
          identity: { country: 'us' },
          configuration: {
            recipient: { capabilities: { bank_accounts: { ach: { status: 'active' } } } },
          },
        }
      : { data: [bank], next_page_url: null },
  );
  assert.deepEqual(await a.hostedOnboarding.inspect('acct_test_creator'), {
    accountId: 'usba_test_own',
    mask: '1234',
    institution: 'Test bank',
  });
  const ambiguous = api((url) =>
    url.includes('core/accounts')
      ? {
          id: 'acct_test_creator',
          livemode: false,
          identity: { country: 'US' },
          configuration: {
            recipient: { capabilities: { bank_accounts: { ach: { status: 'active' } } } },
          },
        }
      : { data: [bank, { ...bank, id: 'usba_other' }], next_page_url: null },
  );
  assert.equal(await ambiguous.hostedOnboarding.inspect('acct_test_creator'), null);
  await assert.rejects(() =>
    a.hostedOnboarding.link('acct_test_creator', 'https://app.emgloop.com/app/creator/earnings'),
  );
});
test('payout preparation is manual, ACH-only, fixed-source and idempotent', async () => {
  const requests: { url: string; body: any; headers: Headers }[] = [];
  const a = api((url, init) => {
    requests.push({
      url,
      body: init.body ? JSON.parse(String(init.body)) : null,
      headers: new Headers(init.headers),
    });
    return url.includes('core/accounts')
      ? {
          id: 'acct_test_creator',
          livemode: false,
          identity: { country: 'US' },
          configuration: {
            recipient: { capabilities: { bank_accounts: { ach: { status: 'active' } } } },
          },
        }
      : url.includes('payout_methods')
        ? { data: [bank] }
        : payout();
  });
  const input = {
    accessToken: 'acct_test_creator',
    accountId: 'usba_test_own',
    legalName: 'Creator',
    amount: '100.00',
    id: 'payout-1',
  };
  assert.equal((await a.authorize(input)).decision, 'approved');
  await a.authorize(input);
  const create = requests.filter((r) => r.body?.confirmation_method);
  assert.equal(create[0].body.confirmation_method, 'manual');
  assert.deepEqual(create[0].body.to.payout_method_options.bank_account.preferred_networks, [
    'ach',
  ]);
  assert.equal(create[0].headers.get('Idempotency-Key'), create[1].headers.get('Idempotency-Key'));
  assert.equal(create[0].body.from.financial_account, 'fa_test_emg');
});
test('confirmation holds fee surprises and recipient mismatches without sending', async () => {
  let sent = 0;
  const a = api((url) => {
    if (url.endsWith('/confirm')) {
      sent++;
      return payout({ status: 'processing' });
    }
    return payout({
      from: { financial_account: 'fa_test_emg', debited: { value: 11000, currency: 'usd' } },
    });
  });
  await assert.rejects(() =>
    a.create('poi_test_a', 'acct_test_creator', 'usba_test_own', 'payout-1', '100.00'),
  );
  assert.equal(sent, 0);
  await assert.rejects(() =>
    api(() => payout()).create('poi_test_a', 'acct_wrong', 'usba_test_own', 'payout-1', '100.00'),
  );
});
test('confirmed payouts preserve opaque binding and original provider status; returned results never become paid', async () => {
  const a = api((url) =>
    payout({ status: url.endsWith('/confirm') ? 'processing' : 'requires_action' }),
  );
  const sent = await a.create(
    'poi_test_a',
    'acct_test_creator',
    'usba_test_own',
    'payout-1',
    '100.00',
  );
  assert.equal(sent.recipient_id, 'acct_test_creator');
  assert.equal(sent.status, 'processing');
  assert.equal(payoutState('posted', 'STRIPE'), 'PAID');
  assert.equal(payoutState('posted', 'PLAID'), 'PROCESSING');
  assert.equal(payoutState('requires_action', 'STRIPE'), 'REVIEW');
  assert.equal(payoutState('returned', 'STRIPE'), 'RETURNED');
  assert.equal(payoutState('unrecognized', 'STRIPE'), 'PROCESSING');
});
test('Stripe failures never expose provider bodies or secret values', async () => {
  const a = new StripeGlobalPayoutsApi(
    config,
    (async () => new Response('secret bank routing', { status: 400 })) as typeof fetch,
  );
  await assert.rejects(
    () => a.ledger(),
    (error) => String(error) === 'Error: STRIPE_UNAVAILABLE',
  );
});

test('confirmation rejects an altered amount and absent ACH routing before moving funds', async () => {
  let confirmations = 0;
  const a = api((url) => {
    if (url.endsWith('/confirm')) confirmations++;
    return payout();
  });
  await assert.rejects(() =>
    a.create('poi_test_a', 'acct_test_creator', 'usba_test_own', 'payout-1', '99.00'),
  );
  const noRail = api((url) => {
    if (url.endsWith('/confirm')) confirmations++;
    const p = payout();
    delete (p.to as any).payout_method_options;
    return p;
  });
  await assert.rejects(() =>
    noRail.create('poi_test_a', 'acct_test_creator', 'usba_test_own', 'payout-1', '100.00'),
  );
  assert.equal(confirmations, 0);
});

test('reconciliation checks the bound latest attempt and surfaces returns without resending', async () => {
  let sends = 0;
  const attempt = {
    id: 'obp_own',
    object: 'v2.money_management.outbound_payment',
    payout_intent: 'poi_test_a',
    livemode: false,
    from: { financial_account: 'fa_test_emg' },
    to: { recipient: 'acct_test_creator', payout_method: 'usba_test_own' },
    amount: { value: 10000, currency: 'usd' },
    status: 'returned',
  };
  const a = api((url, init) => {
    if (init.method === 'POST') sends++;
    return url.includes('outbound_payments')
      ? attempt
      : payout({ status: 'requires_action', latest_payout: { outbound_payment: 'obp_own' } });
  });
  assert.equal((await a.get({ transferId: 'poi_test_a' })).status, 'returned');
  assert.equal(sends, 0);
  const wrong = api((url) =>
    url.includes('outbound_payments')
      ? { ...attempt, to: { recipient: 'acct_other', payout_method: 'usba_test_own' } }
      : payout({ latest_payout: { outbound_payment: 'obp_own' } }),
  );
  await assert.rejects(() => wrong.get({ transferId: 'poi_test_a' }));
});
