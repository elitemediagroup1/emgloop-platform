import Link from 'next/link';
import type { CreatorSeat } from './creator-runtime';
import { creatorHubRepository } from './creator-hub-runtime';
export async function CreatorTeam({ seat }: { seat: CreatorSeat }) {
  const contacts = await creatorHubRepository().contacts(seat.actor);
  return (
    <section className="ch-team-card" aria-label="Your EMG team">
      <div className="ch-section-head">
        <div>
          <span className="ch-eyebrow">In your corner</span>
          <h2>Your EMG team</h2>
        </div>
        <Link className="loop-btn" href="/app/creator/tasks#team">
          Ask EMG →
        </Link>
      </div>
      {contacts.length ? (
        <ul className="ch-team-people">
          {contacts.map((c) => (
            <li key={c.id}>
              <span className="ch-brand-monogram">{c.name.slice(0, 1)}</span>
              <div>
                <strong>{c.name}</strong>
                <p>Your EMG contact</p>
                <a href={`mailto:${c.email}`}>{c.email}</a>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="loop-note">
          Questions go to EMG’s creator operations queue. Your assigned contacts will appear here
          once your team shares them.
        </p>
      )}
    </section>
  );
}
