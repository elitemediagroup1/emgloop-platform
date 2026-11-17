import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { IamRepository } from '../src/repositories/iam.repository';
import { CreatorRepository } from '../src/creator/creator.repository';
import { CreatorPayoutRepository } from '../src/creator/payments/creator-payout.repository';
import type { PlaidConfig, PlaidPort, PlaidTransfer } from '../src/creator/payments/plaid';
const url = process.env.LOOP_TEST_POSTGRES_URL ?? '',
  local = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
test(
  'Postgres: payout approval, reservation, idempotence, isolation, ambiguous outcomes and revocation',
  { skip: local ? false : 'Disposable localhost Postgres required' },
  async () => {
    const db = new PrismaClient({ datasources: { db: { url } } }),
      org = `payout_${randomUUID()}`,
      other = `payout_${randomUUID()}`;
    try {
      await db.organization.createMany({
        data: [
          { id: org, name: 'EMG test', slug: org },
          { id: other, name: 'Other', slug: other },
        ],
      });
      const iam = new IamRepository(db);
      async function user(role: 'ADMIN' | 'CREATOR') {
        const u = await iam.createUser({
          organizationId: org,
          email: `${randomUUID()}@example.test`,
          systemRole: role,
        });
        await iam.activateUser(org, u.id);
        return u.id;
      }
      const manager = { organizationId: org, userId: await user('ADMIN') },
        creator = await user('CREATOR'),
        second = await user('CREATOR');
      const profile = await db.creatorProfile.create({
          data: {
            organizationId: org,
            userId: creator,
            partyId: 'payout-party',
            displayName: 'Creator',
          },
        }),
        p = { organizationId: org, userId: creator, creatorProfileId: profile.id };
      const config: PlaidConfig = {
        environment: 'production',
        organizationId: org,
        clientId: 'fake',
        secret: 'fake',
        ledgerId: 'ledger-test',
        fundingAccountId: 'emg-funding',
        key: Buffer.alloc(32, 8),
      };
      let creates = 0,
        authorizes = 0,
        unknown = false,
        status = 'settled';
      let available = '0.00',
        fundingStatus = 'pending',
        deposits = 0;
      let last: PlaidTransfer | null = null;
      const api: PlaidPort = {
        ledger: async () => ({
          ledger_id: 'ledger-test',
          balance: { available, pending: '125.00' },
        }),
        deposit: async () => {
          deposits++;
          return {
            id: 'funding-sweep',
            funding_account_id: 'emg-funding',
            ledger_id: 'ledger-test',
            amount: '-125.00',
            iso_currency_code: 'USD',
            status: fundingStatus,
          };
        },
        sweep: async () => ({
          id: 'funding-sweep',
          funding_account_id: 'emg-funding',
          ledger_id: 'ledger-test',
          amount: '-125.00',
          iso_currency_code: 'USD',
          status: fundingStatus,
        }),
        link: async () => 'link-test',
        exchange: async () => ({ access_token: 'private-test-token', item_id: 'private-item' }),
        accounts: async () => [
          {
            account_id: 'own-account',
            mask: '1234',
            name: 'Test checking',
            type: 'depository',
            subtype: 'checking',
            balances: { iso_currency_code: 'USD' },
          },
        ],
        remove: async () => {},
        authorize: async (i) => {
          authorizes++;
          return { id: `auth-${i.id}`, decision: 'approved' };
        },
        create: async (auth, _access, account, id) => {
          creates++;
          last = {
            id: `transfer-${id}`,
            authorization_id: auth,
            account_id: account,
            amount: '125.00',
            type: 'credit',
            ledger_id: 'ledger-test',
            status,
          };
          if (unknown) throw Error('network response lost');
          return last;
        },
        get: async () => {
          if (!last) throw Error('unknown');
          return { ...last, status };
        },
      };
      const repo = new CreatorPayoutRepository(db, config, api);
      assert.equal(await repo.view({ ...p, organizationId: other }), null);
      assert.equal(await repo.view({ ...p, userId: second }), null);
      const approval = {
        profileId: profile.id,
        amountMinor: 12500,
        description: 'Approved net campaign fee',
        submission: randomUUID(),
        earningReference: 'invoice-test-01',
      };
      assert.equal(await repo.approve({ ...manager, userId: creator }, approval), false);
      await db.permission.create({
        data: {
          organizationId: org,
          userId: manager.userId,
          resource: 'creatorPayouts',
          action: 'update',
          effect: 'DENY',
        },
      });
      assert.equal(await repo.approve(manager, approval), false);
      await db.permission.deleteMany({
        where: { organizationId: org, resource: 'creatorPayouts' },
      });
      assert.equal(await repo.approve(manager, approval), true);
      assert.equal(await repo.approve(manager, approval), true);
      assert.equal(
        await repo.approve(manager, { ...approval, submission: randomUUID() }),
        false,
        'same invoice cannot be approved twice',
      );
      const row = (await repo.view(p))!.payouts[0]!;
      assert.equal(row.state, 'PENDING', 'entering a balance never releases it');
      assert.equal(await repo.request(p, row.id, true), null);
      assert.equal(
        await repo.release(manager, profile.id, row.id, true),
        false,
        'cannot release unfunded earnings',
      );
      assert.equal(
        await repo.fund({ ...manager, userId: creator }, profile.id, row.id, true),
        false,
      );
      await db.permission.create({
        data: {
          organizationId: org,
          userId: manager.userId,
          resource: 'creatorPayoutFunding',
          action: 'update',
          effect: 'DENY',
        },
      });
      assert.equal(await repo.fund(manager, profile.id, row.id, true), false);
      await db.permission.deleteMany({
        where: { organizationId: org, resource: 'creatorPayoutFunding' },
      });
      assert.equal(await repo.fund(manager, profile.id, row.id, true), true);
      assert.equal(deposits, 1);
      available = '1000.00';
      assert.equal(
        await repo.release(manager, profile.id, row.id, true),
        false,
        'pending bank funding is not available money',
      );
      fundingStatus = 'funds_available';
      await repo.processFunding(row.id);
      assert.equal(await repo.fund(manager, profile.id, row.id, true), true);
      assert.equal(deposits, 1, 'same funding instruction never debits EMG twice');
      assert.equal(
        await repo.release({ ...manager, userId: creator }, profile.id, row.id, true),
        false,
      );
      assert.equal(await repo.release(manager, profile.id, row.id, true), true);
      assert.equal((await repo.view(p))!.payouts.find((v) => v.id === row.id)!.state, 'AVAILABLE');
      assert.equal(await repo.request({ ...p, userId: second }, row.id, true), null);
      assert.equal(await repo.request(p, row.id, true), null, 'no verified destination');
      // Two managers cannot release the same pool dollars for two separate entries.
      available = '250.00';
      for (const reference of ['race-a', 'race-b'])
        await repo.approve(manager, {
          ...approval,
          submission: randomUUID(),
          earningReference: reference,
          description: reference,
        });
      const races = (await repo.view(p))!.payouts.filter((v) => v.description.startsWith('race-'));
      const released = await Promise.allSettled(
        races.map((v) => repo.release(manager, profile.id, v.id, true)),
      );
      assert.equal(
        released.filter((r) => r.status === 'fulfilled' && r.value).length,
        1,
        'only one release fits the unreserved pool',
      );
      for (const r of races) assert.equal(await repo.cancel(manager, profile.id, r.id), true);
      available = '1000.00';
      const link = await repo.beginLink(p, 'Test Legal Name', true);
      assert.equal(
        await repo.finishLink({ ...p, userId: second }, link.nonce, 'public-test', 'own-account'),
        false,
      );
      assert.equal(await repo.finishLink(p, link.nonce, 'public-test', 'own-account'), true);
      assert.equal(
        await repo.finishLink(p, link.nonce, 'public-test', 'own-account'),
        false,
        'Link session is single-use',
      );
      const bank = await db.creatorPayoutBank.findFirstOrThrow({ where: { organizationId: org } });
      assert.equal(bank.sealed!.includes('private-test-token'), false);
      assert.equal(JSON.stringify(await repo.view(p)).includes('private-test-token'), false);
      const results = await Promise.allSettled([
        repo.request(p, row.id, true),
        repo.request(p, row.id, true),
      ]);
      assert.ok(results.some((r) => r.status === 'fulfilled' && r.value === row.id));
      assert.equal(
        await repo.disconnect(p),
        false,
        'pending destination cannot be replaced or disconnected',
      );
      await Promise.allSettled([repo.process(row.id), repo.process(row.id)]);
      assert.equal(creates, 1);
      assert.equal(authorizes, 1);
      assert.equal((await repo.view(p))!.payouts.find((v) => v.id === row.id)!.state, 'PAID');
      assert.equal(
        (await new CreatorRepository(db).listCompensation(org, profile.id))[0]!.state,
        'PAID',
        'ledger uses provider-confirmed state',
      );
      status = 'returned';
      await repo.process(row.id);
      assert.equal((await repo.view(p))!.payouts.find((v) => v.id === row.id)!.state, 'RETURNED');
      await repo.process(row.id);
      assert.equal(creates, 1, 'returns never generate a new transfer');
      // A second valid approval loses its create response: hold funds and reconcile the same auth.
      await repo.approve(manager, {
        ...approval,
        submission: randomUUID(),
        earningReference: 'invoice-test-02',
      });
      const next = (await repo.view(p))!.payouts.find((r) => r.state === 'PENDING')!;
      assert.equal(await repo.release(manager, profile.id, next.id, true), true);
      await repo.request(p, next.id, true);
      unknown = true;
      status = 'pending';
      await repo.process(next.id);
      assert.equal(
        (await db.creatorPayout.findUniqueOrThrow({ where: { id: next.id } })).state,
        'REVIEW',
      );
      assert.equal(
        await repo.cancel(manager, profile.id, next.id),
        false,
        'a lost response is not proof of nonpayment',
      );
      const count = creates;
      unknown = false;
      status = 'settled';
      await repo.process(next.id);
      assert.equal(creates, count, 'unknown outcome reconciles instead of resending');
      assert.equal(
        (await db.creatorPayout.findUniqueOrThrow({ where: { id: next.id } })).state,
        'PAID',
      );
      // Offboarding before processing cannot start a new transfer.
      await repo.approve(manager, {
        ...approval,
        submission: randomUUID(),
        earningReference: 'invoice-test-03',
      });
      const revoked = (await repo.view(p))!.payouts.find((r) => r.state === 'PENDING')!;
      assert.equal(await repo.release(manager, profile.id, revoked.id, true), true);
      await repo.request(p, revoked.id, true);
      await db.creatorProfile.update({ where: { id: profile.id }, data: { userId: second } });
      await repo.process(revoked.id);
      assert.equal(creates, count);
      assert.equal(await repo.view(p), null);
      assert.equal(
        (await repo.view({ ...p, userId: second }))!.payouts.length,
        0,
        'reassignment cannot claim previous login approvals',
      );
    } finally {
      await db.organization.deleteMany({ where: { id: { in: [org, other] } } });
      await db.$disconnect();
    }
  },
);
