// CallGrid Intelligence — Vendors. Same shared dimension page as Buyers, with
// supply-side data and share-of-call-volume. Reads the canonical call projection.

import { CallDimensionPage, type CallDimensionConfig } from '../call-dimension-page';
import { requireWorkspace } from '../../../../../workspaces/guard';

export const dynamic = 'force-dynamic';

const CONFIG: CallDimensionConfig = {
  dim: 'vendors',
  navKey: 'vendors',
  title: 'Vendors',
  subtitle: 'Supply-partner performance for the selected period.',
  entityLabel: 'Vendor',
  entityLabelLower: 'vendor',
  selectionParam: 'vendor',
  share: 'volume',
};

export default async function VendorsPage({ searchParams }: { searchParams?: Record<string, string | undefined> }) {
  await requireWorkspace('ADMIN');
  return CallDimensionPage({ config: CONFIG, searchParams });
}
