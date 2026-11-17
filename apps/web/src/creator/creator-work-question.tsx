import type { EmgActor } from '@emgloop/database';
import { creatorHubRepository } from './creator-hub-runtime';
import { replyCreatorQuestionAction } from './creator-hub-actions';
export async function CreatorWorkQuestion({ actor, workId }: { actor: EmgActor; workId: string }) {
  const question = await creatorHubRepository().questionForWork(actor, workId);
  if (!question) return null;
  return (
    <section className="loop-card">
      <h2>Reply to the creator</h2>
      <p>{question.body}</p>
      {question.replies.map((r) => (
        <p key={r.id}>{r.body}</p>
      ))}
      <form action={replyCreatorQuestionAction} className="loop-stack">
        <input type="hidden" name="profileId" value={question.profileId} />
        <input type="hidden" name="id" value={question.id} />
        <label className="loop-field">
          Creator-visible reply
          <textarea name="body" className="loop-input" required maxLength={2000} />
        </label>
        <label>
          <input type="checkbox" name="complete" />
          Mark this question answered
        </label>
        <button className="loop-btn loop-btn--primary">Share reply in Creator Hub</button>
        <p className="loop-note">
          This reply is shared with this creator in Loop. Generic work comments below are for EMG’s
          internal work notes.
        </p>
      </form>
    </section>
  );
}
