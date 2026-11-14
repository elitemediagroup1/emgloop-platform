// Recorded compensation only. There is no production money-movement rail.
import type { EarningsView } from '@emgloop/database';
import type { CompensationState, TimeView } from '@emgloop/shared';
import {
  COMPENSATION_STATE_LABELS,
  EVIDENCE_SOURCE_LABELS,
  PAYABLE_COMPENSATION_STATE,
} from '@emgloop/shared';
import { ActionButton, Panel, StateBlock, SummaryStrip } from '../../_loop-os/record';
import { COMPENSATION_TONES, moneyMinor, Pill } from './vocabulary';

const TOTAL_ORDER: readonly CompensationState[] = [
  'EXPECTED',
  'PENDING',
  'RECEIVED_BY_EMG',
  'AVAILABLE',
  'TRANSFER_PENDING',
  'PAID',
];

export function transferReason(payoutState: string): string {
  return payoutState === 'NOT_SET_UP'
    ? 'Payouts are not set up'
    : 'Transfers are not available in Loop yet';
}

export function EarningsBody({ earnings, time }: { earnings: EarningsView; time: TimeView }) {
  const available = earnings.totals[PAYABLE_COMPENSATION_STATE];
  return (
    <>
      <div className="ch-payment-overview">
        <section className="ch-payment-cards" aria-label="Earnings overview">
          <Panel title="Approved earnings">
            <p className="ch-balance" data-available-minor={available}>
              {moneyMinor(available, earnings.currency)}
            </p>
            <p className="loop-note">
              Marked available by EMG. Bank withdrawals require an approved payout service and
              available funding.
            </p>
            {available > 0 ? (
              <div className="loop-btnrow" style={{ marginTop: 12 }} data-transfer-control>
                <ActionButton
                  action={{
                    label: 'Transfer funds',
                    href: null,
                    reason: transferReason(earnings.payoutState),
                  }}
                />
              </div>
            ) : null}
            {earnings.seeded ? (
              <p className="ch-seeded" data-seeded>
                Some of these amounts are seeded demo data, not payments.
              </p>
            ) : null}
          </Panel>

          <Panel title="Awaiting EMG approval">
            <p className="ch-balance">
              {moneyMinor(
                earnings.totals.EXPECTED +
                  earnings.totals.PENDING +
                  earnings.totals.RECEIVED_BY_EMG,
                earnings.currency,
              )}
            </p>
            <p className="loop-note">Expected or received, awaiting availability.</p>
          </Panel>
          <Panel title="Transfer in progress">
            <p className="ch-balance">
              {moneyMinor(earnings.totals.TRANSFER_PENDING, earnings.currency)}
            </p>
            <p className="loop-note">Recorded transfers awaiting completion.</p>
          </Panel>
        </section>
        <aside className="ch-payment-setup">
          <span className="ch-eyebrow">Your payout method</span>
          <h2>Bank payments, built around you.</h2>
          <p>
            Bank linking and withdrawals are not enabled yet. Your manager can record and approve
            earnings; this page does not move money.
          </p>
          <p className="loop-note">No bank details have been collected through this page.</p>
        </aside>
      </div>

      <details className="ch-payment-state-details">
        <summary>All recorded payment states</summary>
        <SummaryStrip
          label="Totals by state"
          items={TOTAL_ORDER.map((state) => ({
            label: COMPENSATION_STATE_LABELS[state],
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
                        {e.stateLabel}
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
        <aside className="ch-payment-confirmation">
          <h2>Withdrawal details</h2>
          <p>Bank withdrawals are not available yet.</p>
          <dl>
            <div>
              <dt>Approved balance</dt>
              <dd>{moneyMinor(available, earnings.currency)}</dd>
            </div>
            <div>
              <dt>Destination</dt>
              <dd>Not connected</dd>
            </div>
            <div>
              <dt>Fees</dt>
              <dd>Not available</dd>
            </div>
            <div>
              <dt>Estimated arrival</dt>
              <dd>Not available</dd>
            </div>
          </dl>
          <p className="loop-note">
            Your approved earnings remain recorded here while payment setup is completed.
          </p>
        </aside>
      </div>
    </>
  );
}
