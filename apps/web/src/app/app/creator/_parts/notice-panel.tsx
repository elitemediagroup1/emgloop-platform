// "What Loop noticed" (Creator Hub, Mockup #1 region 7). PURE.
//
// Renders the Brain's ContentNotice as the epistemic ladder the design rules on: every
// rung tagged with how far it may be trusted (Fact, Observation, Interpretation,
// Proposed, Not yet) and carrying its own source. A withheld rung is drawn as the
// dashed card, never omitted. With no notice, or a notice with no rungs, the panel
// says nothing was noticed rather than inventing a line.
//
// Type-only import from @emgloop/database: this panel renders on Home and in tests.

import type { ContentNotice, NoticeRung } from '@emgloop/database';
import { Panel, StateBlock } from '../../_loop-os/record';

const RUNG_LABEL: Record<NoticeRung['rung'], string> = {
  FACT: 'Fact',
  OBSERVATION: 'Observation',
  INTERPRETATION: 'Interpretation',
  PROPOSED: 'Proposed',
  NOT_YET: 'Not yet',
};

const RUNG_CLASS: Record<NoticeRung['rung'], string> = {
  FACT: 'ch-tag--fact',
  OBSERVATION: 'ch-tag--obs',
  INTERPRETATION: 'ch-tag--int',
  PROPOSED: 'ch-tag--rec',
  NOT_YET: 'ch-tag--held',
};

function meta(rung: NoticeRung, when: ((iso: string) => string) | undefined): string {
  const parts = [rung.source];
  if (rung.observedAt && when) parts.push(when(rung.observedAt));
  if (typeof rung.sample === 'number') parts.push(`${rung.sample} piece${rung.sample === 1 ? '' : 's'}`);
  if (rung.standing) parts.push(`standing: ${rung.standing}`);
  return parts.join(' · ');
}

export function NoticeRungs({ notice, when }: { notice: ContentNotice; when?: (iso: string) => string }) {
  return (
    <>
      <ol className="ch-rungs" aria-label="What Loop noticed, rung by rung">
        {notice.rungs.map((rung, i) => (
          <li key={`${rung.rung}-${i}`} className={`ch-rung${rung.rung === 'NOT_YET' ? ' ch-rung--held' : ''}`} data-rung={rung.rung}>
            <div className="ch-rung__head">
              <span className={`ch-tag ${RUNG_CLASS[rung.rung]}`}>{RUNG_LABEL[rung.rung]}</span>
              <span className="ch-rung__meta">{meta(rung, when)}</span>
            </div>
            <p className="ch-rung__text">{rung.text}</p>
            {rung.restsOn ? <p className="ch-rung__meta">Rests on: {rung.restsOn}</p> : null}
            {rung.limitations && rung.limitations.length > 0 ? (
              <ul className="ch-rung__limits">
                {rung.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
      {notice.seeded ? (
        <p className="ch-seeded" data-seeded>
          Includes seeded demo data — not a platform report.
        </p>
      ) : null}
    </>
  );
}

/**
 * The panel. `notice` null (nothing loaded) or empty (nothing to say) both render the honest
 * empty state; the two differ only in that neither invents a rung.
 */
export function CreatorNoticePanel({ notice, when, title = 'What Loop noticed' }: { notice: ContentNotice | null; when?: (iso: string) => string; title?: string }) {
  return (
    <Panel title={title}>
      {notice && notice.rungs.length > 0 ? (
        <NoticeRungs notice={notice} when={when} />
      ) : (
        <StateBlock
          kind="unavailable"
          compact
          title="Nothing noticed yet"
          body="Loop shows only what it can defend: facts from the file first, then platform reports once a post is connected. Nothing is scored or forecast."
        />
      )}
    </Panel>
  );
}
