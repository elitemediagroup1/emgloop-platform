import 'server-only';

// Executive Brain — server data loader.
//
// The single seam between real data and the pure reasoning layer. It reads the
// canonical MarketplaceCall projection (via coverage observations), runs the
// Marketplace intelligence engine, builds the Marketplace SENSOR, and hands it —
// alongside the sensors the platform does not yet have — to the provider-neutral
// Executive Brain.
//
// This is the ONLY executive reasoning path. It replaces the old
// `loadExecutiveBriefing`, which ran the CallGrid module and composed a briefing
// whose confidence the module asserted about itself.
//
// Honest by construction: `measure()` turns a thrown read into an ERROR Truth,
// so a database outage can never arrive at the page as an empty (healthy-looking)
// report. "No calls in the window" and "we could not ask" stay different facts.

import {
  assessMarketplaceCoverage,
  runMarketplaceIntelligence,
  marketplaceExecutiveSensor,
  runExecutiveBrain,
  uninstrumentedSensor,
  type ExecutiveBrainReport,
  type ExecutiveSensor,
} from '@emgloop/intelligence';
import { measure, success, type Truth, type TruthMeta } from '@emgloop/shared';
import { crmRepos } from '../../../../crm/crm-data';

/** Matches the window every other Marketplace surface reports against. */
const WINDOW_DAYS = 7;
const WINDOW_LABEL = 'Last 7 days';

/**
 * The sensors named in the mission that are not yet wired. Declared
 * `uninstrumented` — with why and what would wire them — so the Evidence
 * Coverage panel STATES they are not contributing rather than silently omitting
 * them. This is how the Brain reports its own reach honestly, and it is what
 * keeps "Marketplace is merely one sensor" true on screen.
 */
const FUTURE_SENSORS: readonly ExecutiveSensor[] = [
  uninstrumentedSensor(
    'crm',
    'CRM',
    'No Evidence Engine contributor yet — customer, conversation and pipeline records do not feed the Brain.',
    'A CRM EvidenceContributor over customers, conversations and pipeline.',
  ),
  uninstrumentedSensor(
    'calendar',
    'Calendar',
    'No Evidence Engine contributor yet — bookings and availability do not feed the Brain.',
    'A Calendar EvidenceContributor over bookings and availability.',
  ),
  uninstrumentedSensor(
    'email',
    'Email',
    'No Evidence Engine contributor yet — message activity does not feed the Brain.',
    'An Email EvidenceContributor over send, receipt and engagement.',
  ),
  uninstrumentedSensor(
    'analytics',
    'Analytics',
    'No Evidence Engine contributor yet — session and traffic metrics do not feed the Brain.',
    'An Analytics EvidenceContributor over sessions and conversions.',
  ),
  uninstrumentedSensor(
    'website',
    'Website',
    'No Evidence Engine contributor yet — page and form events do not feed the Brain.',
    'A Website EvidenceContributor over page views and form submissions.',
  ),
];

export interface ExecutiveBrainResult {
  /** ERROR when the read failed — never an empty (healthy-looking) report. */
  report: Truth<ExecutiveBrainReport>;
}

/**
 * Load the Executive Brain report for an organization over the trailing window.
 * Pure engine, real data; `now` is injected so the run is reproducible in tests.
 */
export async function loadExecutiveBrain(
  organizationId: string,
  now: Date = new Date(),
): Promise<ExecutiveBrainResult> {
  const until = now;
  const since = new Date(until.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const meta: TruthMeta = { measuredAt: until.toISOString(), subject: 'executive.brain' };

  const report = await measure<ExecutiveBrainReport>(
    async () => {
      const observations = await crmRepos.marketplaceCalls.coverageObservations(
        organizationId,
        since,
        until,
      );
      const coverage = assessMarketplaceCoverage({
        windowLabel: WINDOW_LABEL,
        callsIngested: observations.callsIngested,
        populated: observations.populated,
      });
      const engine = runMarketplaceIntelligence({ coverage, measuredAt: until.toISOString() });
      const marketplace = marketplaceExecutiveSensor(engine);
      return runExecutiveBrain([marketplace, ...FUTURE_SENSORS], now);
    },
    (value, m) => success(value, m),
    meta,
  );

  return { report };
}
