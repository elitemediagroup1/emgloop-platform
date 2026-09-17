// One activity item (handoff 2026-09-16, p. 10).
//
// Collapsed, an item tells the story and says what kind of truth it is. Expanded, it
// shows the evidence: when, how that time is known, who acted, the source and the
// authority that owns the record. Interpretation (signals, findings, recommendations)
// is drawn differently from recorded fact and says so in words.
//
// It renders what an authority recorded; it never composes a feed of its own. A
// surface with no governed source shows a StateBlock instead of an empty list.

import type { ActivityCategory } from '@emgloop/shared';
import { INTERPRETIVE_ACTIVITY_CATEGORIES } from '@emgloop/shared';
import { Facts, type FactRow } from './record';

/** The handoff's own names for the nine truth types. */
const TRUTH_LABEL: Record<ActivityCategory, string> = {
  FACT: 'Fact',
  COMMUNICATION: 'Communication',
  STATE_CHANGE: 'Change',
  WORK: 'Work',
  SIGNAL: 'Signal',
  FINDING: 'Finding',
  RECOMMENDATION: 'Recommendation',
  DECISION: 'Decision',
  AUDIT: 'Audit',
};

export function truthLabel(category: ActivityCategory): string {
  return TRUTH_LABEL[category];
}

export interface ActivityEntry {
  readonly key: string;
  readonly category: ActivityCategory;
  /** What happened, in one line. */
  readonly story: string;
  /** Display time in the reader's zone, and the canonical instant. */
  readonly when: string;
  readonly whenIso: string;
  /** Evidence shown when the item is opened. */
  readonly evidence: readonly FactRow[];
}

export function ActivityList({ entries, label }: { entries: readonly ActivityEntry[]; label: string }) {
  return (
    <ol className="loop-activity" aria-label={label}>
      {entries.map((entry) => (
        <ActivityItem key={entry.key} entry={entry} />
      ))}
    </ol>
  );
}

export function ActivityItem({ entry }: { entry: ActivityEntry }) {
  const interpretive = INTERPRETIVE_ACTIVITY_CATEGORIES.includes(entry.category);
  const kind = entry.category.toLowerCase();
  return (
    <li className="loop-act" data-truth={entry.category}>
      <details>
        <summary>
          <span className={`loop-act__truth loop-act__truth--${kind}`}>{truthLabel(entry.category)}</span>
          <span className="loop-act__story">{entry.story}</span>
          <time className="loop-act__when" dateTime={entry.whenIso}>
            {entry.when}
          </time>
        </summary>
        <div className="loop-act__detail">
          <Facts
            rows={[
              { label: 'Kind of truth', value: interpretive ? 'Interpretation, not a recorded fact' : 'Recorded by its authority' },
              ...entry.evidence,
            ]}
          />
        </div>
      </details>
    </li>
  );
}
