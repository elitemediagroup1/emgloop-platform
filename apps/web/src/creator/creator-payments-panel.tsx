import { viewerTime } from '../time/viewer-time';
import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import type { CreatorActor, EmgActor } from '@emgloop/database';
import { creatorPayoutLedger } from './creator-payout-runtime';
import { CreatorBankLink } from './creator-bank-link';
import {
  approveCreatorPayout,
  fundCreatorPayout,
  releaseCreatorPayout,
  cancelCreatorPayout,
  disconnectCreatorBank,
  requestCreatorPayout,
} from './creator-payout-actions';
const money = (v: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v / 100);
const labels: Record<string, string> = {
  PENDING: 'Recorded · awaiting manager release',
  CANCELLED: 'Approval cancelled',
  AVAILABLE: 'Approved · ready to request',
  REQUESTED: 'Transfer requested',
  PROCESSING: 'Transfer in progress',
  PAID: 'Sent to your bank',
  REVIEW: 'EMG is reviewing this transfer',
  RETURNED: 'Returned · EMG review required',
};
export async function CreatorPaymentsPanel({
  actor,
  outcome,
  page = 1,
}: {
  page?: number;
  actor: CreatorActor;
  outcome?: string;
}) {
  const service = creatorPayoutLedger(actor.organizationId),
    view = await service?.view(actor, page);
  const time = viewerTime();
  return (
    <section className="ch-payout-panel" id="bank-payments">
      <div>
        <span className="ch-eyebrow">Bank payments</span>
        <h2>Your payout account</h2>
        <p>
          Only earnings explicitly approved by your manager can be requested. “Sent” means funds
          left Stripe; receipt and ACH timing depend on bank processing and EMG’s funded payout
          balance.
        </p>
      </div>
      {outcome ? (
        <p role="status">
          {outcome === 'bank-connected'
            ? 'Your bank account is connected.'
            : outcome === 'requested'
              ? 'Your request has been recorded. Follow its status below.'
              : outcome === 'disconnected'
                ? 'Your bank connection has been removed.'
                : 'This action needs review. No new amount has been marked paid.'}
        </p>
      ) : null}
      {!view ? (
        <p>
          Bank payments are awaiting EMG’s payment-service setup. Your recorded earnings remain
          available above. <Link href="/app/creator/tasks#team">Ask your EMG team →</Link>
        </p>
      ) : (
        <>
          {view.environment === 'sandbox' ? (
            <p className="ch-test-banner" role="note">
              <strong>Sandbox testing — no real money moves.</strong> Test approvals are excluded
              from your earnings totals.
            </p>
          ) : null}
          {!view.paymentsEnabled ? (
            <p>
              Bank payments are awaiting EMG’s Stripe setup. Your recorded balance is tracked here;
              no withdrawal can start yet.
            </p>
          ) : view.bank?.state === 'CONNECTED' ? (
            <div className="ch-bank-connected">
              <strong>
                {view.bank.institution} ···· {view.bank.mask}
              </strong>
              <p>Connected securely. Loop does not store your bank account or routing number.</p>
              <form action={disconnectCreatorBank}>
                <button className="loop-btn" disabled={view.pending}>
                  Disconnect bank
                </button>
              </form>
            </div>
          ) : view.bank?.state === 'DISCONNECTING' ? (
            <div>
              <p>Bank disconnection is pending.</p>
              <form action={disconnectCreatorBank}>
                <button className="loop-btn">Retry disconnection</button>
              </form>
            </div>
          ) : (
            <CreatorBankLink />
          )}
          <h3>{view.environment === 'sandbox' ? 'Test payouts' : 'Approved payouts'}</h3>
          {!view.payouts.length ? (
            <p>
              No manager-approved payouts yet. Once approved, each amount and its status will appear
              here.
            </p>
          ) : (
            <ul className="ch-payout-list">
              {view.payouts.map((p) => (
                <li key={p.id}>
                  <div>
                    <strong>{p.description}</strong>
                    <p className="loop-note">
                      Approved {time.date(p.approvedAt)}
                      {p.requestedAt ? ` · Requested ${time.dateTime(p.requestedAt)}` : ''}
                    </p>
                    <p>
                      {money(p.amountMinor)} · {labels[p.state] ?? 'Awaiting review'}
                    </p>
                  </div>
                  {view.paymentsEnabled &&
                  p.state === 'AVAILABLE' &&
                  view.bank?.state === 'CONNECTED' ? (
                    <form action={requestCreatorPayout}>
                      <input type="hidden" name="payoutId" value={p.id} />
                      <label className="ch-consent">
                        <input type="checkbox" name="confirm" value="yes" required />
                        Send {money(p.amountMinor)} to account ending {view.bank.mask}.
                      </label>
                      <button className="loop-btn loop-btn--primary">
                        {view.environment === 'sandbox' ? 'Simulate payout' : 'Request payout'}
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {view.pages > 1 ? (
            <nav className="ch-pagination" aria-label="Payout history pages">
              {view.page > 1 ? (
                <Link href={`/app/creator/earnings?payoutPage=${view.page - 1}#bank-payments`}>
                  Previous
                </Link>
              ) : null}
              <span>
                Page {view.page} of {view.pages} · {view.total} payouts
              </span>
              {view.page < view.pages ? (
                <Link href={`/app/creator/earnings?payoutPage=${view.page + 1}#bank-payments`}>
                  Next
                </Link>
              ) : null}
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}
export async function ManagerPaymentsPanel({
  actor,
  profileId,
  outcome,
}: {
  actor: EmgActor;
  profileId: string;
  outcome?: string;
}) {
  const service = creatorPayoutLedger(actor.organizationId),
    rows = await service.managerView(actor, profileId);
  const [totals, balance] = rows
    ? await Promise.all([service.managerTotals(actor, profileId), service.fundingBalance(actor)])
    : [null, null];
  const sum = (states: string[]) =>
    totals
      ?.filter((r) => states.includes(r.state))
      .reduce((total, r) => total + (r._sum.amountMinor ?? 0), 0) ?? 0;
  const message: Record<string, string> = {
    approved: 'Earning recorded as pending. It is not withdrawable.',
    funding: 'Funding instruction recorded. Wait for funds to become available before release.',
    released: 'Amount marked available for this creator to request.',
    cancelled: 'Unpaid earning cancelled.',
  };
  return (
    <section className="loop-panel" id="creator-payments">
      <h2>Creator earnings &amp; payout control</h2>
      {outcome ? (
        <p role="status">
          {message[outcome] ??
            'Action not completed. Check permissions, available funding and the current payment state.'}
        </p>
      ) : null}
      {!rows ? (
        <p>
          Payment records are unavailable for this login or database setup. No balance has been
          changed.
        </p>
      ) : (
        <>
          <p>
            Record this creator’s earnings, move funding from EMG’s registered bank when needed,
            then explicitly release the amount for withdrawal. Recording a balance never makes it
            available automatically.
          </p>
          {service.config.environment === 'sandbox' ? (
            <p className="ch-test-banner">Sandbox — test amounts only. No real money moves.</p>
          ) : null}
          <dl className="ch-manager-balances">
            {[
              ['Recorded / pending', sum(['PENDING'])],
              ['Available to withdraw', sum(['AVAILABLE'])],
              ['Transfer / review', sum(['REQUESTED', 'PROCESSING', 'REVIEW', 'RETURNED'])],
              ['Paid', sum(['PAID'])],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{money(Number(value))}</dd>
              </div>
            ))}
          </dl>
          <details className="ch-manager-funding">
            <summary>EMG payout funding pool</summary>
            {balance ? (
              <p>
                Available at Stripe: <strong>{money(balance.availableMinor)}</strong> · Incoming
                funding: {money(balance.pendingMinor)}. This pool serves all creators; other
                released amounts remain reserved.
              </p>
            ) : (
              <p>
                Funding balance unavailable. You can record earnings, but release requires a
                verified funded balance and enabled Stripe Global Payouts.
              </p>
            )}
            <p>
              Fund Stripe from EMG’s registered business bank. The creator’s bank is only a payout
              destination. A deposit request is not proof that funds are available.
            </p>
          </details>
          <p className="loop-note">
            Stripe funding and bank authorization are completed in the Stripe Dashboard. Returning
            here does not mark earnings available automatically.
          </p>
          <a
            className="loop-btn"
            href="https://dashboard.stripe.com/treasury"
            target="_blank"
            rel="noreferrer noopener"
          >
            Manage EMG funding in Stripe ↗
          </a>
          <h3>1. Record an earning</h3>
          <form action={approveCreatorPayout} className="ch-manager-payment">
            <input type="hidden" name="profileId" value={profileId} />
            <input type="hidden" name="submission" value={randomUUID()} />
            <label>
              Unique earning or invoice reference
              <input
                name="earningReference"
                required
                minLength={3}
                maxLength={120}
                pattern="[a-zA-Z0-9._:/-]+"
              />
            </label>
            <label>
              Description
              <input name="description" required maxLength={200} />
            </label>
            <label>
              Net creator amount (USD)
              <input name="amount" inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" required />
            </label>
            <label className="ch-consent">
              <input type="checkbox" name="confirm" value="yes" required />I verified this net
              amount is owed and has not already been recorded or paid. This records pending
              earnings only.
            </label>
            <button className="loop-btn loop-btn--primary">Record pending earning</button>
          </form>
          <h3>2. Fund · 3. Mark available · 4. Track payout</h3>
          <ul className="ch-payout-list ch-payout-list--manager">
            {rows.map((r) => (
              <li key={r.id}>
                <div>
                  <strong>
                    {r.description} · {money(r.amountMinor)}
                  </strong>
                  <p>{labels[r.state] ?? r.state}</p>
                  {r.fundingRequestedAt ? (
                    <p>
                      EMG funding:{' '}
                      {r.fundingStatus === 'funds_available'
                        ? 'Available in payout pool'
                        : (r.fundingStatus ?? 'Awaiting confirmation')}
                    </p>
                  ) : null}
                  {r.state === 'PENDING' ? (
                    <div className="ch-manager-payment-steps">
                      {!r.fundingRequestedAt && service.config.provider !== 'STRIPE' ? (
                        <form action={fundCreatorPayout}>
                          <input type="hidden" name="profileId" value={profileId} />
                          <input type="hidden" name="payoutId" value={r.id} />
                          <label className="ch-consent">
                            <input type="checkbox" name="confirm" value="yes" required />
                            Move {money(r.amountMinor)} from{' '}
                            {service.config.fundingAccountLabel ?? 'EMG’s registered business bank'}{' '}
                            into EMG’s payout pool. This is a real bank debit when live.
                          </label>
                          <button
                            className="loop-btn"
                            disabled={
                              service.config.recordingOnly ||
                              !service.config.fundingAccountId ||
                              !service.config.ledgerId
                            }
                          >
                            {service.config.environment === 'sandbox'
                              ? 'Simulate EMG funding'
                              : 'Move EMG funds'}
                          </button>
                        </form>
                      ) : null}
                      <form action={releaseCreatorPayout}>
                        <input type="hidden" name="profileId" value={profileId} />
                        <input type="hidden" name="payoutId" value={r.id} />
                        <label className="ch-consent">
                          <input type="checkbox" name="confirm" value="yes" required />
                          Release {money(r.amountMinor)} for this creator to request. The funded
                          pool must cover this and all other reserved earnings.
                        </label>
                        <button
                          className="loop-btn loop-btn--primary"
                          disabled={
                            !balance ||
                            (!!r.fundingRequestedAt && r.fundingStatus !== 'funds_available')
                          }
                        >
                          Mark available for withdrawal
                        </button>
                      </form>
                    </div>
                  ) : null}
                  <details>
                    <summary>Payment references</summary>
                    <p>Loop: {r.id}</p>
                    <p>Funding sweep: {r.fundingSweepId ?? 'None'}</p>
                    <p>Payout authorization: {r.authorizationId ?? 'Not created'}</p>
                    <p>Payout transfer: {r.transferId ?? 'Not confirmed'}</p>
                    <p>Provider payout status: {r.providerStatus ?? 'Not confirmed'}</p>
                  </details>
                  {['PENDING', 'AVAILABLE'].includes(r.state) ||
                  (r.state === 'REVIEW' &&
                    [
                      'failed',
                      'cancelled',
                      'authorization.declined',
                      'authorization.user_action_required',
                    ].includes(r.providerStatus ?? '')) ? (
                    <form action={cancelCreatorPayout}>
                      <input type="hidden" name="profileId" value={profileId} />
                      <input type="hidden" name="payoutId" value={r.id} />
                      <button className="loop-btn">Cancel unpaid earning</button>
                      <small>
                        Does not reverse a funding deposit already submitted to the payment
                        provider.
                      </small>
                    </form>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          <p className="loop-note">
            Latest 100 earning records. Funds are never withdrawn by entering a balance or by an AI
            recommendation.
          </p>
        </>
      )}
    </section>
  );
}
