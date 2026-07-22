// CallGrid Intelligence — Campaigns. Same shared dimension page as Buyers, with
// campaign data. Campaign-level Profit is not reliably attributable at the
// dimension grain without per-row revenue coverage, so — per the spec's sanctioned
// fallback — the summary uses Avg Revenue / Billable Call instead of a Profit tile.

import { CallDimensionPage, type CallDimensionConfig } from '../call-dimension-page';

export const dynamic = 'force-dynamic';

const CONFIG: CallDimensionConfig = {
  dim: 'campaigns',
  navKey: 'campaigns',
  title: 'Campaigns',
  subtitle: 'Campaign performance for the selected period.',
  entityLabel: 'Campaign',
  entityLabelLower: 'campaign',
  selectionParam: 'campaign',
  share: 'none',
};

export default async function CampaignsPage({ searchParams }: { searchParams?: Record<string, string | undefined> }) {
  return CallDimensionPage({ config: CONFIG, searchParams });
}
