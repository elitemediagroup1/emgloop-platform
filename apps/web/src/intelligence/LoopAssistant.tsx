'use client';

import { useEffect, useRef, useState } from 'react';
import { formatInstant } from '@emgloop/shared';
import { usePathname } from 'next/navigation';

type Answer = {
  outcome: 'ANSWERED';
  answer: {
    headline: string;
    lines: { statement: string; citations: string[] }[];
    limitations: string[];
  };
  sources: { ref: string; domain: string; title: string }[];
  asOf: string;
};
type Turn = { question: string; result?: Answer; error?: string };
const REASONS: Record<string, string> = {
  TASK_NOT_ACTIVATED: 'Loop questions are not enabled for this deployment yet.',
  TASK_NOT_ENABLED: 'Loop questions are not enabled for this deployment yet.',
  POLICY_DENIED: 'The AI provider has not been approved for this information yet.',
  NO_CURRENT_EVIDENCE:
    'Loop has no current evidence it can use for this question. Your source readings need to refresh.',
  INVALID_DATE: 'Use a valid date in YYYY-MM-DD format.',
  DATE_RANGE_UNSUPPORTED:
    'Use a valid date or date range of up to ten years, or ask about last month or last year.',
};

function unavailableReason(reason: unknown): string {
  const code = String(reason ?? '');
  if (REASONS[code]) return REASONS[code]!;
  if (/BUDGET|CAPACITY|LANE/.test(code))
    return 'Loop’s AI allowance is currently unavailable. Please try again later.';
  if (/NOT_ENABLED|NOT_ACTIVATED|NOT_REGISTERED/.test(code))
    return 'Loop questions are not fully configured for this account yet.';
  if (/REJECTED_OUTPUT|UNSUPPORTED_CITATION/.test(code))
    return 'Loop could not validate an answer against the stored evidence, so it has not displayed one.';
  return 'Loop could not produce a supported answer. Try a specific record or reporting period, or try again shortly.';
}

/** Transient conversation only. Never stores private answers in localStorage or shares across logins. */
export function LoopAssistant({ timeZone }: { timeZone: string }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const path = usePathname();
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [turns, pending, open]);
  function close() {
    setOpen(false);
    button.current?.focus();
  }
  async function ask(event: React.FormEvent) {
    event.preventDefault();
    const q = question.trim();
    if (!q || busy.current) return;
    busy.current = true;
    setPending(true);
    setQuestion('');
    setTurns((old) => [...old.slice(-11), { question: q }]);
    try {
      const response = await fetch('/api/intelligence/question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: q,
          previousQuestions: turns.map((t) => t.question).slice(-4),
          page: path,
        }),
      });
      const result = await response.json();
      const error =
        response.ok && result.outcome === 'ANSWERED'
          ? undefined
          : (result.error ?? unavailableReason(result.reason));
      setTurns((old) =>
        old.map((t, i) =>
          i === old.length - 1 ? { ...t, ...(error ? { error } : { result }) } : t,
        ),
      );
    } catch {
      setTurns((old) =>
        old.map((t, i) =>
          i === old.length - 1
            ? { ...t, error: 'The connection was interrupted. Please try again.' }
            : t,
        ),
      );
    } finally {
      busy.current = false;
      setPending(false);
      input.current?.focus();
    }
  }
  return (
    <div className="loop-assistant">
      {open ? (
        <section
          className="loop-assistant__panel"
          id="loop-assistant-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="loop-assistant-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
          }}
        >
          <header className="loop-assistant__head">
            <div>
              <h2 id="loop-assistant-title">Ask Loop</h2>
              <p>Answers from your authorized Loop evidence</p>
            </div>
            <button type="button" onClick={close} aria-label="Close Ask Loop">
              ×
            </button>
          </header>
          <div
            className="loop-assistant__conversation"
            ref={scroll}
            aria-live="polite"
            aria-busy={pending}
          >
            {turns.length === 0 ? (
              <div className="loop-assistant__welcome">
                <h3>What would you like to understand?</h3>
                <p>
                  Ask about calls, campaigns, your conversations, or what needs attention. Answers
                  include their sources and any gaps.
                </p>
                <p>Try “How did our campaigns perform yesterday?” or “What needs my attention?”</p>
                <p>
                  For a specific day, use YYYY-MM-DD. CallGrid reporting uses Eastern time. A page’s
                  filters are not automatically applied to your question.
                </p>
              </div>
            ) : null}
            {turns.map((turn, i) => (
              <article key={i} className="loop-assistant__turn">
                <p className="loop-assistant__question">{turn.question}</p>
                {turn.result ? (
                  <div className="loop-assistant__answer">
                    <h3>{turn.result.answer.headline}</h3>
                    {turn.result.answer.lines.map((line, j) => (
                      <p key={j}>
                        {line.statement}
                        <small>
                          {line.citations
                            .map((ref) => turn.result!.sources.find((s) => s.ref === ref)?.title)
                            .filter(Boolean)
                            .join(' · ')}
                        </small>
                      </p>
                    ))}
                    {turn.result.answer.limitations.length ? (
                      <details>
                        <summary>Evidence gaps</summary>
                        <ul>
                          {turn.result.answer.limitations.map((l, j) => (
                            <li key={j}>{l}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    <small>
                      Evidence assembled{' '}
                      {formatInstant(turn.result.asOf, timeZone, 'dateTime', { withZone: true })}
                    </small>
                  </div>
                ) : turn.error ? (
                  <p role="status" className="loop-assistant__error">
                    {turn.error}
                  </p>
                ) : (
                  <p role="status">Reading your evidence…</p>
                )}
              </article>
            ))}
          </div>
          <form className="loop-assistant__form" onSubmit={ask}>
            <label htmlFor="loop-question">Your question</label>
            <textarea
              ref={input}
              id="loop-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="Ask about the information in Loop…"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div>
              <button
                type="button"
                disabled={pending || !turns.length}
                onClick={() => setTurns([])}
              >
                Clear conversation
              </button>
              <button type="submit" disabled={pending || !question.trim()}>
                {pending ? 'Reading…' : 'Ask Loop'}
              </button>
            </div>
            <small>
              Read-only · answers can be incomplete; check cited evidence before acting.
            </small>
          </form>
        </section>
      ) : null}
      <button
        className="loop-assistant__launcher"
        type="button"
        ref={button}
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-controls={open ? 'loop-assistant-panel' : undefined}
      >
        ✦ {open ? 'Close' : 'Ask Loop'}
      </button>
    </div>
  );
}
