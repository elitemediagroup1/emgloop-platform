import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
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
  return <BookingFrame><div className={styles.body}>
    <h1>Book time with EMG</h1>
    <form className={styles.form}>
      <label>Who would you like to meet with?
        <select name="who" required defaultValue="">
          <option value="" disabled>Select a person</option>
          <optgroup label="EMG employees">{employees.map(name => {
            const p = profiles.find(row => row.user.name?.toLowerCase() === name.toLowerCase());
            return <option key={name} value={p?.slug ?? ''} disabled={!p}>{name}{p ? '' : ' · Booking unavailable'}</option>;
          })}</optgroup>
          <optgroup label="Creator management">{creators.map(c => <option key={c.id} value={'creator-' + c.id}>{c.displayName}</option>)}</optgroup>
        </select>
      </label>
      <p>For creator inquiries, meet with Matt Dunn and Charlie Brugnolotti.</p>
      <button className={styles.button}>Continue</button>
    </form>
  </div></BookingFrame>;
}
