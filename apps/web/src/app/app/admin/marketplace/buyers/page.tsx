// CallGrid Intelligence — Buyers (the shared dimension-page reference).
//
// Reads the canonical call projection via loadCallGridReport (the SAME source as
// the Overview Top Buyer), so the two never disagree. All chrome, metrics, table,
// detail and activity come from the shared dimension components — Buyers, Vendors
// and Campaigns are one product with different data.

import { CallDimensionPage, type CallDimensionConfig } from '../call-dimension-page';

export const dynamic = 'force-dynamic';

const CONFIG: CallDimensionConfig = {
  dim: 'buyers',
  navKey: 'buyers',
  title: 'Buyers',
  subtitle: 'Demand-side performance for the selected period.',
  entityLabel: 'Buyer',
  entityLabelLower: 'buyer',
  selectionParam: 'buyer',
  share: 'revenue',
};

export default async function BuyersPage({ searchParams }: { searchParams?: Record<string, string | undefined> }) {
  return CallDimensionPage({ config: CONFIG, searchParams });
}
