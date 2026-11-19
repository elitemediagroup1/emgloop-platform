import { creatorPayoutLedger } from '../../../../creator/creator-payout-runtime';
import { CreatorBankPanel, CreatorPaymentsPanel } from '../../../../creator/creator-payments-panel';
import Link from 'next/link';
import { CreatorPageHead } from '../../../../creator/creator-page-head';
import { creatorPaymentEarnings } from '../../../../creator/creator-earnings';
import { requireWorkspace } from '../../../../workspaces/guard';
import { creatorDomain, requireCreator } from '../../../../creator/creator-runtime';
import { viewerTime } from '../../../../time/viewer-time';
import { LoopPage } from '../../_loop-os/record';
import { EarningsBody } from '../_parts/earnings-body';

// Earnings (Creator Hub). The body carries the rule: only AVAILABLE is money the creator can act
// on. Bank requests have their own server-authorized payout panel below the compensation ledger.

export const dynamic = 'force-dynamic';

export default async function CreatorEarningsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  await requireWorkspace('CREATOR');
  const seat = await requireCreator();
  const time = viewerTime();
  const earnings = await creatorDomain().records.earnings(
    seat.actor.organizationId,
    seat.profileId,
  );
  const paymentView = await creatorPayoutLedger(seat.actor.organizationId).view(
    seat.actor,
    typeof searchParams.payoutPage === 'string' ? Number.parseInt(searchParams.payoutPage, 10) : 1,
  );
  const sandbox = paymentView?.environment === 'sandbox';
  const currencies = [
    ...new Set(earnings.entries.filter((e) => e.source !== 'SEEDED_DEMO').map((e) => e.currency)),
  ];
  const real = creatorPaymentEarnings(
    earnings,
    paymentView,
    typeof searchParams.currency === 'string' ? searchParams.currency : undefined,
  );
  return (
    <LoopPage label="Payments">
      <CreatorPageHead
        section="Payments"
        title="Your earnings, clearly tracked."
        description="Follow compensation from expected to approved and paid, with the campaign and status behind each entry."
      />
      {!sandbox && currencies.length > 1 ? (
        <nav className="ch-analytics-tabs" aria-label="Payment currency">
          {currencies.map((currency) => (
            <Link
              key={currency}
              className="ch-analytics-tab"
              href={`/app/creator/earnings?currency=${encodeURIComponent(currency)}`}
              aria-current={currency === real.currency ? 'page' : undefined}
            >
              {currency}
            </Link>
          ))}
        </nav>
      ) : null}

      {sandbox ? (
        <p className="ch-test-banner" role="note">
          <strong>Sandbox testing — no real money moves.</strong> All totals and transactions below
          show test payouts only.
        </p>
      ) : null}
      <EarningsBody
        earnings={real}
        time={time}
        payoutSetup={<CreatorBankPanel view={paymentView} />}
      />
      <CreatorPaymentsPanel
        view={paymentView}
        outcome={typeof searchParams.payout === 'string' ? searchParams.payout : undefined}
      />
    </LoopPage>
  );
}
