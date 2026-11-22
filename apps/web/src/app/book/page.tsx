import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { BookingFrame } from './_components/BookingFrame';
import styles from './_components/public-booking.module.css';

export const metadata = { title: 'Book a meeting with EMG' };

export default function BookingHome({ searchParams }: { searchParams: { host?: string } }) {
  const host = typeof searchParams.host === 'string' ? searchParams.host.toLowerCase().trim() : '';
  if (/^[a-z0-9-]{1,64}$/.test(host) && !['book', 'preview'].includes(host)) {
    const prefix = headers().get('host') === 'book.emgloop.com' ? '' : '/book';
    redirect(`${prefix}/${host}`);
  }
  return (
    <BookingFrame>
      <div className={styles.body}>
        <h1>Book time with EMG</h1>
        <p>Visit your host’s booking page to see their meeting types and available times.</p>
        <form className={styles.form}>
          <label>Host’s booking name
            <input name="host" placeholder="e.g. matt" required maxLength={64} autoCapitalize="none" />
          </label>
          {host && <span role="alert">Enter the name at the end of your host’s booking link.</span>}
          <button className={styles.button} type="submit">Find booking page</button>
        </form>
      </div>
    </BookingFrame>
  );
}
