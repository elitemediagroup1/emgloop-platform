import { CreatorHubRepository, creatorHubSettings, prisma, type EmgActor } from '@emgloop/database';
import { configureCreatorHubAction, replyCreatorQuestionAction } from './creator-hub-actions';
import type { TimeView } from '@emgloop/shared';
export async function CreatorSupportPanel({
  actor,
  profileId,
  preferences,
  time,
  outcome,
}: {
  actor: EmgActor;
  profileId: string;
  preferences: unknown;
  time: TimeView;
  outcome?: string;
}) {
  const repo = new CreatorHubRepository(prisma);
  const [options, questions, health] = await Promise.all([
    repo.staffOptions(actor),
    repo.managerMessages(actor, profileId),
    repo.health(actor, profileId),
  ]);
  const settings = creatorHubSettings(preferences);
  return (
    <section className="loop-panel" id="creator-support">
      <h2>Creator team, questions and data quality</h2>
      {outcome ? (
        <p role="status">
          {outcome === 'saved'
            ? 'Creator support settings saved.'
            : outcome === 'replied'
              ? 'Your reply is visible to this creator.'
              : 'The action was not completed.'}
        </p>
      ) : null}
      {options.length ? (
        <form action={configureCreatorHubAction} className="loop-stack">
          <input type="hidden" name="profileId" value={profileId} />
          <fieldset>
            <legend>Contacts shared with this creator (up to four)</legend>
            <p className="loop-note">
              Their names and work email addresses become creator-visible. The first available
              contact receives in-app questions.
            </p>
            {options.map((u) => (
              <label className="loop-field" key={u.id}>
                <input
                  type="checkbox"
                  name="team"
                  value={u.id}
                  defaultChecked={settings.team.includes(u.id)}
                />
                {u.name || u.email} · {u.email}
              </label>
            ))}
          </fieldset>
          <label className="loop-field">
            <span className="loop-label">Reviewed brand aliases</span>
            <textarea
              name="aliases"
              rows={5}
              className="loop-input"
              defaultValue={Object.entries(settings.aliases)
                .map(([a, b]) => `${a} = ${b}`)
                .join('\n')}
            />
            <span className="loop-note">
              One verified alias = canonical brand name per line. Confirm these are the same
              business; never merge an agency with its client. Exact normalized matches are combined
              automatically.
            </span>
          </label>
          <button className="loop-btn" type="submit">
            Save contacts and reviewed aliases
          </button>
        </form>
      ) : null}
      {health ? (
        <details>
          <summary>AI review health · {health.state}</summary>
          <p>Last result: {health.failure || 'No failure recorded'}</p>
          <p>
            Next eligible attempt:{' '}
            {health.nextAttemptAt ? time.dateTime(health.nextAttemptAt) : 'Not scheduled'}
          </p>
        </details>
      ) : (
        <p className="loop-note">No analytics review attempt is recorded for this creator.</p>
      )}
      <h3>Questions from this creator</h3>
      {questions.length ? (
        questions.map((q) => (
          <article key={q.id} className="loop-card">
            <h4>{q.title}</h4>
            <p>{q.body}</p>
            <small>
              {time.dateTime(q.at)} · {q.status}
            </small>
            {q.replies.map((r) => (
              <p key={r.id}>{r.body}</p>
            ))}
            <form action={replyCreatorQuestionAction} className="loop-stack">
              <input type="hidden" name="profileId" value={profileId} />
              <input type="hidden" name="id" value={q.id} />
              <label className="loop-field">
                Creator-visible reply
                <textarea className="loop-input" name="body" required maxLength={2000} />
              </label>
              <label>
                <input type="checkbox" name="complete" /> Mark this question answered
              </label>
              <button className="loop-btn" type="submit">
                Share reply in Loop
              </button>
            </form>
          </article>
        ))
      ) : (
        <p className="loop-note">
          No questions from this creator yet. Requests also appear in the existing Work OS queue.
        </p>
      )}
    </section>
  );
}
