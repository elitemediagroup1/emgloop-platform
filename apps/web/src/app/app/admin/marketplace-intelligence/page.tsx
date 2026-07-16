import { redirect } from 'next/navigation';
import { requireWorkspacePermission } from '../../../../workspaces/guard';

// Sprint 27 — Owner Shell Cleanup and Truthfulness.
//
// The Owner sidebar's "Marketplace" now points at the REAL Marketplace
// command center (/app/admin/marketplace). This former placeholder route is
// kept only so any existing bookmark or deep link still resolves: it enforces
// the same IAM gate and then redirects to the real page. No placeholder /
// "Nothing here yet" shell is rendered anymore, and there is no duplicate
// Marketplace implementation.

export const dynamic = 'force-dynamic';

export default async function MarketplaceIntelligenceRedirect() {
  // Preserve the original authorization semantics before forwarding.
  await requireWorkspacePermission('ADMIN', 'intelligence', 'view');
  redirect('/app/admin/marketplace');
}
