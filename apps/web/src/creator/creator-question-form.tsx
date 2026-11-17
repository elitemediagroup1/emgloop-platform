import { randomUUID } from 'crypto';
import { askCreatorTeamAction } from './creator-hub-actions';
export function CreatorQuestionForm({ brandId, brand }: { brandId?: string; brand?: string }) {
  return (
    <form action={askCreatorTeamAction} className="ch-question-form">
      <input type="hidden" name="submission" value={randomUUID()} />
      {brandId ? <input type="hidden" name="brandId" value={brandId} /> : null}
      <label className="loop-field">
        <span className="loop-label">
          {brand ? `Your message about ${brand}` : 'What can EMG help with?'}
        </span>
        <textarea
          className="loop-input"
          name="body"
          required
          maxLength={2000}
          rows={3}
          placeholder="Share your question, preference or feedback. This goes to your EMG team."
        />
      </label>
      <button className="loop-btn loop-btn--primary" type="submit">
        Send to EMG
      </button>
      <p className="loop-note">
        Saved privately in Loop for your team. This does not accept a contract, approve payment or
        send a message to the brand.
      </p>
    </form>
  );
}
