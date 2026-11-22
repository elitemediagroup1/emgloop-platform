import Image from 'next/image';
import type { ReactNode } from 'react';
import styles from './public-booking.module.css';

export function BookingFrame({ children }: { children: ReactNode }) {
  return (
    <main className={styles.shell}>
      <article className={styles.card}>
        <header className={styles.brand}>
          <Image src="/brand/elite-media-group-original.jpg" alt="Elite Media Group" width={144} height={81} priority />
          <Image src="/brand/emg-loop-original.png" alt="EMG Loop" width={144} height={28} priority />
          <Image src="/brand/emg-talent-original.png" alt="EMG Talent Group" width={144} height={96} priority />
        </header>
        {children}
      </article>
    </main>
  );
}
