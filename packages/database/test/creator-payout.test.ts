import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  plaidConfig,
  plaidLedgerConfig,
  sealBank,
  openBank,
  bankAAD,
  usdAmount,
  payoutState,
  PlaidApi,
  type PlaidConfig,
} from '../src/creator/payments/plaid';
const key = Buffer.alloc(32, 5),
  base = {
    PLAID_CLIENT_ID: 'test',
    PLAID_SECRET: 'secret',
    LOOP_PLAID_TOKEN_KEY: key.toString('base64'),
    LOOP_PLAID_ORGANIZATION_ID: 'emg',
  };
test('production money requires approved Transfer, an explicit ledger and a published production deploy', () => {
  for (const env of [
    { ...base, LOOP_PLAID_ENV: 'production' },
    { ...base, LOOP_PLAID_ENV: 'sandbox', CONTEXT: 'production' },
    {
      ...base,
      LOOP_PLAID_ENV: 'production',
      LOOP_PLAID_LIVE_APPROVED: 'true',
      LOOP_PLAID_LEDGER_ID: 'ledger',
      CONTEXT: 'deploy-preview',
    },
  ])
    assert.equal(plaidConfig(env, env.CONTEXT ?? 'local'), null);
  assert.equal(
    plaidConfig({ ...base, LOOP_PLAID_ENV: 'sandbox', CONTEXT: 'deploy-preview' }, 'deploy-preview')
      ?.environment,
    'sandbox',
  );
  assert.equal(
    plaidConfig(
      {
        ...base,
        LOOP_PLAID_ENV: 'production',
        CONTEXT: 'production',
        LOOP_PLAID_LIVE_APPROVED: 'true',
        LOOP_PLAID_LEDGER_ID: 'ledger',
        LOOP_PLAID_FUNDING_ACCOUNT_ID: 'emg-bank',
        LOOP_PLAID_FUNDING_ACCOUNT_LABEL: 'EMG checking 1234',
        LOOP_PLAID_REDIRECT_URI: 'https://app.emgloop.com/app/creator/earnings',
      },
      'production',
    )?.ledgerId,
    'ledger',
  );
});
test('sealed bank tokens cannot move between creators, users, organizations or environments', () => {
  const p = { organizationId: 'emg', creatorProfileId: 'a', userId: 'u' },
    secret = { accessToken: 'private-token', accountId: 'private-account', itemId: 'private-item' };
  const ciphertext = sealBank(secret, key, bankAAD(p, 'sandbox'));
  assert.equal(ciphertext.includes('private'), false);
  assert.deepEqual(openBank(ciphertext, key, bankAAD(p, 'sandbox')), secret);
  for (const aad of [
    bankAAD({ ...p, userId: 'x' }, 'sandbox'),
    bankAAD({ ...p, creatorProfileId: 'b' }, 'sandbox'),
    bankAAD({ ...p, organizationId: 'other' }, 'sandbox'),
    bankAAD(p, 'production'),
  ])
    assert.throws(() => openBank(ciphertext, key, aad));
});
test('money uses exact cents and only provider-confirmed settled credits count as paid', () => {
  assert.equal(usdAmount(12345), '123.45');
  for (const v of [0, -1, 1.5, Infinity, 100000001]) assert.throws(() => usdAmount(v));
  assert.equal(payoutState('pending'), 'PROCESSING');
  assert.equal(payoutState('posted'), 'PROCESSING');
  assert.equal(payoutState('settled'), 'PAID');
  assert.equal(payoutState('returned'), 'RETURNED');
  assert.equal(payoutState('failed'), 'REVIEW');
});
test('Plaid authorization uses stable idempotency; create uses the authorization id, not a second request key', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const c: PlaidConfig = {
    environment: 'sandbox',
    clientId: 'client',
    secret: 'secret',
    organizationId: 'emg',
    key,
    ledgerId: '',
  };
  const api = new PlaidApi(c, async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    return new Response(
      JSON.stringify(
        String(url).endsWith('/authorization/create')
          ? { authorization: { id: 'auth', decision: 'approved' } }
          : { transfer: { id: 'transfer' } },
      ),
      { status: 200 },
    );
  });
  await api.authorize({
    accessToken: 'access',
    accountId: 'account',
    legalName: 'Test User',
    amount: '10.00',
    id: 'payout-one',
  });
  await api.create('auth', 'access', 'account', 'payout-one');
  assert.equal(calls[0]!.body.idempotency_key, 'payout-one');
  assert.equal(calls[0]!.body.type, 'credit');
  assert.equal(calls[0]!.body.ach_class, 'ppd');
  assert.equal(calls[1]!.body.authorization_id, 'auth');
  assert.equal('idempotency_key' in calls[1]!.body, false);
  assert.match(calls[0]!.url, /^https:\/\/sandbox\.plaid\.com\//);
});
test('provider errors never disclose bank tokens or credentials', async () => {
  const api = new PlaidApi(
    {
      environment: 'sandbox',
      clientId: 'client',
      secret: 'secret',
      organizationId: 'emg',
      key,
      ledgerId: '',
    },
    async () => new Response('{"error_message":"private account and secret"}', { status: 400 }),
  );
  await assert.rejects(
    api.get({ transferId: 'x' }),
    (e) => e instanceof Error && e.message === 'PLAID_UNAVAILABLE',
  );
});
test('manager funding debits only the configured EMG account; it is separate from creator payout creation', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const api = new PlaidApi(
    {
      environment: 'sandbox',
      clientId: 'client',
      secret: 'secret',
      organizationId: 'emg',
      key,
      ledgerId: 'emg-ledger',
      fundingAccountId: 'emg-bank',
    },
    async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ sweep: { id: 'sweep' } }));
    },
  );
  await api.deposit('125.00', 'earning-one');
  await api.deposit('125.00', 'earning-one');
  for (const call of calls) {
    assert.match(call.url, /\/transfer\/ledger\/deposit$/);
    assert.equal(call.body.funding_account_id, 'emg-bank');
    assert.equal(call.body.ledger_id, 'emg-ledger');
    assert.equal(call.body.idempotency_key, 'fund_earning-one');
    assert.equal('access_token' in call.body, false);
    assert.equal('account_id' in call.body, false);
  }
});

test('bookkeeping remains available without Plaid but provider calls are fail-closed', async () => {
  const c = plaidLedgerConfig('emg', 'production');
  assert.equal(c.environment, 'production');
  assert.equal(c.recordingOnly, true);
  let calls = 0;
  const api = new PlaidApi(c, async () => {
    calls++;
    throw Error('must not call');
  });
  await assert.rejects(api.ledger(), /PLAID_NOT_CONFIGURED/);
  assert.equal(calls, 0);
});
