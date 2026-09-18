// Small, pure selections the Overview makes over the engine's output. No threshold
// and no ranking of its own: "notable" means a CHANGE or DRIVER finding the engine
// already produced (it cleared the significance registry), in the engine's order.

import type { CallGridFinding, CallGridIntelligence } from '@emgloop/shared';

export function findingsByRank(intel: Pick<CallGridIntelligence, 'ranked'>): CallGridFinding[] {
  return intel.ranked
    .map((r) => r.finding)
    .filter((f) => f.findingType === 'CHANGE' || f.findingType === 'DRIVER')
    .filter((f) => f.currentValue !== null || f.absoluteChange !== null);
}
