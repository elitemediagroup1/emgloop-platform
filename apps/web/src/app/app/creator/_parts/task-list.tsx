// The creator's task rows (Creator Hub), shared by Tasks and Home. PURE.
//
// A row renders a CreatorTask exactly as the read model derived it: its title, its detail, its
// kind, its bucket and the record it points at. Nothing here decides that something is a task.

import Link from 'next/link';
import type { CreatorTask } from '@emgloop/database';
import type { TimeView } from '@emgloop/shared';
import { Pill } from './vocabulary';

const KIND_LABEL: Record<CreatorTask['kind'], string> = { REVIEW: 'Review', DELIVERABLE: 'Deliverable', UPLOAD: 'Upload', SETUP: 'Set up' };

export function TaskList({ tasks, time }: { tasks: readonly CreatorTask[]; time: TimeView }) {
  return (
    <ul className="ch-list" aria-label="Tasks">
      {tasks.map((t) => (
        <li key={t.key}>
          <Link className="ch-row" href={t.href} data-task-kind={t.kind}>
            <span className="ch-row__main">
              <span className="ch-row__title">{t.title}</span>
              {t.detail ? <span className="ch-row__meta">{t.detail}</span> : null}
            </span>
            <span className="ch-row__side">
              <Pill tone={t.bucket === 'NEEDS_ATTENTION' ? 'attention' : 'neutral'} small>
                {KIND_LABEL[t.kind]}
              </Pill>
              {t.dueAt ? <span className="ch-row__meta">due {time.date(t.dueAt)}</span> : null}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
