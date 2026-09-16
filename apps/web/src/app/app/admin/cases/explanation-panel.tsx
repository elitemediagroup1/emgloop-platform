'use client';

// The Case Explanation panel. Slice AI-5. A client LEAF, and the smallest one that can
// do this: an answer is never stored, so it can only be shown to the person who asked,
// in the page they asked from.
//
// WHAT IT SAYS ABOUT ITSELF. A model wrote this, from the evidence on this page, and
// every statement cites what it rests on. It is not a finding, a decision or a
// recommendation, and it changes nothing. An answer that broke Loop's evidence rules
// is not shown at all -- the panel says so instead.
//
// OFF IS A STATE, NOT A HIDDEN BUTTON. When explanations are not enabled, not
// configured, paused, or not available to this person, the panel says which. The
// server re-decides all of it on every request regardless.

import { useState, useTransition } from 'react';

import { explainCaseAction } from './explanation-actions';
import type { ExplanationAvailability, ExplanationClaimView, ExplanationView } from './explanation-view';

const UNAVAILABLE: Record<Exclude<ExplanationAvailability, 'AVAILABLE'>, string> = {
  NOT_AUTHORIZED: 'Explanations can be requested by owners and admins.',
  NOT_ENABLED: 'AI explanations are not enabled for this workspace.',
  PAUSED: 'AI explanations are paused.',
  NOT_CONFIGURED: 'AI explanations are enabled but no provider is configured.',
};

const SECTIONS: { kind: ExplanationClaimView['kind']; title: string }[] = [
  { kind: 'OBSERVATION', title: 'What the evidence shows' },
  { kind: 'SIGNIFICANCE', title: 'Why it may matter' },
  { kind: 'CONSIDERATION', title: 'Worth looking into' },
];

function citationLabel(ref: string): string {
  const [type, id] = ref.split(':');
  const names: Record<string, string> = {
    'decision-evidence': 'Evidence',
    headline: 'Headline',
    finding: 'Finding',
    case: 'This investigation',
    monitoring: 'Monitoring',
    'case-outcome': 'Outcome',
  };
  const name = names[type ?? ''] ?? type ?? ref;
  return type === 'case' || type === 'monitoring' || type === 'case-outcome' ? name : `${name} ${id ?? ''}`.trim();
}

export function ExplanationPanel({ caseId, availability }: { caseId: string; availability: ExplanationAvailability }) {
  const [view, setView] = useState<ExplanationView | null>(null);
  const [pending, startTransition] = useTransition();

  const request = () =>
    startTransition(async () => {
      try {
        setView(await explainCaseAction(caseId));
      } catch {
        setView({ state: 'NOT_SHOWN', reason: 'The explanation could not be produced. Nothing was shown.', detail: [] });
      }
    });

  return (
    <section className="cw-sec" aria-labelledby="cw-explain">
      <header className="cw-sec__head">
        <h2 className="cw-sec__title" id="cw-explain">Explanation</h2>
        <p className="cw-sec__sub">
          Written by an AI model from the structured evidence on this page. Every statement cites what it rests on.
          It is not a finding, a decision or a recommendation, and it changes nothing.
        </p>
      </header>

      {availability !== 'AVAILABLE' ? (
        <p className="cw-todo">{UNAVAILABLE[availability]}</p>
      ) : (
        <div className="cw-ctl">
          <button type="button" className="cw-btn cw-btn--quiet" onClick={request} disabled={pending} aria-busy={pending}>
            {pending ? 'Explaining…' : view ? 'Explain again' : 'Explain this investigation'}
          </button>
          <p className="cw-ctl__note">
            Sends measured evidence only. Notes, names, contact details and who is involved are not sent.
          </p>
        </div>
      )}

      {view?.state === 'NOT_SHOWN' ? (
        <div className="cw-todo cw-ai__notshown" role="status">
          <p>{view.reason}</p>
          {view.detail.length > 0 ? <p className="cw-ai__codes">{view.detail.join(' · ')}</p> : null}
        </div>
      ) : null}

      {view?.state === 'ANSWERED' ? (
        <article className="cw-find cw-ai" aria-live="polite">
          <p className="cw-find__claim">{view.summary}</p>
          {SECTIONS.map(({ kind, title }) => {
            const claims = view.claims.filter((c) => c.kind === kind);
            if (claims.length === 0) return null;
            return (
              <div key={kind} className="cw-ai__group">
                <h3 className="cw-ai__title">{title}</h3>
                <ul className="cw-ai__list">
                  {claims.map((c, i) => (
                    <li key={`${kind}-${i}`}>
                      <span>{c.statement}</span>{' '}
                      <span className="cw-ai__cites">
                        {c.citations.map((ref) => (
                          <span key={ref} className="ps-badge ps-badge--idle" title={ref}>
                            <span className="ps-badge__label">{citationLabel(ref)}</span>
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {view.limitations.length > 0 ? (
            <div className="cw-ai__group">
              <h3 className="cw-ai__title">What the evidence could not tell</h3>
              <ul className="cw-ai__list">
                {view.limitations.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.aliases.length > 0 ? (
            <p className="cw-find__what">
              Labels used instead of names: {view.aliases.map((a) => `${a.alias} = ${a.name}`).join('; ')}.
            </p>
          ) : null}
          <details className="cw-find__tech">
            <summary>How this was produced</summary>
            <p className="cw-find__what">
              Model {view.model} · {view.versions} · {view.generatedAt.slice(0, 16).replace('T', ' ')} UTC
            </p>
            {view.withheld.length > 0 ? (
              <p className="cw-find__what">Not sent to the model: {view.withheld.join('; ')}.</p>
            ) : null}
            <p className="cw-find__what">This answer is not stored. Asking again produces a new one.</p>
          </details>
        </article>
      ) : null}
    </section>
  );
}
