import 'server-only';

// Executive Brain — server data loader (Sprint 26: full sensor instrumentation).
//
// The single seam between real data and the pure reasoning layer. It reads each
// business system that has REAL org-scoped rows, turns it into an ExecutiveSensor
// via the Evidence Engine, and hands the whole set to the provider-neutral Brain.
//
// The honest boundary is enforced HERE, not hidden:
//   - Instrumented (real windowed rows): Marketplace, CRM, Website Analytics,
//     Website Forms, Loop Activity, Users, and Marketplace Auction.
//   - Uninstrumented (no model, no real ingestion, or a shell stub): Gmail,
//     Google Calendar, AI Conversations, Tasks, Opportunities, Creator Pipeline,
//     Client Pipeline. Each is declared with WHY and what would wire it, so the
//     Evidence Coverage board shows them as "missing" rather than omitting them.
//     None is faked — instrumenting a domain with no rows would fabricate the
//     exact evidence the Brain exists to refuse.
//
// Every windowed sensor is read for the current AND the prior window, so What
// Changed is a real two-window comparison. `measure()` turns a thrown read into
// an ERROR Truth, so a database outage renders a banner, never a healthy-looking
// empty briefing.

import {
  assessMarketplaceCoverage,
  runMarketplaceIntelligence,
  marketplaceExecutiveSensor,
  buildDomainSensor,
  runExecutiveBrain,
  uninstrumentedSensor,
  type DomainMetricInput,
  type ExecutiveBrainReport,
  type ExecutiveSensor,
} from '@emgloop/intelligence';
import { measure, success, type Truth, type TruthMeta } from '@emgloop/shared';
import { crmRepos } from '../../../../crm/crm-data';

const WINDOW_DAYS = 7;
const WINDOW_LABEL = 'Last 7 days';
const DAY_MS = 24 * 60 * 60 * 1000;
const AUCTION_PROVIDER = 'callgrid';

/** A provenance row for a domain metric — names the real read behind it. */
function prov(sourceLabel: string, derivation: string) {
  return [{ sourceId: sourceLabel, sourceLabel, derivation, citation: null }];
}

/** The sensors that have no real evidence source yet. Declared, never omitted,
 * so the coverage board states each gap and what would close it. */
const UNINSTRUMENTED: readonly ExecutiveSensor[] = [
  uninstrumentedSensor(
    'gmail',
    'Gmail',
    'No inbound email ingestion exists — only outbound send (Resend). There is no message history to observe.',
    'An inbound email (Gmail/IMAP) ingestion adapter that persists messages, plus a windowed read.',
  ),
  uninstrumentedSensor(
    'calendar',
    'Google Calendar',
    'Only a mock calendar provider exists; bookings are not populated by any real sync.',
    'A real Google Calendar adapter, populated Booking rows, and a windowed read.',
  ),
  uninstrumentedSensor(
    'ai-conversations',
    'AI Conversations',
    'There is no LLM in the platform; AI Employees are configuration, not reasoning, and no AI conversation content is produced.',
    'A real AI provider behind ai.provider.ts and persisted AI conversations to observe.',
  ),
  uninstrumentedSensor(
    'tasks',
    'Tasks',
    'There is no Task model. The Work OS runtime is a separate domain (blueprint work), not a task list.',
    'A Task model with real task rows, or wiring the Work OS as its own sensor.',
  ),
  uninstrumentedSensor(
    'opportunities',
    'Opportunities',
    'There is no Opportunity model; only an UPSELL_OPPORTUNITY signal type exists.',
    'An Opportunity/deal model with a pipeline, or a Signal-derived opportunity sensor.',
  ),
  uninstrumentedSensor(
    'creator-pipeline',
    'Creator Pipeline',
    'The Creator workspace is a shell stub with no persisted data.',
    'A creator pipeline model with real creator rows.',
  ),
  uninstrumentedSensor(
    'client-pipeline',
    'Client Pipeline',
    'The Client workspace is a shell stub with no persisted data.',
    'A client pipeline model with real client rows.',
  ),
];

export interface ExecutiveBrainResult {
  /** ERROR when the read failed — never an empty (healthy-looking) report. */
  report: Truth<ExecutiveBrainReport>;
}

/**
 * Load the Executive Brain report for an organization over the trailing window,
 * compared against the immediately prior window. Pure engine, real data; `now`
 * is injected so the run is reproducible in tests.
 */
