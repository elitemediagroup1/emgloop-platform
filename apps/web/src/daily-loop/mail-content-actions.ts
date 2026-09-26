'use server';

// Mail content -- the person's OWN consent (Loop Intelligence Phase D). Turning it on asks the repository,
// which refuses unless the deployment names the recorded counterparty-consent decision
// (LOOP_MAIL_CONTENT_GOVERNANCE_DECISION -- UNRESOLVED, so today it always refuses) and the person's Google
// connection can read mail. Turning it off is always possible: it stops Mail content intelligence and
// deletes the person's MAIL digests in the same transaction.

import { revalidatePath } from 'next/cache';
import { SourceContentAuthorizationRepository, prisma } from '@emgloop/database';
import { MAIL_CONTENT_GOVERNANCE_ENV } from '@emgloop/shared';

import { requirePermission } from '../auth/guard';

const MAIL_PATH = '/app/mail';

export async function authorizeMailContentAction(): Promise<void> {
  const session = await requirePermission('employeeIntelligence', 'update');
  await new SourceContentAuthorizationRepository(prisma).authorizeMailContent(session.organizationId, session.userId, {
    now: new Date(),
    actor: { userId: session.userId, name: session.name ?? null },
    governanceDecision: process.env[MAIL_CONTENT_GOVERNANCE_ENV] ?? null,
  });
  revalidatePath(MAIL_PATH);
}

export async function revokeMailContentAction(): Promise<void> {
  const session = await requirePermission('employeeIntelligence', 'update');
  await new SourceContentAuthorizationRepository(prisma).revokeMailContent(session.organizationId, session.userId, {
    now: new Date(),
    actor: { userId: session.userId, name: session.name ?? null },
  });
  revalidatePath(MAIL_PATH);
}
