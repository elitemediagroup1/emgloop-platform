// @emgloop/intelligence — CallGrid transcript intelligence (extraction only).
//
// The mission draws a hard line: EXTRACT intelligence from transcripts, do NOT
// summarize them. This module therefore runs deterministic marker extraction —
// intent, buying signals, and rejection causes are counted from explicit phrase
// markers, never inferred by a model and never invented.
//
// The verified reality (see the ingestion audit) is that CallGrid does not
// deliver transcripts today: live webhooks have historically carried an empty
// body, and no mapper extracts a transcript field. So in production this input
// is almost always empty — and the honest output is `available: false` with a
// reason that states WHY, not a fabricated set of intents. The extraction path
// exists and is correct for the day transcripts do arrive; until then it stays
// silent rather than guessing.

import type { TranscriptIntelligence } from '../module';
import type { CallGridTranscriptSample } from './input';

/** Phrase markers → a normalized label. Deterministic and auditable. A marker
 * fires at most once per transcript so counts mean "transcripts exhibiting X",
 * not raw phrase frequency. */
interface MarkerSet {
  label: string;
  markers: string[];
}

const INTENT_MARKERS: MarkerSet[] = [
  { label: 'appointment_request', markers: ['appointment', 'schedule', 'book a', 'come out', 'set up a time'] },
  { label: 'pricing_inquiry', markers: ['how much', 'price', 'cost', 'quote', 'estimate'] },
  { label: 'immediate_need', markers: ['emergency', 'right now', 'today', 'as soon as', 'asap'] },
  { label: 'information_only', markers: ['just looking', 'just wondering', 'some information', 'just checking'] },
];

const BUYING_SIGNAL_MARKERS: MarkerSet[] = [
  { label: 'ready_to_proceed', markers: ['ready to', 'sign me up', 'let’s do it', 'lets do it', 'go ahead'] },
  { label: 'scheduling_intent', markers: ['when can you', 'what times', 'available', 'this week'] },
  { label: 'budget_confirmed', markers: ['budget', 'i can afford', 'that works for me', 'sounds good'] },
];

const REJECTION_MARKERS: MarkerSet[] = [
  { label: 'not_interested', markers: ['not interested', 'no thank', 'take me off', 'stop calling'] },
  { label: 'wrong_fit', markers: ['wrong number', 'don’t need', 'dont need', 'already have', 'not looking'] },
  { label: 'price_objection', markers: ['too expensive', 'too much', 'can’t afford', 'cant afford', 'out of my budget'] },
  { label: 'timing_objection', markers: ['not right now', 'call me later', 'maybe next', 'busy right now'] },
];

function countMarkers(
  transcripts: CallGridTranscriptSample[],
  sets: MarkerSet[],
): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of transcripts) {
    const text = t.text.toLowerCase();
    for (const set of sets) {
      if (set.markers.some((m) => text.includes(m))) {
        counts.set(set.label, (counts.get(set.label) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ intentOrCause: label, count }))
    .sort((a, b) => b.count - a.count)
    .map((r) => ({ label: r.intentOrCause, count: r.count }));
}

/**
 * Extract structured intelligence from whatever transcripts were supplied.
 * Returns `available: false` with an explicit reason when there are none —
 * never an empty-but-"available" result that would read as "we looked and found
 * nothing" when in truth there was nothing to look at.
 */
export function analyzeTranscripts(
  transcripts: CallGridTranscriptSample[] | undefined,
): TranscriptIntelligence {
  const samples = transcripts ?? [];
  if (samples.length === 0) {
    return {
      available: false,
      analyzed: 0,
      intents: [],
      rejectionCauses: [],
      buyingSignals: [],
      notEnoughDataReason:
        'No transcripts available. The CallGrid sensor does not deliver call transcripts on the current integration, so transcript intelligence cannot run. Connecting a transcript source (or enabling CallGrid recording+transcription) would populate this section.',
    };
  }

  const intents = countMarkers(samples, INTENT_MARKERS).map((r) => ({ intent: r.label, count: r.count }));
  const buyingSignals = countMarkers(samples, BUYING_SIGNAL_MARKERS).map((r) => ({ signal: r.label, count: r.count }));
  const rejectionCauses = countMarkers(samples, REJECTION_MARKERS).map((r) => ({ cause: r.label, count: r.count }));

  return {
    available: true,
    analyzed: samples.length,
    intents,
    rejectionCauses,
    buyingSignals,
  };
}
