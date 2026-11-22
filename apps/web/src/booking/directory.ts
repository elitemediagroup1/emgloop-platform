import 'server-only';
import { prisma } from '@emgloop/database';

export const employees = ['Charlie Brugnolotti', 'Matt Dunn', 'Mike Dunn', 'Jonathan Gribble', 'Francesca Brugnolotti'];
export const organizerEmail = 'matt@elitemediagroup.io';
export const managerEmail = 'charlie@elitemediagroup.io';

export async function bookingDirectory() {
  const anchor = await prisma.employeeBookingProfile.findFirst({
    where: { slug: 'matt', user: { email: { equals: organizerEmail, mode: 'insensitive' }, status: 'ACTIVE' } },
    select: { user: { select: { organizationId: true } } },
  });
  if (!anchor) return { profiles: [], creators: [] };
  const organizationId = anchor.user.organizationId;
  const [profiles, roster] = await Promise.all([
    prisma.employeeBookingProfile.findMany({
      where: { isPublished: true, user: { organizationId, status: 'ACTIVE', name: { in: employees, mode: 'insensitive' } }, eventTypes: { some: { isPublished: true } } },
      select: { slug: true, user: { select: { name: true } } },
    }),
    prisma.creatorProfile.findMany({ where: { organizationId }, select: { id: true, displayName: true, handle: true }, orderBy: { displayName: 'asc' } }),
  ]);
  const creators = roster.filter(row => !/ella\s*isaacson|courtney\s*ni[ei][ls]sen|\b(?:ella|courtney)\b/i.test(row.displayName + ' ' + (row.handle ?? '')) && !/courtneynielson/i.test(row.handle ?? ''));
  return { profiles, creators };
}
