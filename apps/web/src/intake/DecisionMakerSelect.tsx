'use client';
import { useState } from 'react';
type Person = { id: string; displayName: string | null };
export function DecisionMakerSelect({
  people,
  defaultValue,
}: {
  people: Person[];
  defaultValue: string | null;
}) {
  const [results, setResults] = useState(people),
    [selected, setSelected] = useState(defaultValue ?? '');
  const [query, setQuery] = useState(''),
    [message, setMessage] = useState(''),
    [pending, setPending] = useState(false);
  return (
    <div className="loop-field">
      <span className="loop-label">Decision-maker</span>
      <div className="loop-btnrow">
        <input
          className="loop-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={100}
          aria-label="Find a decision-maker by name"
          placeholder="Find a CRM person…"
        />
        <button
          className="loop-btn"
          type="button"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            try {
              const response = await fetch(`/api/intakes/people?q=${encodeURIComponent(query)}`);
              if (!response.ok) throw new Error('unavailable');
              const data = (await response.json()) as { people: Person[] };
              const previous = results.find((p) => p.id === selected);
              setResults(
                previous && !data.people.some((p) => p.id === selected)
                  ? [previous, ...data.people]
                  : data.people,
              );
              setMessage(
                data.people.length
                  ? 'Choose a person from the matching records.'
                  : 'No established CRM people match that name.',
              );
            } catch {
              setMessage('People could not be loaded. Try again.');
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? 'Finding…' : 'Find person'}
        </button>
      </div>
      <select
        className="loop-select"
        aria-label="Decision-maker"
        name="decisionMakerPartyId"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
      >
        <option value="">Choose a CRM person</option>
        {selected && !results.some((p) => p.id === selected) ? (
          <option value={selected}>Previously selected person — search to review</option>
        ) : null}
        {results.map((p) => (
          <option key={p.id} value={p.id}>
            {p.displayName ?? p.id}
          </option>
        ))}
      </select>
      <span className="loop-note" role="status">
        {message}
      </span>
    </div>
  );
}
