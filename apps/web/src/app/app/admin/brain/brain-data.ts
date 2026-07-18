import 'server-only';

// Executive Briefing — data loader.
//
// The thin runtime seam between real CallGrid data and the pure intelligence
// module. It mirrors the platform's existing Brain wiring precedent
// (api/brain/call-handling-briefing): read repo → run pure engine → project.
// It windows the current period against the immediately prior period (the
// module needs both to say what CHANGED), runs the CallGrid module, and composes
// the Executive Briefing. Today the briefing has one module; adding another is a
// second `run(...)` here and a second element in the array — no shape change.
//
// Honest by construction: bid/auction report facts and transcripts are not on
// the current data path, so they are passed as undefined and the module reports
// "Not enough data" for those sections rather than inventing them.

import {
  assembleExecutiveBriefing,
  runCallGridIntelligence,
  type CallGridIntelligenceInput,
  type ExecutiveBriefing,
} from '@emgloop/intelligence';
import { loadCallGridWindow } from './callgrid-facts';

const WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BriefingLoad {
  briefing: ExecutiveBriefing;
}

/**
 * Build the Executive Briefing for an organization over the trailing
 * `WINDOW_DAYS`, compared against the preceding equal window. Pure module,
 * real data. `now` is injected so the run is reproducible in tests.
 */
export async function loadExecutiveBriefing(
  organizationId: string,
  now: Date = new Date(),
): Promise<BriefingLoad> {
  const until = now;
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const priorUntil = since;
  const priorSince = new Date(since.getTime() - WINDOW_DAYS * DAY_MS);

  const [current, prior] = await Promise.all([
    loadCallGridWindow(organizationId, since, until),
    loadCallGridWindow(organizationId, priorSince, priorUntil),
  ]);

  const input: CallGridIntelligenceInput = {
    organizationId,
    window: {
      label: `Last ${WINDOW_DAYS} days`,
      since: since.toISOString(),
      until: until.toISOString(),
      priorSince: priorSince.toISOString(),
      priorUntil: priorUntil.toISOString(),
    },
    current,
    // A prior window with no calls is not a comparison basis — pass null so the
    // module withholds change/trend reads instead of comparing against zero.
    prior: prior.calls > 0 ? prior : null,
    // Not on the current data path — the module will report "Not enough data".
    bids: undefined,
    transcripts: undefined,
  };

  const output = runCallGridIntelligence(input, {
    now,
    idPrefix: `callgrid:${organizationId}:${since.toISOString()}`,
  });

  const briefing = assembleExecutiveBriefing([output], now);
  return { briefing };
}
