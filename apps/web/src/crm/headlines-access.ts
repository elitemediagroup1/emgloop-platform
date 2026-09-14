import 'server-only';
import type { AuthSession } from '../auth/auth';
import { hasPermission } from '../auth/guard';
import { resolveWorkspaceRole } from '../workspaces/role-router';

// Who the CRM may show Commercial Intelligence's Headlines to: exactly the people
// the governed Headlines route admits. The page requires the ADMIN role authority
// and commercialIntelligence:view. Anyone else holding the read grant (EMPLOYEE,
// READ_ONLY) would be sent back to Loop Home, so they are shown nothing rather
// than a dead end. The LOOP_NAV "Headlines" item encodes the same two conditions
// as `workspace: 'ADMIN'` and `requires`.

export async function canOpenHeadlines(session: AuthSession): Promise<boolean> {
  if (resolveWorkspaceRole(session) !== 'ADMIN') return false;
  return hasPermission('commercialIntelligence', 'view');
}
