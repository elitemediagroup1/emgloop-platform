import Link from 'next/link';
import { CREATOR_HREFS } from './creator-runtime';

/** Presentation only. Unknown task counts never become zero. */
export function CreatorStudioWelcome({ displayName, greeting, date, taskCount }: { displayName: string; greeting: string; date: string; taskCount: number | null }) {
  return (
      <section className="ch-studio-welcome" aria-label="Your creator workspace">
        <div className="ch-studio-welcome__meta"><span>EMG Talent Group / Creator Hub</span><span>{date}</span></div>
        <div className="ch-studio-welcome__layout">
          <div className="ch-studio-welcome__copy">
            <p className="ch-studio-eyebrow">{greeting}, {displayName}</p>
            <h1>Your talent.<br /><span>Your next chapter.</span></h1>
            <p className="ch-studio-welcome__intro">Your team behind the scenes. Your partnerships, content and next moves, all here.</p>
            <Link className="loop-btn ch-studio-cta" href={CREATOR_HREFS.content}>Enter your content studio <span aria-hidden="true">↗</span></Link>
          </div>
          <Link className="ch-studio-focus" href={CREATOR_HREFS.tasks}>
            <span className="ch-studio-focus__label">Your next move <span aria-hidden="true">↗</span></span>
            <strong>{taskCount === null ? 'Check your tasks' : taskCount ? `${taskCount} ${taskCount === 1 ? 'thing needs' : 'things need'} you` : 'You’re all caught up.'}</strong>
            <span>{taskCount === null ? 'Your tasks could not be loaded here.' : taskCount ? 'Review your outstanding tasks and keep things moving.' : 'When your team needs a review or a decision, you’ll find it here.'}</span>
            <span className="ch-studio-focus__footer">Open your tasks <span aria-hidden="true">→</span></span>
          </Link>
        </div>
      </section>
  );
}
