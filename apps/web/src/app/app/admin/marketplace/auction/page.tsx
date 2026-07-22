// The canonical Bids route is /app/admin/marketplace/bids. This old /auction path
// remains only as a permanent redirect to it (query preserved), so existing links
// keep working. Do not add content here.

import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function AuctionRedirect({ searchParams }: { searchParams?: Record<string, string | undefined> }) {
  const qs = new URLSearchParams(
    Object.entries(searchParams ?? {}).filter(([, v]) => typeof v === 'string') as [string, string][],
  ).toString();
  redirect('/app/admin/marketplace/bids' + (qs ? `?${qs}` : ''));
}
