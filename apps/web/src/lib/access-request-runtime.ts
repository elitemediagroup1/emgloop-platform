import 'server-only';
import { AccessRequestRepository, prisma } from '@emgloop/database';

/** Trusted deployment routing, never a company name, address domain or public form field. */
export function accessRequestOrganizationId(): string | null {
  return process.env.LOOP_ACCESS_REQUEST_ORGANIZATION_ID?.trim() || null;
}
export function accessRequests() { return new AccessRequestRepository(prisma); }
