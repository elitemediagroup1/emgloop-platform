// CallGrid Intelligence — one source (Level 3). The page is the shared entity detail,
// configured for this dimension; the key selects within the session organization's
// own calls, so another tenant's key renders as no activity.

import { EntityDetailPage } from '../../entity-detail';
import { requireWorkspacePermission } from '../../../../../../workspaces/guard';
import type { SearchParams } from '../../command-data';

export const dynamic = 'force-dynamic';

function decoded(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default async function Page({ params, searchParams }: { params: { key: string }; searchParams?: SearchParams }) {
  const session = await requireWorkspacePermission('ADMIN', 'intelligence', 'view');
  return EntityDetailPage({ dim: 'sources', entityKey: decoded(params.key), session, searchParams });
}
