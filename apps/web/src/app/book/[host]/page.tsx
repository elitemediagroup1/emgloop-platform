import { BookingFrame } from '../_components/BookingFrame';
import styles from '../_components/public-booking.module.css';
import { headers } from 'next/headers';
import { prisma } from '@emgloop/database';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { bookingDirectory } from '../../../booking/directory';

export const dynamic = 'force-dynamic';

export default async function HostBookingPage({ params, searchParams }: { params: { host: string }; searchParams: { creator?: string } }) {
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

  const creator = searchParams.creator && (await bookingDirectory()).creators.find(c => c.id === searchParams.creator);
  if (searchParams.creator && (!creator || params.host !== 'matt')) notFound();
  const query = creator ? '?creator=' + encodeURIComponent(creator.id) : '';
  const prefix = headers().get('host') === 'book.emgloop.com' ? '' : '/book';
  return (
    <BookingFrame><div className={styles.body}>
      <h1>{creator ? 'Meet with Matt and Charlie about ' + creator.displayName : 'Meet with ' + (profile.user.name ?? 'EMG')}</h1>
      <p>Google Meet</p>
      {profile.eventTypes.length ? (
        <ul className={styles.links}>{profile.eventTypes.map((event) => (
          <li key={event.id}>
            <Link href={`${prefix}/${params.host}/${event.slug}${query}`} prefetch={false}>{event.title}<small>{event.durationMinutes} minutes</small></Link>
            {event.description && <p>{event.description}</p>}
          </li>
        ))}</ul>
      ) : <p>No meetings are available to book.</p>}
    </div></BookingFrame>
  );
}