export async function loadExecutiveBrain(
  organizationId: string,
  now: Date = new Date(),
): Promise<ExecutiveBrainResult> {
  const until = now;
  const since = new Date(until.getTime() - WINDOW_DAYS * DAY_MS);
  const priorUntil = since;
  const priorSince = new Date(since.getTime() - WINDOW_DAYS * DAY_MS);
  const measuredAt = until.toISOString();
  const meta: TruthMeta = { measuredAt, subject: 'executive.brain' };

  const report = await measure<ExecutiveBrainReport>(
    async () => {
      const [
        coverageObs,
        crmCur,
        crmPrior,
        webCur,
        webPrior,
        activityCur,
        activityPrior,
        userCounts,
        auctionRuns,
      ] = await Promise.all([
        crmRepos.marketplaceCalls.coverageObservations(organizationId, since, until),
        crmRepos.crm.windowCounts(organizationId, since, until),
        crmRepos.crm.windowCounts(organizationId, priorSince, priorUntil),
        crmRepos.websiteAnalytics.getWebsiteAnalytics(organizationId, since, until),
        crmRepos.websiteAnalytics.getWebsiteAnalytics(organizationId, priorSince, priorUntil),
        crmRepos.domainEvents.windowActivity(organizationId, since, until),
        crmRepos.domainEvents.windowActivity(organizationId, priorSince, priorUntil),
        crmRepos.iam.userCounts(organizationId),
        crmRepos.marketplaceAuction.latestRuns(organizationId, AUCTION_PROVIDER, 24),
      ]);

      // --- Marketplace (call coverage) — the reference sensor ---------------
      const coverage = assessMarketplaceCoverage({
        windowLabel: WINDOW_LABEL,
        callsIngested: coverageObs.callsIngested,
        populated: coverageObs.populated,
      });
      const marketplace = marketplaceExecutiveSensor(
        runMarketplaceIntelligence({ coverage, measuredAt }),
      );

      // --- CRM ---------------------------------------------------------------
      const crmMetrics: DomainMetricInput[] = [
        { metricId: 'crm.new_customers', label: 'New customers', narrative: 'New customers', observed: crmCur.newCustomers, total: null, prior: crmPrior.newCustomers, trackChange: true, provenance: prov('CRM — Customer', 'COUNT of customers created in the window') },
        { metricId: 'crm.conversations', label: 'Conversations opened', narrative: 'Conversations opened', observed: crmCur.conversations, total: null, prior: crmPrior.conversations, trackChange: true, provenance: prov('CRM — Conversation', 'COUNT of conversations created in the window') },
        { metricId: 'crm.assigned', label: 'Assigned conversations', observed: crmCur.conversationsAssigned, total: crmCur.conversations, raiseCoverageGap: true, owner: 'operations', gapImpact: 'Unassigned conversations get slower first responses, where conversion leaks first.', gapRecommendation: 'Assign or auto-route open conversations so none waits without an owner.', provenance: prov('CRM — Conversation', 'COUNT of conversations with an assignee, over conversations opened') },
      ];
      const crm = buildDomainSensor({
        id: 'crm', label: 'CRM', domain: 'crm', scopeLabel: WINDOW_LABEL.toLowerCase(),
        populationSize: crmCur.newCustomers + crmCur.conversations,
        staleAfterMs: null, measuredAt, affectedArea: 'Sales pipeline',
        emptyScopeReason: 'No customers or conversations were created in this window, so there is nothing to measure. Unknown is not zero.',
        metrics: crmMetrics,
      });

      // --- Website Analytics -------------------------------------------------
      const website = buildDomainSensor({
        id: 'website', label: 'Website Analytics', domain: 'website', scopeLabel: WINDOW_LABEL.toLowerCase(),
        populationSize: webCur.totals.events,
        staleAfterMs: null, measuredAt, affectedArea: 'Website',
        emptyScopeReason: 'No website events were ingested in this window, so there is nothing to measure. Unknown is not zero.',
        metrics: [
          { metricId: 'website.sessions', label: 'Website sessions', narrative: 'Website sessions', observed: webCur.totals.sessions, total: null, prior: webPrior.totals.sessions, trackChange: true, provenance: prov('Website events', 'COUNT of web.session_start events in the window') },
          { metricId: 'website.events', label: 'Website events', narrative: 'Website events', observed: webCur.totals.events, total: null, prior: webPrior.totals.events, trackChange: true, provenance: prov('Website events', 'COUNT of website interactions in the window') },
          { metricId: 'website.cta_clicks', label: 'CTA clicks', narrative: 'CTA clicks', observed: webCur.totals.ctaClicks, total: null, prior: webPrior.totals.ctaClicks, trackChange: true, provenance: prov('Website events', 'COUNT of CTA-click events in the window') },
        ],
      });

      // --- Website Forms -----------------------------------------------------
      const websiteForms = buildDomainSensor({
        id: 'website-forms', label: 'Website Forms', domain: 'website-forms', scopeLabel: WINDOW_LABEL.toLowerCase(),
        populationSize: webCur.totals.formSubmits + webCur.totals.appointmentRequests,
        staleAfterMs: null, measuredAt, affectedArea: 'Lead capture',
        emptyScopeReason: 'No form submissions were captured in this window, so there is nothing to measure. Unknown is not zero.',
        metrics: [
          { metricId: 'forms.submits', label: 'Form submissions', narrative: 'Form submissions', observed: webCur.totals.formSubmits, total: null, prior: webPrior.totals.formSubmits, trackChange: true, provenance: prov('Website events', 'COUNT of form-submit events in the window') },
          { metricId: 'forms.appointments', label: 'Appointment requests', narrative: 'Appointment requests', observed: webCur.totals.appointmentRequests, total: null, prior: webPrior.totals.appointmentRequests, trackChange: true, provenance: prov('Website events', 'COUNT of appointment-request events in the window') },
        ],
      });

      // --- Loop Activity (org-scoped DomainEvent spine) ----------------------
      const activity = buildDomainSensor({
        id: 'activity', label: 'Loop Activity', domain: 'activity', scopeLabel: WINDOW_LABEL.toLowerCase(),
        populationSize: activityCur.events,
        // A freshness policy so the coverage board can flag a quiet/stale spine.
        staleAfterMs: 3 * DAY_MS, measuredAt, affectedArea: 'Platform activity',
        emptyScopeReason: 'No platform events were recorded in this window, so there is nothing to measure. Unknown is not zero.',
        metrics: [
          { metricId: 'activity.events', label: 'Platform events', narrative: 'Platform activity', observed: activityCur.events, total: null, prior: activityPrior.events, trackChange: true, sourceObservedAt: activityCur.mostRecentAt?.toISOString() ?? null, provenance: prov('DomainEvent spine', 'COUNT of org domain events in the window') },
        ],
      });

      // --- Users (roster snapshot, not a window) -----------------------------
      const users = buildDomainSensor({
        id: 'users', label: 'Users', domain: 'users', scopeLabel: 'current roster',
        populationSize: userCounts.total,
        staleAfterMs: null, measuredAt, affectedArea: 'Team',
        emptyScopeReason: 'This organization has no active users, so there is nothing to measure.',
        metrics: [
          { metricId: 'users.active', label: 'Active users', observed: userCounts.active, total: userCounts.total, raiseCoverageGap: true, owner: 'admin', gapImpact: 'Invited users who never activated cannot act on anything the Brain surfaces.', gapRecommendation: 'Follow up on outstanding invitations so the team can act on briefings.', provenance: prov('Users', 'COUNT of ACTIVE users over the non-disabled roster') },
        ],
      });

      // --- Marketplace Auction (report-run presence + freshness) -------------
      const auctionSuccess = auctionRuns.filter((r) => r.status === 'SUCCESS').length;
      const latestFetch = auctionRuns[0]?.fetchedAt ?? null;
      const auction = buildDomainSensor({
        id: 'marketplace-auction', label: 'Marketplace Auction', domain: 'marketplace-auction', scopeLabel: 'latest report runs',
        populationSize: auctionRuns.length,
        staleAfterMs: 2 * DAY_MS, measuredAt, affectedArea: 'Marketplace auction',
        emptyScopeReason: 'No auction report runs have been recorded, so competitive-pressure evidence has nothing to measure. Unknown is not zero.',
        metrics: [
          { metricId: 'auction.runs', label: 'Successful report runs', observed: auctionSuccess, total: auctionRuns.length, raiseCoverageGap: true, owner: 'platform', gapImpact: 'Failed report runs leave gaps in bid/ping competitive data.', gapRecommendation: 'Investigate the failed auction report runs so competitive pressure can be read reliably.', sourceObservedAt: latestFetch?.toISOString() ?? null, provenance: prov('Auction report runs', 'COUNT of SUCCESS report runs over all recent runs') },
        ],
      });

      return runExecutiveBrain(
        [marketplace, crm, website, websiteForms, activity, users, auction, ...UNINSTRUMENTED],
        now,
      );
    },
    (value, m) => success(value, m),
    meta,
  );

  return { report };
}
