// Is this person's content authorization for a provider in force, right now, inside a
// transaction? ONE read, scoped by organization + user + provider and nothing else; consent is
// derived (authorizedAt set, revokedAt null), never a state column -- see
// source-content-authorization.repository.ts. It lives in its own module because the work-item
// repository asks it at every derived write (THE WRITE RE-CHECKS CONSENT) and the authorization
// repository, which owns the revoke, imports the withdrawal repository, which imports the work-item
// repository: the read has to sit outside that ring or the ring closes on itself.

import type { Prisma } from '@prisma/client';

export async function contentAuthorizedInTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  userId: string,
  provider: string,
): Promise<boolean> {
  if (!organizationId || !userId || !provider) return false;
  const live = await tx.sourceContentAuthorization.findFirst({
    where: { organizationId, userId, provider, revokedAt: null },
    select: { id: true },
  });
  return live !== null;
}
