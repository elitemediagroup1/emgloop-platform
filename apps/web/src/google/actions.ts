'use server';

// Server actions for a person's OWN Google Workspace connection.
//
// The organization and person always come from the signed session; the form names only
// the capability and the page to return to. Authorization (`googleWorkspace:update`) is
// decided by the service before anything is written.
//
//   disconnectGoogleAction        delete Loop's credential, then ask Google to revoke it.
//   removeGoogleCapabilityAction  Google cannot revoke one scope of a grant, so the whole
//                                 grant is revoked; the page then offers to approve the
//                                 capabilities the person keeps, as a fresh consent.

import { redirect } from 'next/navigation';
import { isGoogleConnectReturnTarget, type GoogleConnectReturnTarget } from '@emgloop/shared';

import { requireSession } from '../auth/guard';
import { googleReturnPath, googleWorkspace } from './google-runtime';

function returnTarget(formData: FormData): GoogleConnectReturnTarget {
  const value = formData.get('return');
  return isGoogleConnectReturnTarget(value) ? value : 'CONNECTIONS';
}

export async function disconnectGoogleAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const outcome = await googleWorkspace().disconnect({
    organizationId: session.organizationId,
    userId: session.userId,
    name: session.name,
  });
  redirect(googleReturnPath(returnTarget(formData), outcome));
}

export async function removeGoogleCapabilityAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const { outcome, reconnect } = await googleWorkspace().removeCapability(
    { organizationId: session.organizationId, userId: session.userId, name: session.name },
    formData.get('capability'),
  );
  redirect(googleReturnPath(returnTarget(formData), outcome, reconnect.length > 0 ? { reconnect: reconnect.join(',') } : undefined));
}
