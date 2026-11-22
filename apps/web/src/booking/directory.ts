import 'server-only';
import { prisma } from '@emgloop/database';

export const employees = ['Charlie Brugnolotti', 'Matt Dunn', 'Mike Dunn', 'Jonathan Gribble', 'Francesca Brugnolotti'];
export const organizerEmail = 'matt@elitemediagroup.io';
export const managerEmail = 'charlie@elitemediagroup.io';

// Approved public names from EMG's Talent Roster for CRM. Studio profiles also
// exist for staff and prospects, so profile creation must not publish a name.
const creators = [
  ['clarence-jones', 'Clarence Jones'],
  ['denise-schilling', 'Denise Schilling (Kona, Kai & Kaleo)'],
  ['dr-shan', 'Dr. Shan MD (Shannalee Stephens)'],
  ['eric-gibbons', 'Eric Gibbons (ArtEdGuru)'],
  ['hope-holcer', 'Hope Holcer'],
  ['katrina-gorham', 'Katrina Gorham (Mrs. G DIY Designs)'],
  ['koaty-and-sumner', 'Koaty & Sumner Blayne'],
  ['trevon-hill', 'Trevon Hill'],
].map(([id, displayName]) => ({ id, displayName }));

export async function bookingDirectory() {
  const anchor = await prisma.employeeBookingProfile.findFirst({
    where: { slug: 'matt', user: { email: { equals: organizerEmail, mode: 'insensitive' }, status: 'ACTIVE' } },
    select: { user: { select: { organizationId: true } } },
  });
  if (!anchor) return { profiles: [], creators: [] };
  const organizationId = anchor.user.organizationId;
  const profiles = await prisma.employeeBookingProfile.findMany({
      where: { isPublished: true, user: { organizationId, status: 'ACTIVE', name: { in: employees, mode: 'insensitive' } }, eventTypes: { some: { isPublished: true } } },
      select: { slug: true, user: { select: { name: true } } },
    });
  return { profiles, creators };
}
