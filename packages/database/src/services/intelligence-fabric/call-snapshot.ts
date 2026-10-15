import { createHash } from 'node:crypto';
import type { CallWindowAggregate } from '../../repositories/marketplace-call.repository';
import type { BriefingArtifact } from './briefing';

/** A projection snapshot, not a claim that CallGrid's source is completely reconciled. */
export function callQuestionArtifact(
  a: CallWindowAggregate,
  since: Date,
  until: Date,
): BriefingArtifact {
  const economic = (c: {
    calls: number;
    revenueCents: number;
    payoutCents: number;
    costCents: number;
    callsWithRevenue: number;
    callsWithPayout: number;
    callsWithCost: number;
  }) => ({
    calls: c.calls,
    reportedRevenue: c.callsWithRevenue > 0 ? (c.revenueCents / 100).toFixed(2) : null,
    reportedPayout: c.callsWithPayout > 0 ? (c.payoutCents / 100).toFixed(2) : null,
    reportedTelcoCost: c.callsWithCost > 0 ? (c.costCents / 100).toFixed(2) : null,
    netProfit:
      c.calls > 0 &&
      c.callsWithRevenue === c.calls &&
      c.callsWithPayout === c.calls &&
      c.callsWithCost === c.calls
        ? ((c.revenueCents - c.payoutCents - c.costCents) / 100).toFixed(2)
        : null,
    fieldsCovered: {
      revenue: c.callsWithRevenue,
      payout: c.callsWithPayout,
      telcoCost: c.callsWithCost,
    },
  });
  const campaigns = [...a.campaigns].sort((x, y) => y.calls - x.calls).slice(0, 20);
  return {
    ref: 'snapshot:callgrid',
    domain: 'CALLGRID',
    title: 'CallGrid stored-call snapshot',
    statement: JSON.stringify({
      windowStart: since.toISOString(),
      windowEndExclusive: until.toISOString(),
      currency: 'USD',
      ...economic(a),
      monetized: a.monetized,
      campaigns: campaigns.map((c) => ({
        record: `provider_member:callgrid:campaign:${c.key}`,
        name: c.label,
        ...economic(c),
        monetized: c.monetized,
      })),
    }),
    status: 'WATCH',
    signals: [],
    basis: createHash('sha256')
      .update(JSON.stringify([since.toISOString(), a]))
      .digest('hex'),
    coverage: 'CONNECTED_PARTIAL',
    limitations: [
      ...(a.calls === 0
        ? [
            'No stored calls in this period: historical business performance is unknown until source coverage is verified.',
          ]
        : []),
      'Stored calls only; source reconciliation is not established by this snapshot. Missing financial fields are unknown, not zero.',
      ...(campaigns.length < a.campaigns.length
        ? ['Campaign detail is limited to the largest campaigns by call volume.']
        : []),
    ],
  };
}
