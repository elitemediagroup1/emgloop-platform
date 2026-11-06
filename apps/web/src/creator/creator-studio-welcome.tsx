import Link from 'next/link';
import { CREATOR_HREFS } from './creator-runtime';

/** Presentation only. Unknown task counts never become zero. */
export function CreatorStudioWelcome({ displayName, greeting, date, taskCount }: { displayName: string; greeting: string; date: string; taskCount: number | null }) {
  return <header className="ch-studio-welcome" aria-label="Your creator workspace">
    <div className="ch-studio-welcome__identity">
      <span className="ch-studio-monogram" aria-hidden="true">{displayName.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('')}</span>
      <div><p className="ch-studio-eyebrow">Creator workspace <span aria-hidden="true">/</span> {date}</p><h1>{displayName}</h1><p className="ch-studio-welcome__intro">{greeting}. Here’s where things stand.</p></div>
    </div>
    <div className="ch-studio-welcome__actions">
      <Link className="ch-studio-task-link" href={CREATOR_HREFS.tasks}>{taskCount === null ? 'Check your tasks' : taskCount ? `${taskCount} ${taskCount === 1 ? 'thing needs' : 'things need'} you` : 'You’re all caught up.'} <span aria-hidden="true">↗</span></Link>
      <Link className="loop-btn ch-studio-cta" href={CREATOR_HREFS.content}>Content studio <span aria-hidden="true">↗</span></Link>
    </div>
  </header>;
}
