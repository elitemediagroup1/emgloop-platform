import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { BookingDirectoryForm } from './_components/BookingDirectoryForm';
import { BookingFrame } from './_components/BookingFrame';
import styles from './_components/public-booking.module.css';
import { bookingDirectory, employees } from '../../booking/directory';

export const metadata = { title: 'Book a meeting with EMG' };
export const dynamic = 'force-dynamic';

export default async function BookingHome({ searchParams }: { searchParams: { host?: string; who?: string } }) {
  const { profiles, creators } = await bookingDirectory();
  const prefix = headers().get('host') === 'book.emgloop.com' ? '' : '/book';
  const chosen = searchParams.who ?? searchParams.host;
  if (profiles.some(p => p.slug === chosen)) redirect(`${prefix}/${chosen}`);
  const creator = creators.find(c => 'creator-' + c.id === chosen);
  if (creator) redirect(`${prefix}/matt?creator=${encodeURIComponent(creator.id)}`);
  const employeeOptions = employees.map(name => {
    const profile = profiles.find(row => row.user.name?.toLowerCase() === name.toLowerCase());
    return {
      id: profile?.slug ?? name,
      label: profile ? name : name + ' · Booking unavailable',
      href: profile ? `${prefix}/${profile.slug}` : null,
    };
  });
  const creatorOptions = creators.map(creator => ({
    id: 'creator-' + creator.id,
    label: creator.displayName,
    href: `${prefix}/matt?creator=${encodeURIComponent(creator.id)}`,
  }));

  return <BookingFrame><div className={styles.body}>
    <h1>Book time with EMG</h1>
    <BookingDirectoryForm employees={employeeOptions} creators={creatorOptions} />
  </div></BookingFrame>;
}
