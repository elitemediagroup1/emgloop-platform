import 'server-only';
import { prisma } from '@emgloop/database';

export function bookingSlug(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '');
}

const employeeRoles = new Set(['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE']);
const reservedSlugs = new Set(['admin', 'api', 'preview', 'calendar']);

export async function provisionEmployeeBookingProfile(principal: {
  organizationId: string;
  userId: string;
  systemRole: string;
  name: string;
}) {
  if (!employeeRoles.has(principal.systemRole)) return;
  const active = await prisma.user.findFirst({
    where: { id: principal.userId, organizationId: principal.organizationId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!active) return;

  const first = bookingSlug(principal.name.trim().split(/\s+/)[0] ?? '') || 'host';
  const alternatives = new Set([
    first,
    bookingSlug(principal.name),
    `${first.slice(0, 32)}-${active.id.slice(-12)}`,
    `host-${active.id}`,
  ]);
  for (const slug of alternatives) {
    if (!slug || reservedSlugs.has(slug)) continue;
    await prisma.employeeBookingProfile.createMany({
      data: [{ userId: active.id, slug, timeZone: 'America/New_York' }],
      skipDuplicates: true,
    });
    if (await prisma.employeeBookingProfile.findUnique({ where: { userId: active.id }, select: { slug: true } })) return;
  }
  throw new Error('Could not reserve a booking link.');
}
