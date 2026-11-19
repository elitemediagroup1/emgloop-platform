// Compensation read model. Bank linking and approved requests live in the payout panel.
import type { ReactNode } from 'react';
import type { EarningsView } from '@emgloop/database';
import type { CompensationState, TimeView } from '@emgloop/shared';
import { EVIDENCE_SOURCE_LABELS, PAYABLE_COMPENSATION_STATE } from '@emgloop/shared';
import { Panel, StateBlock, SummaryStrip } from '../../_loop-os/record';
import { COMPENSATION_TONES, moneyMinor, Pill } from './vocabulary';

const TOTAL_ORDER: readonly CompensationState[] = [
  'EXPECTED',
  'PENDING',
  'RECEIVED_BY_EMG',
  'AVAILABLE',
  'TRANSFER_PENDING',
  'PAID',
];

export const CREATOR_PAYMENT_LABELS: Record<CompensationState, string> = {
  EXPECTED: 'Expected',
  PENDING: 'Pending confirmation',
  RECEIVED_BY_EMG: 'Received by EMG',
  AVAILABLE: 'Available to request',
  TRANSFER_PENDING: 'Transfer in progress',
  PAID: 'Sent to your bank',
};

export function EarningsBody({
  earnings,
  time,
  payoutSetup,
}: {
  earnings: EarningsView;
  time: TimeView;
  payoutSetup?: ReactNode;
}) {
  const available = earnings.totals[PAYABLE_COMPENSATION_STATE];
  return (
    <>
      <div className="ch-payment-overview">
        <section className="ch-payment-cards" aria-label="Earnings overview">
          <Panel title="Available to request">
            <p className="ch-balance" data-available-minor={available}>
              {moneyMinor(available, earnings.currency)}
            </p>
            <p className="loop-note">Released by EMG. Request a payout below.</p>
            {earnings.seeded ? (
              <p className="ch-seeded" data-seeded>
                Some of these amounts are seeded demo data, not payments.
              </p>
            ) : null}
          </Panel>

          <Panel title="Not yet available">
            <p className="ch-balance">
              {moneyMinor(
                earnings.totals.EXPECTED +
                  earnings.totals.PENDING +
                  earnings.totals.RECEIVED_BY_EMG,
                earnings.currency,
              )}
            </p>
            <p className="loop-note">Expected, pending, or received by EMG; not yet released.</p>
          </Panel>
          <Panel title="Transfer in progress">
            <p className="ch-balance">
              {moneyMinor(earnings.totals.TRANSFER_PENDING, earnings.currency)}
            </p>
            <p className="loop-note">Requested or processing; bank receipt is not yet confirmed.</p>
          </Panel>
        </section>
        <aside className="ch-payment-setup">
          {payoutSetup ?? (
            <>
              <span className="ch-eyebrow">Your payout method</span>
              <h2>Your payment setup</h2>
              <p>Manage your bank account and request manager-approved payouts below.</p>
              <p className="loop-note">
                Questions about a payment? Contact your EMG team from Tasks.
              </p>
            </>
          )}
        </aside>
      </div>

      <section className="ch-payment-journey" aria-label="How payments move">
        <strong>Your payment journey</strong>
        <p>
          Expected → Pending confirmation → Received by EMG → Available to request → Transfer in
          progress → Sent to your bank
        </p>
        <p className="loop-note">
          Only released amounts can be requested. A transfer marked sent can still take time to
          arrive at your bank. Amounts and terms are shown only when recorded by EMG.
        </p>
      </section>
      <details className="ch-payment-state-details">
        <summary>All recorded payment states</summary>
        <SummaryStrip
          label="Totals by state"
          items={TOTAL_ORDER.map((state) => ({
            label: CREATOR_PAYMENT_LABELS[state],
            value: moneyMinor(earnings.totals[state], earnings.currency),
          }))}
        />
      </details>

      <div className="ch-payment-activity-layout">
        <Panel title="Transactions">
          {earnings.entries.length === 0 ? (
            <StateBlock
              kind="empty"
              compact
              title="No earnings recorded yet."
              body="Entries appear here as EMG records compensation for your campaigns."
            />
          ) : (
            <table className="loop-table">
              <thead>
                <tr>
                  <th>What</th>
                  <th>Campaign</th>
                  <th>State</th>
                  <th>When</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {earnings.entries.map((e) => (
                  <tr key={e.id} data-entry-source={e.source}>
                    <td data-label="What">
                      <span className="loop-table__strong">{e.description}</span>
                      {e.deliverableTitle ? (
                        <span className="loop-note" style={{ display: 'block' }}>
                          {e.deliverableTitle}
                        </span>
                      ) : null}
                      {e.source === 'SEEDED_DEMO' ? (
                        <span className="ch-chip ch-chip--seeded" data-seeded-row>
                          {EVIDENCE_SOURCE_LABELS.SEEDED_DEMO}
                        </span>
                      ) : null}
                    </td>
                    <td data-label="Campaign">
                      {e.campaignName ?? (
                        <span className="loop-table__muted">Not part of a campaign</span>
                      )}
                    </td>
                    <td data-label="State">
                      <Pill tone={COMPENSATION_TONES[e.state] ?? 'neutral'} small>
                        {CREATOR_PAYMENT_LABELS[e.state] ?? e.stateLabel}
                      </Pill>
                    </td>
                    <td data-label="When">{time.date(e.occurredAt)}</td>
                    <td data-label="Amount" className="loop-table__strong">
                      {moneyMinor(e.amountMinor, e.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}
