import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { IamRepository } from '../src/repositories/iam.repository';
import { CreatorPayoutRepository } from '../src/creator/payments/creator-payout.repository';
import type { PayoutConfig, PayoutPort } from '../src/creator/payments/payout-port';
const url = process.env.LOOP_TEST_POSTGRES_URL ?? '',
  local = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
test(
  'Postgres: Stripe hosted callbacks, provider switch, fee reservations and creator-only withdrawal',
  { skip: local ? false : 'Disposable localhost Postgres required' },
  async () => {
    const db = new PrismaClient({ datasources: { db: { url } } }),
      org = `stripe_${randomUUID()}`;
    try {
      await db.organization.create({ data: { id: org, slug: org, name: 'Stripe test' } });
      const iam = new IamRepository(db);
      const member = async (role: string) => {
        const u = await iam.createUser({
          organizationId: org,
          email: `${randomUUID()}@example.test`,
          systemRole: role,
        });
        await iam.activateUser(org, u.id);
        return u.id;
      };
      const manager = { organizationId: org, userId: await member('ADMIN') },
        userId = await member('CREATOR'),
        other = await member('CREATOR');
      const profile = await db.creatorProfile.create({
          data: { organizationId: org, userId, partyId: 'stripe-fixture', displayName: 'Creator' },
        }),
        p = { organizationId: org, userId, creatorProfileId: profile.id };
      const config: PayoutConfig = {
        provider: 'STRIPE',
        environment: 'production',
        organizationId: org,
        clientId: 'stripe',
        secret: 'fixture',
        key: Buffer.alloc(32, 9),
        ledgerId: 'fa_fixture',
        redirectUri: 'https://app.emgloop.com/app/creator/earnings',
        feeReserveMinor: 150,
      };
      let ready = false,
        available = '100.00',
        sends = 0,
        status = 'posted';
      const port: PayoutPort = {
        ledger: async () => ({ ledger_id: 'fa_fixture', balance: { available, pending: '0.00' } }),
        hostedOnboarding: {
          recipient: async () => 'acct_creator',
          link: async (_recipient, url) =>
            `https://connect.stripe.com/setup?return=${encodeURIComponent(url)}`,
          inspect: async () =>
            ready ? { accountId: 'usba_creator', mask: '1234', institution: 'Test bank' } : null,
        },
        authorize: async () => ({ id: 'poi_fixture', decision: 'approved' }),
        create: async () => {
          sends++;
          return {
            id: 'poi_fixture',
            authorization_id: 'poi_fixture',
            account_id: 'usba_creator',
            recipient_id: 'acct_creator',
            amount: '100.00',
            type: 'credit',
            ledger_id: 'fa_fixture',
            status,
          };
        },
        get: async () => ({
          id: 'poi_fixture',
          authorization_id: 'poi_fixture',
          account_id: 'usba_creator',
          recipient_id: 'acct_creator',
          amount: '100.00',
          type: 'credit',
          ledger_id: 'fa_fixture',
          status,
        }),
        link: async () => {
          throw Error('legacy');
        },
        exchange: async () => {
          throw Error('legacy');
        },
        accounts: async () => [],
        remove: async () => {},
        deposit: async () => {
          throw Error('dashboard');
        },
        sweep: async () => {
          throw Error('dashboard');
        },
      };
      const stripe = new CreatorPayoutRepository(db, config, port),
        legacy = new CreatorPayoutRepository(db, { ...config, provider: 'PLAID' }, port);
      const start = await stripe.beginHostedLink(p, 'Creator', true, 'individual');
      const oldNonce = new URL(new URL(start.url).searchParams.get('return')!).searchParams.get(
        'bank_session',
      )!;
      await assert.rejects(() => stripe.refreshHostedLink({ ...p, userId: other }, oldNonce));
      const resumed = await stripe.refreshHostedLink(p, oldNonce);
      assert.equal(await stripe.finishHostedLink(p, oldNonce), false);
      const nonce = new URL(new URL(resumed.url).searchParams.get('return')!).searchParams.get(
        'bank_session',
      )!;
      assert.equal(await stripe.finishHostedLink({ ...p, userId: other }, nonce), false);
      assert.equal(await stripe.finishHostedLink(p, nonce), false);
      ready = true;
      assert.equal(await stripe.finishHostedLink(p, nonce), true);
      assert.equal(await stripe.finishHostedLink(p, nonce), false);
      const bank = await db.creatorPayoutBank.findFirstOrThrow({ where: { organizationId: org } });
      assert.equal(bank.provider, 'STRIPE');
      assert.ok(bank.sealed);
      assert.ok(!bank.sealed!.includes('acct_creator'));
      await legacy.approve(manager, {
        profileId: profile.id,
        amountMinor: 10000,
        description: 'Already recorded earning',
        earningReference: 'invoice-1',
        submission: randomUUID(),
      });
      const earning = await db.creatorPayout.findFirstOrThrow({ where: { organizationId: org } });
      assert.equal(earning.provider, 'PLAID');
      assert.equal((await stripe.view(p))?.payouts.length, 1);
      assert.equal(
        await stripe.release(manager, profile.id, earning.id, true),
        false,
        'fee headroom is reserved',
      );
      available = '101.50';
      assert.equal(await stripe.release(manager, profile.id, earning.id, true), true);
      assert.equal(
        (await db.creatorPayout.findUniqueOrThrow({ where: { id: earning.id } })).provider,
        'STRIPE',
      );
      assert.equal(await stripe.request({ ...p, userId: other }, earning.id, true), null);
      assert.equal(await stripe.request(p, earning.id, false), null);
      assert.equal(await stripe.request(p, earning.id, true), earning.id);
      await stripe.process(earning.id);
      assert.equal(sends, 1);
      await stripe.process(earning.id);
      assert.equal(sends, 1);
      assert.equal((await stripe.view(p))?.payouts[0]?.state, 'PAID');
      await assert.rejects(
        () =>
          db.creatorPayout.update({
            where: { id: earning.id },
            data: { providerStatus: 'settled' },
          }),
        'database requires Stripe proof, not a legacy Plaid status',
      );
      await assert.rejects(
        () =>
          db.creatorPayout.update({ where: { id: earning.id }, data: { providerStatus: null } }),
        'a NULL status is not payout proof',
      );
      status = 'returned';
      await stripe.process(earning.id);
      assert.equal((await stripe.view(p))?.payouts[0]?.state, 'RETURNED');
      assert.equal(sends, 1);
      assert.equal(await stripe.disconnect(p), false, 'returned funds remain under manager review');
    } finally {
      await db.creatorPayoutLink.deleteMany({ where: { organizationId: org } });
      await db.creatorPayout.deleteMany({ where: { organizationId: org } });
      await db.organization.deleteMany({ where: { id: org } });
      await db.$disconnect();
    }
  },
);
