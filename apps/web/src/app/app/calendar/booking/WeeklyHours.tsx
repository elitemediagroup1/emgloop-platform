'use client';

import { useState } from 'react';
import styles from './settings.module.css';

export function WeeklyHours({ days }: { days: { name: string; hours: string }[] }) {
  const [schedule, setSchedule] = useState(() => days.map(({ hours }) =>
    hours ? hours.split(', ').map((range) => {
      const [start, end] = range.split('-');
      return { start: start ?? '', end: end === '24:00' ? '00:00' : end ?? '' };
    }) : [],
  ));
  const update = (day: number, ranges: typeof schedule[number]) => {
    setSchedule((current) => current.map((value, index) => index === day ? ranges : value));
  };
  return (
    <div className={styles.week}>
      {days.map(({ name }, day) => {
        const ranges = schedule[day] ?? [];
        return (
          <fieldset key={name} className={styles.day}>
            <legend>{name}</legend>
            <input type="hidden" name={`day-${day}`} value={ranges.map(({ start, end }) =>
              `${start}-${end === '00:00' ? '24:00' : end}`,
            ).join(', ')} />
            <div className={styles.ranges}>
              {!ranges.length && <span className={styles.muted}>Unavailable</span>}
              {ranges.map(({ start, end }, index) => (
                <div className={styles.interval} key={index}>
                  <input aria-label={`${name} start time ${index + 1}`} type="time" value={start} required
                    onChange={(event) => update(day, ranges.map((range, i) => i === index ? { ...range, start: event.target.value } : range))} />
                  <span aria-hidden="true">–</span>
                  <input aria-label={`${name} end time ${index + 1}`} type="time" value={end} required
                    onChange={(event) => update(day, ranges.map((range, i) => i === index ? { ...range, end: event.target.value } : range))} />
                  <button type="button" className={styles.secondary} aria-label={`Remove ${name} interval ${index + 1}`}
                    onClick={() => update(day, ranges.filter((_, i) => i !== index))}>Remove</button>
                </div>
              ))}
              <button type="button" className={styles.secondary} aria-label={`Add hours for ${name}`}
                onClick={() => update(day, [...ranges, { start: ranges.length ? '15:00' : '09:00', end: ranges.length ? '16:00' : '13:00' }])}>
                Add hours
              </button>
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
