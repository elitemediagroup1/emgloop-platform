import { prisma } from '@emgloop/database';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function HostBookingPage({ params }: { params: { host: string } }) {
  if (!/^[a-z0-9-]{1,64}$/.test(params.host)) notFound();

  const profile = await prisma.employeeBookingProfile.findFirst({
    where: { slug: params.host, isPublished: true, user: { status: 'ACTIVE' } },
    select: {
      user: { select: { name: true } },
      eventTypes: {
        where: { isPublished: true },
        select: { id: true, slug: true, title: true, description: true, durationMinutes: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!profile) notFound();

  return (
    <main>
      <h1>Meet with {profile.user.name ?? 'EMG'}</h1>
      <p>Google Meet</p>
      {profile.eventTypes.length ? (
        <ul>{profile.eventTypes.map((event) => (
          <li key={event.id}>
            <h2><Link href={`/book/${params.host}/${event.slug}`}>{event.title}</Link></h2>
            <p>{event.durationMinutes} minutes</p>
            {event.description && <p>{event.description}</p>}
          </li>
        ))}</ul>
      ) : <p>No meetings are available to book.</p>}
    </main>
  );
}
