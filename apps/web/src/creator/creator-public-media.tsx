import { creatorDeclaredSocialHandles } from '@emgloop/shared';

/** Reviewed public imagery, never a generated likeness or an assertion of API access. */
export function creatorPublicMedia(preferences: unknown) {
  const handles = creatorDeclaredSocialHandles(preferences);
  const raw = handles.INSTAGRAM ?? '';
  const handle = raw.startsWith('https://') ? new URL(raw).pathname.replace(/^\/+|\/+$/g, '') : raw.replace(/^@/, '');
  if (handle.toLowerCase() !== 'trevonbassmaster') return null;
  return {
    portrait: '/creator-media/trevonbassmaster/fishing-portrait.jpg',
    portraitSource: 'https://www.instagram.com/trevonbassmaster/p/DWuW3eREqlN/',
    photo: '/creator-media/trevonbassmaster/on-the-boat.jpg',
    photoSource: 'https://www.instagram.com/trevonbassmaster/p/DXQJaqujTa4/',
    checked: '2026-11-05T00:00:00Z',
    videos: [
      { id: '8S5OBRwQ3aM', title: 'Can They Really Ban You From Fishing Here?' },
      { id: 'W2hW8onhFJ8', title: 'I Found a HUGE BASS in a Neighborhood Pond!' },
      { id: 'QC0o8o7_ORQ', title: 'I Found a HIDDEN Fishing Pond on Google Maps!' },
    ],
  };
}
export type CreatorPublicMedia = NonNullable<ReturnType<typeof creatorPublicMedia>>;
export function CreatorPublicContent({ media }: { media: CreatorPublicMedia }) {
  return <section className="ch-editorial-content" aria-label="Creator content">
    <header><h2>Creator content</h2><a href="https://www.youtube.com/@Trevonbassmaster/videos" target="_blank" rel="noreferrer">YouTube ↗</a></header>
    <a href={media.photoSource} target="_blank" rel="noreferrer" className="ch-editorial-feature"><img src={media.photo} alt="Trevon fishing on his boat, from his Instagram" loading="lazy"/><span>On the water <small>From @trevonbassmaster on Instagram ↗</small></span></a>
    <ul>{media.videos.map(video => <li key={video.id}><a href={`https://www.youtube.com/watch?v=${video.id}`} target="_blank" rel="noreferrer"><img src={`/creator-media/trevonbassmaster/${video.id}.avif`} alt="" loading="lazy"/>{video.title}<span aria-hidden="true">↗</span></a></li>)}</ul>
    <p className="loop-note">Selected from his public accounts. Checked November 5, 2026. Not a connected or automatically updated feed.</p>
  </section>;
}
