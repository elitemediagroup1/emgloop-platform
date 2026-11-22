'use client';

import { useState, type FormEvent } from 'react';
import styles from './public-booking.module.css';

interface DirectoryOption {
  id: string;
  label: string;
  href: string | null;
}

export function BookingDirectoryForm({
  employees, creators,
}: {
  employees: DirectoryOption[];
  creators: DirectoryOption[];
}) {
  const [chosen, setChosen] = useState('');
  const creator = creators.find(option => option.id === chosen);

  function continueToBooking(event: FormEvent<HTMLFormElement>) {
    const option = creator ?? employees.find(employee => employee.id === chosen);
    if (!option?.href) return;
    event.preventDefault();
    window.location.assign(option.href);
  }

  return (
    <form className={styles.form} method="get" onSubmit={continueToBooking}>
      <label>Who would you like to meet with?
        <select name="who" required value={chosen} onChange={event => setChosen(event.target.value)}>
          <option value="" disabled>Select a person</option>
          <optgroup label="EMG employees">
            {employees.map(option => (
              <option key={option.label} value={option.id} disabled={!option.href}>{option.label}</option>
            ))}
          </optgroup>
          <optgroup label="Creator management">
            {creators.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </optgroup>
        </select>
      </label>
      {creator && <p>Meet with Matt Dunn and Charlie Brugnolotti about {creator.label}.</p>}
      <button className={styles.button} type="submit">Continue</button>
    </form>
  );
}
