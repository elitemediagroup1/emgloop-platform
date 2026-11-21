'use client';

import Image from 'next/image';
import { useState } from 'react';
import { bookingSlots } from '../../../booking/slots';
import styles from './booking.module.css';

const calendarZone = 'America/New_York';
const timeZones = [calendarZone, 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'UTC'];
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const brands = [
  { file: 'elite-media-group-original.jpg', name: 'Elite Media Group', width: 1024, height: 576 },
  { file: 'emg-loop-original.png', name: 'EMG Loop', width: 1080, height: 207 },
  { file: 'emg-talent-original.png', name: 'EMG Talent Group', width: 494, height: 330 },
];
const demoHours = [{ startMinute: 540, endMinute: 780 }, { startMinute: 900, endMinute: 960 }];
const demoAvailability = {
  timeZone: calendarZone,
  weeklyHours: { 1: demoHours, 2: demoHours, 3: demoHours, 4: demoHours, 5: demoHours },
  dateOverrides: { '2027-01-18': [] },
  blockedTimes: [],
};

function previewTimes(date: Date) {
  return bookingSlots({
    availability: demoAvailability,
    hostDate: date.toISOString().slice(0, 10),
    now: Date.UTC(2027, 0, 1),
    durationMinutes: 30,
    incrementMinutes: 30,
    noticeMinutes: 0,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    calendarBusy: [],
  }).map((slot) => new Date(slot.start));
}

function dateLabel(date: Date, zone: string) {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone: zone }).format(date);
}

function timeLabel(date: Date, zone: string) {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone }).format(date);
}

export default function BookingPreview() {
  const [zone, setZone] = useState(calendarZone);
  const [month, setMonth] = useState(0);
  const [day, setDay] = useState<number | null>(null);
  const [hour, setHour] = useState<number | null>(null);
  const first = new Date(Date.UTC(2027, month, 1, 16));
  const daysInMonth = new Date(Date.UTC(2027, month + 1, 0)).getUTCDate();
  const date = day === null ? null : new Date(Date.UTC(2027, month, day, 16));
  const times = date ? previewTimes(date) : [];
  const changeMonth = (offset: number) => {
    setMonth(month + offset);
    setDay(null);
    setHour(null);
  };

  return (
    <main className={styles.shell}>
      <article className={styles.card}>
        <div className={styles.brands} aria-label="EMG brands">
          {brands.map(({ file, name, width, height }) => (
            <div key={file}><Image src={`/brand/${file}`} alt={name} width={width} height={height} /></div>
          ))}
        </div>
        <header className={styles.details}>
          <h1>30 Minute Call</h1>
          <dl>
            <dt>Host</dt><dd>Matt Dunn</dd>
            <dt>Duration</dt><dd>30 minutes</dd>
            <dt>Location</dt><dd>Google Meet</dd>
          </dl>

        </header>
        <section className={styles.schedule} aria-labelledby="availability">
          <h2 id="availability">Choose a date and time</h2>
          <p className={styles.note}>Preview with sample availability. Booking is disabled.</p>
          <label className={styles.zone}>Time zone
            <select value={zone} onChange={(event) => setZone(event.target.value)}>
              {timeZones.map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <div className={styles.monthNavigation}>
            <button type="button" aria-label="Previous month" disabled={month === 0} onClick={() => changeMonth(-1)}>‹</button>
            <h3 aria-live="polite">{new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first)}</h3>
            <button type="button" aria-label="Next month" disabled={month === 11} onClick={() => changeMonth(1)}>›</button>
          </div>
          <div className={styles.days} role="group" aria-label="Available dates">
            {weekdays.map((weekday) => <span key={weekday} className={styles.weekday}>{weekday}</span>)}
            {Array.from({ length: first.getUTCDay() }, (_, index) => <span key={`empty-${index}`} aria-hidden="true" />)}
            {Array.from({ length: daysInMonth }, (_, index) => {
              const value = new Date(Date.UTC(2027, month, index + 1, 16));
              const available = previewTimes(value).length > 0;
              return (
                <button key={index} type="button" disabled={!available} aria-pressed={index + 1 === day}
                  aria-label={dateLabel(value, zone)} onClick={() => { setDay(index + 1); setHour(null); }}>
                  {index + 1}
                </button>
              );
            })}
          </div>
          {date && <h3>{dateLabel(date, zone)}</h3>}
          <div className={styles.times} role="group" aria-label="Available times">
            {times.map((value, index) => (
              <button key={value.toISOString()} type="button" aria-pressed={hour === index} onClick={() => setHour(index)}>
                {timeLabel(value, zone)}
              </button>
            ))}
          </div>
          <p className={styles.note} role="status">
            {hour !== null && `Selected ${timeLabel(times[hour]!, zone)} · ${zone}`}
          </p>
        </section>
      </article>
    </main>
  );
}
