import Link from 'next/link';
import { CREATOR_HREFS } from './creator-runtime';
import type { CreatorPublicMedia } from './creator-public-media';

export function CreatorStudioWelcome({ displayName, greeting, date, taskCount, media }: { displayName: string; greeting: string; date: string; taskCount: number | null; media?: CreatorPublicMedia | null }) {
  return <header className="ch-studio-welcome" aria-label="Your creator workspace">
    {media ? <a className="ch-editorial-portrait" href={media.portraitSource} target="_blank" rel="noreferrer"><img src={media.portrait} alt={`${displayName}, photographed fishing on his boat`} /><span>From Instagram ↗</span></a> : null}
    <div className="ch-studio-welcome__identity"><p className="ch-studio-eyebrow">Creator hub <span aria-hidden="true">∞</span></p><h1>{displayName}</h1><p className="ch-editorial-caption">EMG Loop Creator</p><p className="ch-studio-welcome__intro">{greeting}. {date}</p></div>
    <div className="ch-studio-welcome__actions"><Link className="ch-studio-task-link" href={CREATOR_HREFS.tasks}>{taskCount === null ? 'Check your tasks' : taskCount ? `${taskCount} ${taskCount === 1 ? 'thing needs' : 'things need'} you` : 'You’re all caught up.'} ↗</Link></div>
  </header>;
}
