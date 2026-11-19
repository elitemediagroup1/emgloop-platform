import { absentUntilMigrated } from '../until-migrated';
import { randomBytes, createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type CreatorPayout } from '@prisma/client';
import { membershipAuthority } from '../../repositories/membership.repository';
import { IamRepository } from '../../repositories/iam.repository';
import type { CreatorActor } from '../creator-production.service';
import {
  bankAAD,
  openBank,
  sealBank,
  usdAmount,
  decimalMinor,
  payoutState,
  type PayoutConfig,
  type PayoutPort,
  type PayoutTransfer,
} from './payout-port';
type DB = PrismaClient | Prisma.TransactionClient;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const nonceOK = (v: string) => /^[a-z0-9-]{16,80}$/i.test(v);
const IN_FLIGHT = ['REQUESTED', 'PROCESSING', 'REVIEW', 'RETURNED'];
/** All payout mutations recheck the signed membership and immutable creator binding. */
export class CreatorPayoutRepository {
  constructor(
    private db: PrismaClient,
    readonly config: PayoutConfig,
    private api: PayoutPort,
  ) {}
  private scope(p: CreatorActor) {
    return {
      ...p,
      environment: this.config.environment,
      provider: this.config.provider ?? 'PLAID',
    };
  }
  private async own(db: DB, p: CreatorActor) {
    if (p.organizationId !== this.config.organizationId) return null;
    const a = await membershipAuthority(db, p.organizationId, p.userId);
    if (!a.granted || a.systemRole !== 'CREATOR') return null;
    return db.creatorProfile.findFirst({
      where: { id: p.creatorProfileId, organizationId: p.organizationId, userId: p.userId },
    });
  }
  private async manager(db: DB, p: { organizationId: string; userId: string }) {
    if (p.organizationId !== this.config.organizationId) return false;
    const a = await membershipAuthority(db, p.organizationId, p.userId);
    return (
      a.granted &&
      ['OWNER', 'ADMIN', 'MANAGER'].includes(a.systemRole) &&
      (await new IamRepository(db as PrismaClient).can({
        ...p,
        resource: 'creatorPayouts',
        action: 'update',
      }))
    );
  }
  view(p: CreatorActor, requestedPage = 1) {
    return absentUntilMigrated(this.readView(p, requestedPage));
  }
  private async readView(p: CreatorActor, requestedPage = 1) {
    if (!(await this.own(this.db, p))) return null;
    const bank = await this.db.creatorPayoutBank.findFirst({
      where: this.scope(p),
      select: { state: true, mask: true, institution: true, consentAt: true },
    });
    const historyScope = { ...p, environment: this.config.environment };
    const total = await this.db.creatorPayout.count({ where: historyScope }),
      pages = Math.max(1, Math.ceil(total / 25)),
      page = Math.min(pages, Number.isSafeInteger(requestedPage) ? Math.max(1, requestedPage) : 1);
    const pending = await this.db.creatorPayout.count({
      where: { ...p, environment: this.config.environment, state: { in: IN_FLIGHT } },
    });
    const payouts = await this.db.creatorPayout.findMany({
      where: historyScope,
      orderBy: { createdAt: 'desc' },
      take: 25,
      skip: (page - 1) * 25,
      select: {
        id: true,
        compensationEntryId: true,
        description: true,
        amountMinor: true,
        state: true,
        requestedAt: true,
        approvedAt: true,
        failure: true,
      },
    });
    // Full scoped read model: totals must not change with the 25-row action history page.
    const earnings = await this.db.creatorPayout.findMany({
      where: historyScope,
      select: {
        id: true,
        compensationEntryId: true,
        description: true,
        amountMinor: true,
        state: true,
        approvedAt: true,
        requestedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return {
      earnings,
      environment: this.config.environment,
      paymentsEnabled: !this.config.recordingOnly,
      provider: this.config.provider ?? 'PLAID',
      bank,
      payouts,
      pending: pending > 0,
      total,
      page,
      pages,
    };
  }
  async managerView(p: { organizationId: string; userId: string }, profileId: string) {
    if (!(await this.manager(this.db, p))) return null;
    const profile = await this.db.creatorProfile.findFirst({
      where: { organizationId: p.organizationId, id: profileId },
    });
    if (!profile) return null;
    return absentUntilMigrated(
      this.db.creatorPayout.findMany({
        where: {
          organizationId: p.organizationId,
          creatorProfileId: profile.id,
          environment: this.config.environment,
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          amountMinor: true,
          description: true,
          state: true,
          approvedAt: true,
          authorizationId: true,
          transferId: true,
          failure: true,
          providerStatus: true,
          fundingAccountLabel: true,
          fundingRequestedAt: true,
          fundingStatus: true,
          fundingSweepId: true,
          releasedAt: true,
        },
      }),
    );
  }
  async approve(
    p: { organizationId: string; userId: string },
    i: {
      profileId: string;
      amountMinor: number;
      description: string;
      submission: string;
      earningReference: string;
    },
  ) {
    usdAmount(i.amountMinor);
    if (
      !nonceOK(i.submission) ||
      !/^[a-zA-Z0-9._:/-]{3,120}$/.test(i.earningReference) ||
      !i.description.trim() ||
      i.description.length > 200
    )
      return false;
    return this.db.$transaction(
      async (tx) => {
        if (!(await this.manager(tx, p))) return false;
        const profile = await tx.creatorProfile.findFirst({
          where: { organizationId: p.organizationId, id: i.profileId },
        });
        if (
          !profile?.userId ||
          !(await this.own(tx, {
            organizationId: p.organizationId,
            userId: profile.userId,
            creatorProfileId: profile.id,
          }))
        )
          return false;
        const existing = await tx.creatorPayout.findUnique({
          where: {
            organizationId_approvalSubmission: {
              organizationId: p.organizationId,
              approvalSubmission: i.submission,
            },
          },
        });
        if (existing)
          return existing.creatorProfileId === profile.id && existing.amountMinor === i.amountMinor;
        if (
          await tx.creatorPayout.findFirst({
            where: {
              organizationId: p.organizationId,
              environment: this.config.environment,
              earningReference: i.earningReference,
            },
          })
        )
          return false;
        const entry = await tx.creatorCompensationEntry.create({
          data: {
            organizationId: p.organizationId,
            creatorProfileId: profile.id,
            description: i.description.trim(),
            amountMinor: i.amountMinor,
            currency: 'USD',
            state: 'PENDING',
            occurredAt: new Date(),
            source: this.config.environment === 'sandbox' ? 'SEEDED_DEMO' : 'EMG_APPROVED',
            createdByUserId: p.userId,
          },
        });
        await tx.creatorPayout.create({
          data: {
            organizationId: p.organizationId,
            creatorProfileId: profile.id,
            userId: profile.userId,
            environment: this.config.environment,
            provider: this.config.provider ?? 'PLAID',
            compensationEntryId: entry.id,
            approvalSubmission: i.submission,
            earningReference: i.earningReference,
            approvedByUserId: p.userId,
            amountMinor: i.amountMinor,
            description: i.description.trim(),
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: p.organizationId,
            userId: p.userId,
            actorType: 'HUMAN_AGENT',
            action: 'creator.payout.approved',
            entityType: 'CreatorCompensationEntry',
            entityId: entry.id,
            metadata: {
              amountMinor: i.amountMinor,
              currency: 'USD',
              environment: this.config.environment,
              earningReference: i.earningReference,
            },
          },
        });
        return true;
      },
      { isolationLevel: 'Serializable' },
    );
  }
  async managerTotals(p: { organizationId: string; userId: string }, profileId: string) {
    if (!(await this.manager(this.db, p))) return null;
    return absentUntilMigrated(
      this.db.creatorPayout.groupBy({
        by: ['state'],
        where: {
          organizationId: p.organizationId,
          creatorProfileId: profileId,
          environment: this.config.environment,
        },
        _sum: { amountMinor: true },
      }),
    );
  }
  async fundingBalance(p: { organizationId: string; userId: string }) {
    if (!(await this.manager(this.db, p))) return null;
    try {
      const balance = await this.api.ledger();
      if (this.config.ledgerId && balance.ledger_id !== this.config.ledgerId) return null;
      return {
        availableMinor: decimalMinor(balance.balance.available),
        pendingMinor: decimalMinor(balance.balance.pending),
      };
    } catch {
      return null;
    }
  }
  async release(
    p: { organizationId: string; userId: string },
    profileId: string,
    id: string,
    confirmed: boolean,
  ) {
    if (!confirmed || !this.config.ledgerId || !(await this.manager(this.db, p))) return false;
    const balance = await this.fundingBalance(p);
    if (!balance) return false;
    return this.db.$transaction(
      async (tx) => {
        if (!(await this.manager(tx, p))) return false;
        const row = await tx.creatorPayout.findFirst({
          where: {
            id,
            organizationId: p.organizationId,
            creatorProfileId: profileId,
            environment: this.config.environment,
            state: 'PENDING',
          },
        });
        if (
          !row ||
          !(await this.own(tx, {
            organizationId: row.organizationId,
            userId: row.userId,
            creatorProfileId: row.creatorProfileId,
          }))
        )
          return false;
        if (row.provider !== (this.config.provider ?? 'PLAID')) {
          if (
            this.config.provider !== 'STRIPE' ||
            row.authorizationId ||
            row.transferId ||
            row.fundingRequestedAt ||
            row.bankId ||
            row.requestedAt ||
            row.releasedAt
          )
            return false;
        }
        // Reserve against all other released amounts. In-flight funds are conservatively retained.
        const reserved = await tx.creatorPayout.aggregate({
          where: {
            organizationId: p.organizationId,
            environment: this.config.environment,
            state: { in: ['AVAILABLE', 'REQUESTED', 'PROCESSING', 'REVIEW', 'RETURNED'] },
          },
          _sum: { amountMinor: true },
        });
        const fees = this.config.feeReserveMinor ?? 0;
        const reservedCount = fees
          ? await tx.creatorPayout.count({
              where: {
                organizationId: p.organizationId,
                environment: this.config.environment,
                state: { in: ['AVAILABLE', 'REQUESTED', 'PROCESSING', 'REVIEW', 'RETURNED'] },
              },
            })
          : 0;
        if (
          balance.availableMinor - (reserved._sum.amountMinor ?? 0) - reservedCount * fees <
          row.amountMinor + fees
        )
          return false;
        if (
          row.fundingRequestedAt &&
          (row.fundingStatus !== 'funds_available' || row.fundingLedgerId !== this.config.ledgerId)
        )
          return false;
        await tx.creatorPayout.update({
          where: { id: row.id },
          data: {
            state: 'AVAILABLE',
            provider: this.config.provider ?? 'PLAID',
            payoutLedgerId: this.config.ledgerId,
            releasedAt: new Date(),
            releasedByUserId: p.userId,
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: p.organizationId,
            userId: p.userId,
            actorType: 'HUMAN_AGENT',
            action: 'creator.payout.released',
            entityType: 'CreatorPayout',
            entityId: row.id,
            metadata: {
              amountMinor: row.amountMinor,
              availableLedgerMinor: balance.availableMinor,
            },
          },
        });
        return true;
      },
      { isolationLevel: 'Serializable' },
    );
  }
  async fund(
    p: { organizationId: string; userId: string },
    profileId: string,
    id: string,
    confirmed: boolean,
  ) {
    if (!confirmed || !this.config.fundingAccountId || !this.config.ledgerId) return false;
    const ok = await this.db.$transaction(
      async (tx) => {
        if (
          !(await this.manager(tx, p)) ||
          !(await new IamRepository(tx as PrismaClient).can({
            ...p,
            resource: 'creatorPayoutFunding',
            action: 'update',
          }))
        )
          return false;
        const row = await tx.creatorPayout.findFirst({
          where: {
            id,
            organizationId: p.organizationId,
            creatorProfileId: profileId,
            environment: this.config.environment,
            state: 'PENDING',
          },
        });
        if (!row) return false;
        if (row.fundingRequestedAt) return true;
        if (
          !(await this.own(tx, {
            organizationId: row.organizationId,
            userId: row.userId,
            creatorProfileId: row.creatorProfileId,
          }))
        )
          return false;
        await tx.creatorPayout.update({
          where: { id: row.id },
          data: {
            fundingAccountId: this.config.fundingAccountId,
            fundingAccountLabel: this.config.fundingAccountLabel ?? 'EMG registered business bank',
            fundingLedgerId: this.config.ledgerId,
            fundingRequestedAt: new Date(),
            fundingRequestedByUserId: p.userId,
            fundingStatus: 'REQUESTED',
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: p.organizationId,
            userId: p.userId,
            actorType: 'HUMAN_AGENT',
            action: 'creator.payout.funding_requested',
            entityType: 'CreatorPayout',
            entityId: row.id,
            metadata: { amountMinor: row.amountMinor, environment: this.config.environment },
          },
        });
        return true;
      },
      { isolationLevel: 'Serializable' },
    );
    if (ok) await this.processFunding(id);
    return ok;
  }
  async processFunding(id: string) {
    const now = new Date(),
      lease = new Date(+now + 60000);
    const row = await this.db.$transaction(
      async (tx) => {
        const r = await tx.creatorPayout.findFirst({
          where: {
            id,
            organizationId: this.config.organizationId,
            environment: this.config.environment,
            fundingRequestedAt: { not: null },
            OR: [{ fundingLeaseUntil: null }, { fundingLeaseUntil: { lt: now } }],
          },
        });
        if (!r) return null;
        await tx.creatorPayout.update({
          where: { id: r.id },
          data: { fundingLeaseUntil: lease, fundingCheckedAt: now },
        });
        return r;
      },
      { isolationLevel: 'Serializable' },
    );
    if (!row) return;
    try {
      if (!row.fundingAccountId || !row.fundingLedgerId) throw Error('FUNDING_NOT_CONFIGURED');
      if (
        !row.fundingSweepId &&
        (row.fundingStatus !== 'REQUESTED' ||
          !row.fundingRequestedAt ||
          +now - +row.fundingRequestedAt > 86400000)
      )
        return;
      if (!row.fundingSweepId) {
        if (
          row.fundingAccountId !== this.config.fundingAccountId ||
          row.fundingLedgerId !== this.config.ledgerId
        )
          throw Error('FUNDING_SOURCE_CHANGED');
        const actor = {
          organizationId: row.organizationId,
          userId: row.fundingRequestedByUserId ?? '',
        };
        if (
          !(await this.manager(this.db, actor)) ||
          !(await new IamRepository(this.db).can({
            ...actor,
            resource: 'creatorPayoutFunding',
            action: 'update',
          }))
        )
          throw Error('FUNDING_REVOKED');
      }
      const sweep = row.fundingSweepId
        ? await this.api.sweep(row.fundingSweepId)
        : await this.api.deposit(usdAmount(row.amountMinor), row.id);
      if (
        !sweep.id ||
        sweep.ledger_id !== row.fundingLedgerId ||
        sweep.funding_account_id !== row.fundingAccountId ||
        sweep.iso_currency_code !== 'USD' ||
        sweep.amount !== `-${usdAmount(row.amountMinor)}` ||
        (row.fundingSweepId && row.fundingSweepId !== sweep.id)
      )
        throw Error('FUNDING_MISMATCH');
      await this.db.$transaction(async (tx) => {
        await tx.creatorPayout.updateMany({
          where: { id: row.id, fundingLeaseUntil: lease },
          data: { fundingSweepId: sweep.id, fundingStatus: sweep.status ?? 'UNKNOWN' },
        });
        if (['returned', 'failed'].includes(sweep.status ?? ''))
          await tx.creatorPayout.updateMany({
            where: { id: row.id, state: 'AVAILABLE', fundingLeaseUntil: lease },
            data: { state: 'PENDING' },
          });
      });
    } catch {
      await this.db.creatorPayout.updateMany({
        where: { id: row.id, fundingLeaseUntil: lease },
        data: { fundingStatus: 'REVIEW' },
      });
    } finally {
      await this.db.creatorPayout.updateMany({
        where: { id: row.id, fundingLeaseUntil: lease },
        data: { fundingLeaseUntil: null },
      });
    }
  }
  async cancel(p: { organizationId: string; userId: string }, profileId: string, id: string) {
    return this.db.$transaction(
      async (tx) => {
        if (!(await this.manager(tx, p))) return false;
        const row = await tx.creatorPayout.findFirst({
          where: {
            id,
            organizationId: p.organizationId,
            creatorProfileId: profileId,
            environment: this.config.environment,
            AND: [
              {
                OR: [
                  { state: { in: ['PENDING', 'AVAILABLE'] } },
                  {
                    state: 'REVIEW',
                    providerStatus: {
                      in: [
                        'failed',
                        'cancelled',
                        'authorization.declined',
                        'authorization.user_action_required',
                      ],
                    },
                  },
                ],
              },
              { OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
            ],
          },
        });
        if (!row) return false;
        await tx.creatorPayout.update({ where: { id: row.id }, data: { state: 'CANCELLED' } });
        await tx.auditLog.create({
          data: {
            organizationId: p.organizationId,
            userId: p.userId,
            actorType: 'HUMAN_AGENT',
            action: 'creator.payout.approval_cancelled',
            entityType: 'CreatorPayout',
            entityId: row.id,
          },
        });
        return true;
      },
      { isolationLevel: 'Serializable' },
    );
  }
  /** Stripe-hosted onboarding. Only opaque recipient/method IDs are persisted, encrypted. */
  async beginHostedLink(
    p: CreatorActor,
    legalName: string,
    consent: boolean,
    entityType: 'individual' | 'company',
  ) {
    const hosted = this.api.hostedOnboarding;
    if (
      this.config.provider !== 'STRIPE' ||
      this.config.recordingOnly ||
      !hosted ||
      !this.config.redirectUri ||
      !consent ||
      !legalName.trim() ||
      legalName.length > 150 ||
      !['individual', 'company'].includes(entityType)
    )
      throw Error('BANK_LINK_UNAVAILABLE');
    const claim = await this.db.$transaction(
      async (tx) => {
        if (
          !(await this.own(tx, p)) ||
          (await tx.creatorPayout.count({
            where: { ...p, environment: this.config.environment, state: { in: IN_FLIGHT } },
          }))
        )
          return null;
        const old = await tx.creatorPayoutBank.findFirst({
          where: { ...p, environment: this.config.environment },
        });
        if (old && ['CONNECTED', 'DISCONNECTING'].includes(old.state)) return null;
        if (
          (await tx.creatorPayoutLink.count({
            where: { ...this.scope(p), createdAt: { gte: new Date(Date.now() - 3600000) } },
          })) >= 5
        )
          return null;
        const nonce = randomBytes(32).toString('hex');
        const row = await tx.creatorPayoutLink.create({
          data: {
            ...this.scope(p),
            nonceHash: hash(nonce),
            legalName: legalName.trim(),
            expiresAt: new Date(Date.now() + 600000),
          },
        });
        const user = await tx.user.findFirst({
          where: { id: p.userId, organizationId: p.organizationId },
          select: { email: true },
        });
        return user ? { row, nonce, email: user.email } : null;
      },
      { isolationLevel: 'Serializable' },
    );
    if (!claim) throw Error('BANK_LINK_UNAVAILABLE');
    const recipient = await hosted.recipient({
      email: claim.email,
      name: legalName.trim(),
      entityType,
      id: claim.row.id,
    });
    if (!(await this.own(this.db, p))) throw Error('AUTHORIZATION_WITHDRAWN');
    await this.db.creatorPayoutLink.update({
      where: { id: claim.row.id },
      data: { recipientId: recipient },
    });
    const url = await hosted.link(
      recipient,
      `${this.config.redirectUri}?bank_session=${claim.nonce}`,
    );
    return { url };
  }
  async refreshHostedLink(p: CreatorActor, nonce: string) {
    if (
      this.config.provider !== 'STRIPE' ||
      this.config.recordingOnly ||
      !this.api.hostedOnboarding ||
      !this.config.redirectUri ||
      !/^[a-f0-9]{64}$/.test(nonce)
    )
      throw Error('BANK_LINK_UNAVAILABLE');
    const next = await this.db.$transaction(
      async (tx) => {
        if (
          !(await this.own(tx, p)) ||
          (await tx.creatorPayout.count({
            where: { ...p, environment: this.config.environment, state: { in: IN_FLIGHT } },
          }))
        )
          return null;
        const session = await tx.creatorPayoutLink.findFirst({
          where: {
            ...this.scope(p),
            nonceHash: hash(nonce),
            consumedAt: null,
            expiresAt: { gt: new Date() },
          },
        });
        if (
          !session?.recipientId ||
          (await tx.creatorPayoutLink.count({
            where: { ...this.scope(p), createdAt: { gte: new Date(Date.now() - 3600000) } },
          })) >= 5
        )
          return null;
        const old = await tx.creatorPayoutBank.findFirst({
          where: { ...p, environment: this.config.environment },
        });
        if (old && ['CONNECTED', 'DISCONNECTING'].includes(old.state)) return null;
        const claimed = await tx.creatorPayoutLink.updateMany({
          where: { id: session.id, consumedAt: null, expiresAt: { gt: new Date() } },
          data: { consumedAt: new Date() },
        });
        if (claimed.count !== 1) return null;
        const fresh = randomBytes(32).toString('hex');
        await tx.creatorPayoutLink.create({
          data: {
            ...this.scope(p),
            nonceHash: hash(fresh),
            legalName: session.legalName,
            recipientId: session.recipientId,
            expiresAt: new Date(Date.now() + 600000),
          },
        });
        return { nonce: fresh, recipient: session.recipientId };
      },
      { isolationLevel: 'Serializable' },
    );
    if (!next) throw Error('BANK_LINK_UNAVAILABLE');
    if (!(await this.own(this.db, p))) throw Error('AUTHORIZATION_WITHDRAWN');
    return {
      url: await this.api.hostedOnboarding.link(
        next.recipient,
        `${this.config.redirectUri}?bank_session=${next.nonce}`,
      ),
    };
  }
  async finishHostedLink(p: CreatorActor, nonce: string) {
    if (
      this.config.provider !== 'STRIPE' ||
      !this.api.hostedOnboarding ||
      !/^([a-f0-9]{64})$/.test(nonce) ||
      !(await this.own(this.db, p))
    )
      return false;
    const session = await this.db.creatorPayoutLink.findFirst({
      where: {
        ...this.scope(p),
        nonceHash: hash(nonce),
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!session?.recipientId) return false;
    const bank = await this.api.hostedOnboarding.inspect(session.recipientId);
    if (!bank) return false;
    return this.db.$transaction(
      async (tx) => {
        if (
          !(await this.own(tx, p)) ||
          (await tx.creatorPayout.count({
            where: { ...p, environment: this.config.environment, state: { in: IN_FLIGHT } },
          }))
        )
          return false;
        const used = await tx.creatorPayoutLink.updateMany({
          where: { id: session.id, consumedAt: null, expiresAt: { gt: new Date() } },
          data: { consumedAt: new Date() },
        });
        if (used.count !== 1) return false;
        const previous = await tx.creatorPayoutBank.findFirst({
          where: { ...p, environment: this.config.environment },
        });
        if (previous && ['CONNECTED', 'DISCONNECTING'].includes(previous.state)) return false;
        const data = {
          provider: 'STRIPE',
          userId: p.userId,
          sealed: sealBank(
            {
              accessToken: session.recipientId!,
              itemId: session.recipientId!,
              accountId: bank.accountId,
            },
            this.config.key,
            bankAAD(p, this.config.environment),
          ),
          mask: bank.mask,
          institution: bank.institution,
          legalName: session.legalName,
          verifiedAt: new Date(),
          consentVersion: 'stripe-ach-credit-v1',
          consentAt: new Date(),
          state: 'CONNECTED',
        };
        await tx.creatorPayoutBank.upsert({
          where: {
            organizationId_creatorProfileId_environment: {
              organizationId: p.organizationId,
              creatorProfileId: p.creatorProfileId,
              environment: this.config.environment,
            },
          },
          create: { ...p, environment: this.config.environment, ...data },
          update: { ...data, revision: { increment: 1 } },
        });
        return true;
      },
      { isolationLevel: 'Serializable' },
    );
  }
  async beginLink(p: CreatorActor, legalName: string, consent: boolean) {
    if (this.config.recordingOnly) throw Error('PLAID_NOT_CONFIGURED');
    if (!consent || !legalName.trim() || legalName.length > 150 || !(await this.own(this.db, p)))
      throw Error('BANK_LINK_UNAVAILABLE');
    if (
      await this.db.creatorPayout.count({ where: { ...this.scope(p), state: { in: IN_FLIGHT } } })
    )
      throw Error('PAYOUT_PENDING');
    const recent = await this.db.creatorPayoutLink.count({
      where: { ...this.scope(p), createdAt: { gte: new Date(Date.now() - 3600000) } },
    });
    if (recent >= 5) throw Error('LINK_LIMIT');
    const nonce = randomBytes(32).toString('base64url'),
      linkToken = await this.api.link(`${p.organizationId}:${p.userId}`);
    if (!(await this.own(this.db, p))) throw Error('BANK_LINK_UNAVAILABLE');
    await this.db.creatorPayoutLink.create({
      data: {
        ...this.scope(p),
        nonceHash: hash(nonce),
        legalName: legalName.trim(),
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    return { nonce, linkToken };
  }
  async finishLink(p: CreatorActor, nonce: string, publicToken: string, accountId: string) {
    if (
      nonce.length > 100 ||
      publicToken.length > 300 ||
      accountId.length > 200 ||
      !publicToken ||
      !accountId
    )
      return false;
    // Claim once before exchanging a token. A failed exchange requires a new Link session.
    const session = await this.db.$transaction(
      async (tx) => {
        if (!(await this.own(tx, p))) return null;
        const s = await tx.creatorPayoutLink.findFirst({
          where: {
            ...this.scope(p),
            nonceHash: hash(nonce),
            consumedAt: null,
            expiresAt: { gt: new Date() },
          },
        });
        if (!s) return null;
        const claim = await tx.creatorPayoutLink.updateMany({
          where: { id: s.id, consumedAt: null },
          data: { consumedAt: new Date() },
        });
        return claim.count ? s : null;
      },
      { isolationLevel: 'Serializable' },
    );
    if (!session) return false;
    const token = await this.api.exchange(publicToken);
    try {
      if (typeof token.access_token !== 'string' || typeof token.item_id !== 'string')
        throw Error('INVALID_BANK');
      const accounts = await this.api.accounts(token.access_token),
        bank = accounts.find((a) => a.account_id === accountId);
      if (
        !bank ||
        bank.type !== 'depository' ||
        !['checking', 'savings'].includes(bank.subtype ?? '') ||
        bank.balances.iso_currency_code !== 'USD' ||
        !/^\d{2,4}$/.test(bank.mask ?? '')
      )
        throw Error('INVALID_BANK');
      const ok = await this.db.$transaction(
        async (tx) => {
          if (
            !(await this.own(tx, p)) ||
            (await tx.creatorPayout.count({
              where: { ...p, environment: this.config.environment, state: { in: IN_FLIGHT } },
            }))
          )
            return false;
          // Require explicit disconnect before replacement: no orphaned provider Item.
          const previous = await tx.creatorPayoutBank.findUnique({
            where: {
              organizationId_creatorProfileId_environment: {
                organizationId: p.organizationId,
                creatorProfileId: p.creatorProfileId,
                environment: this.config.environment,
              },
            },
          });
          if (previous?.state === 'CONNECTED') return false;
          const data = {
            userId: p.userId,
            provider: this.config.provider ?? 'PLAID',
            sealed: sealBank(
              { accessToken: token.access_token, accountId, itemId: token.item_id },
              this.config.key,
              bankAAD(p, this.config.environment),
            ),
            mask: bank.mask!,
            institution: bank.name.slice(0, 100),
            legalName: session.legalName,
            consentVersion: 'ach-credit-v1',
            consentAt: new Date(),
            state: 'CONNECTED',
          };
          await tx.creatorPayoutBank.upsert({
            where: {
              organizationId_creatorProfileId_environment: {
                organizationId: p.organizationId,
                creatorProfileId: p.creatorProfileId,
                environment: this.config.environment,
              },
            },
            create: { ...this.scope(p), ...data },
            update: { ...data, revision: { increment: 1 } },
          });
          return true;
        },
        { isolationLevel: 'Serializable' },
      );
      if (!ok) await this.api.remove(token.access_token);
      return ok;
    } catch {
      await this.api.remove(token.access_token).catch(() => {});
      throw Error('BANK_LINK_UNAVAILABLE');
    }
  }
  async disconnect(p: CreatorActor) {
    const sealed = await this.db.$transaction(
      async (tx) => {
        if (
          !(await this.own(tx, p)) ||
          (await tx.creatorPayout.count({ where: { ...this.scope(p), state: { in: IN_FLIGHT } } }))
        )
          return null;
        const bank = await tx.creatorPayoutBank.findFirst({
          where: { ...this.scope(p), state: { in: ['CONNECTED', 'DISCONNECTING'] } },
        });
        if (!bank?.sealed) return null;
        await tx.creatorPayoutBank.update({
          where: { id: bank.id },
          data: { state: 'DISCONNECTING' },
        });
        return bank;
      },
      { isolationLevel: 'Serializable' },
    );
    if (!sealed?.sealed) return false;
    // Keep encrypted credentials until provider revocation succeeds; a failed removal remains visibly pending.
    await this.api.remove(
      openBank(sealed.sealed, this.config.key, bankAAD(p, this.config.environment)).accessToken,
    );
    await this.db.creatorPayoutBank.updateMany({
      where: { id: sealed.id, state: 'DISCONNECTING' },
      data: { state: 'DISCONNECTED', sealed: null, revision: { increment: 1 } },
    });
    return true;
  }
  async request(p: CreatorActor, payoutId: string, confirmed: boolean) {
    if (this.config.recordingOnly) return null;
    if (!confirmed) return null;
    return this.db.$transaction(
      async (tx) => {
        if (!(await this.own(tx, p))) return null;
        const row = await tx.creatorPayout.findFirst({ where: { ...this.scope(p), id: payoutId } });
        if (!row) return null;
        if (row.state !== 'AVAILABLE')
          return ['PENDING', 'CANCELLED'].includes(row.state) ? null : row.id;
        const bank = await tx.creatorPayoutBank.findFirst({
          where: { ...this.scope(p), state: 'CONNECTED' },
        });
        if (!bank?.sealed) return null;
        // The manager's approval is the immutable amount; no client amount or destination is accepted.
        await tx.creatorPayout.update({
          where: { id: row.id },
          data: {
            state: 'REQUESTED',
            bankId: bank.id,
            bankRevision: bank.revision,
            requestedAt: new Date(),
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: p.organizationId,
            userId: p.userId,
            actorType: 'HUMAN_AGENT',
            action: 'creator.payout.requested',
            entityType: 'CreatorPayout',
            entityId: row.id,
            metadata: { amountMinor: row.amountMinor, environment: this.config.environment },
          },
        });
        return row.id;
      },
      { isolationLevel: 'Serializable' },
    );
  }
  /** Refresh only already-submitted transfers owned by the signed creator; never initiate one. */
  async refreshTransfers(p: CreatorActor) {
    if (this.config.recordingOnly || !(await this.own(this.db, p))) return false;
    const rows = await this.db.creatorPayout.findMany({
      where: {
        ...this.scope(p),
        transferId: { not: null },
        state: { in: ['PROCESSING', 'REVIEW', 'PAID'] },
        OR: [{ checkedAt: null }, { checkedAt: { lt: new Date(Date.now() - 60000) } }],
      },
      orderBy: { checkedAt: 'asc' },
      take: 10,
      select: { id: true },
    });
    for (const row of rows) await this.process(row.id);
    return true;
  }
  async process(id: string) {
    if (this.config.recordingOnly) return;
    const now = new Date(),
      row = await this.db.$transaction(
        async (tx) => {
          const r = await tx.creatorPayout.findFirst({
            where: {
              id,
              provider: this.config.provider ?? 'PLAID',
              organizationId: this.config.organizationId,
              environment: this.config.environment,
              state: { in: ['REQUESTED', 'PROCESSING', 'REVIEW', 'PAID'] },
              OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
            },
          });
          if (!r) return null;
          await tx.creatorPayout.update({
            where: { id: r.id },
            data: { leaseUntil: new Date(+now + 90000), checkedAt: now },
          });
          return r;
        },
        { isolationLevel: 'Serializable' },
      );
    if (!row) return;
    try {
      // Existing transfers can always be reconciled, even following disconnection/offboarding.
      if (row.authorizationId || row.transferId) {
        if (row.transferId || row.state !== 'REQUESTED') {
          const transfer = await this.api.get({
            transferId: row.transferId ?? undefined,
            authorizationId: row.authorizationId ?? undefined,
          });
          await this.record(row, transfer);
          return;
        }
      }
      if (row.state !== 'REQUESTED') return;
      if (row.payoutLedgerId !== this.config.ledgerId) throw Error('PAYOUT_SOURCE_CHANGED');
      if (row.fundingRequestedAt && row.fundingStatus !== 'funds_available')
        throw Error('FUNDING_NOT_AVAILABLE');
      // Unknown authorization after 24h is never recreated (provider idempotency expires at 48h).
      if (!row.requestedAt || +now - +row.requestedAt > 86400000) throw Error('REQUIRES_REVIEW');
      const p = {
        organizationId: row.organizationId,
        userId: row.userId,
        creatorProfileId: row.creatorProfileId,
      };
      if (!(await this.own(this.db, p))) throw Error('AUTHORIZATION_WITHDRAWN');
      const bank = await this.db.creatorPayoutBank.findFirst({
        where: {
          ...this.scope(p),
          id: row.bankId ?? '',
          revision: row.bankRevision ?? 0,
          state: 'CONNECTED',
        },
      });
      if (!bank?.sealed) throw Error('BANK_UNAVAILABLE');
      const secret = openBank(bank.sealed, this.config.key, bankAAD(p, this.config.environment));
      let authorizationId = row.authorizationId;
      if (!authorizationId) {
        const auth = await this.api.authorize({
          accessToken: secret.accessToken,
          accountId: secret.accountId,
          legalName: bank.legalName,
          amount: usdAmount(row.amountMinor),
          id: row.id,
        });
        if (auth.decision !== 'approved' || !auth.id) {
          if (auth.id && ['declined', 'user_action_required'].includes(auth.decision)) {
            await this.db.creatorPayout.update({
              where: { id: row.id },
              data: {
                authorizationId: auth.id,
                state: 'REVIEW',
                providerStatus: `authorization.${auth.decision}`,
                failure: 'AUTHORIZATION_NOT_APPROVED',
              },
            });
            return;
          }
          throw Error('AUTHORIZATION_NOT_APPROVED');
        }
        authorizationId = auth.id;
        await this.db.creatorPayout.update({ where: { id: row.id }, data: { authorizationId } });
      }
      // Recheck just before the only operation that moves money.
      if (
        !(await this.own(this.db, p)) ||
        !(await this.db.creatorPayoutBank.findFirst({
          where: { ...this.scope(p), id: bank.id, revision: bank.revision, state: 'CONNECTED' },
        }))
      )
        throw Error('AUTHORIZATION_WITHDRAWN');
      const transfer = await this.api.create(
        authorizationId,
        secret.accessToken,
        secret.accountId,
        row.id,
        usdAmount(row.amountMinor),
      );
      if (transfer.account_id !== secret.accountId) throw Error('PROVIDER_MISMATCH');
      await this.record({ ...row, authorizationId }, transfer);
    } catch {
      // Ambiguity never releases a reservation or invents a completed transfer.
      await this.db.creatorPayout.update({
        where: { id: row.id },
        data: { state: 'REVIEW', failure: 'EMG_REVIEW_REQUIRED' },
      });
    } finally {
      await this.db.creatorPayout.update({ where: { id: row.id }, data: { leaseUntil: null } });
    }
  }
  private async record(row: CreatorPayout, t: PayoutTransfer) {
    if (
      !t.id ||
      t.type !== 'credit' ||
      t.amount !== usdAmount(row.amountMinor) ||
      (row.transferId && t.id !== row.transferId) ||
      (t.authorization_id && row.authorizationId && t.authorization_id !== row.authorizationId) ||
      (this.config.environment === 'production' && t.ledger_id !== row.payoutLedgerId)
    )
      throw Error('PROVIDER_MISMATCH');
    // Validate the bound recipient even when reconciling after their membership was revoked.
    const bank = await this.db.creatorPayoutBank.findUnique({ where: { id: row.bankId ?? '' } });
    if (bank?.sealed) {
      const secret = openBank(bank.sealed, this.config.key, bankAAD(row, this.config.environment));
      if (t.account_id !== secret.accountId) throw Error('PROVIDER_MISMATCH');
    } else if (!row.transferId) throw Error('PROVIDER_MISMATCH');
    if (this.config.provider === 'STRIPE' && bank?.sealed) {
      const secret = openBank(bank.sealed, this.config.key, bankAAD(row, this.config.environment));
      if (t.recipient_id !== secret.accessToken) throw Error('PROVIDER_MISMATCH');
    }
    const state = payoutState(t.status, this.config.provider);
    await this.db.creatorPayout.update({
      where: { id: row.id },
      data: {
        transferId: t.id,
        state,
        providerStatus: t.status,
        failure: ['REVIEW', 'RETURNED'].includes(state) ? 'EMG_REVIEW_REQUIRED' : null,
      },
    });
  }
  async sweep() {
    const deadline = Date.now() + 25000;
    const rows = await this.db.creatorPayout.findMany({
      where: {
        organizationId: this.config.organizationId,
        provider: this.config.provider ?? 'PLAID',
        environment: this.config.environment,
        OR: [
          { state: { in: ['REQUESTED', 'PROCESSING', 'REVIEW'] } },
          { state: 'PAID', requestedAt: { gte: new Date(Date.now() - 90 * 86400000) } },
        ],
      },
      orderBy: [{ checkedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      take: 10,
    });
    let checked = 0;
    for (const r of rows) {
      if (Date.now() > deadline) break;
      await this.process(r.id);
      checked++;
    }
    const funding = await this.db.creatorPayout.findMany({
      where: {
        organizationId: this.config.organizationId,
        provider: this.config.provider ?? 'PLAID',
        environment: this.config.environment,
        fundingRequestedAt: { not: null },
        OR: [
          {
            fundingStatus: {
              in: ['REQUESTED', 'pending', 'posted', 'settled', 'REVIEW', 'UNKNOWN'],
            },
          },
          {
            fundingStatus: 'funds_available',
            fundingRequestedAt: { gte: new Date(Date.now() - 90 * 86400000) },
          },
        ],
      },
      orderBy: { fundingCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: 10,
    });
    for (const row of funding) {
      if (Date.now() > deadline) break;
      await this.processFunding(row.id);
    }
    const banks = await this.db.creatorPayoutBank.findMany({
      where: {
        organizationId: this.config.organizationId,
        provider: this.config.provider ?? 'PLAID',
        environment: this.config.environment,
        state: { in: ['CONNECTED', 'DISCONNECTING'] },
      },
      orderBy: { verifiedAt: { sort: 'asc', nulls: 'first' } },
      take: 10,
    });
    for (const bank of banks) {
      if (Date.now() > deadline) break;
      const p = {
        organizationId: bank.organizationId,
        userId: bank.userId,
        creatorProfileId: bank.creatorProfileId,
      };
      try {
        if (bank.state === 'DISCONNECTING' || !(await this.own(this.db, p))) {
          if (bank.sealed)
            await this.api.remove(
              openBank(bank.sealed, this.config.key, bankAAD(p, this.config.environment))
                .accessToken,
            );
          await this.db.creatorPayoutBank.updateMany({
            where: { id: bank.id, revision: bank.revision },
            data: { state: 'DISCONNECTED', sealed: null, revision: { increment: 1 } },
          });
        }
      } catch {
        /* Retry provider revocation on the next bounded pass. */
      } finally {
        await this.db.creatorPayoutBank.updateMany({
          where: { id: bank.id },
          data: { verifiedAt: new Date() },
        });
      }
    }
    await this.db.creatorPayoutLink.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 86400000) } },
    });
    return checked;
  }
}
