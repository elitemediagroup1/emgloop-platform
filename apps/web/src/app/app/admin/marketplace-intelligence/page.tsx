import ShellPage from '../../../../workspaces/ShellPage';
import { requireWorkspacePermission } from '../../../../workspaces/guard';

// Loop OS — Admin · Marketplace Intelligence (Phase 2, PR #47).
//
// Marketplace Intelligence is an ADMIN workspace surface — not "CallGrid
// Analytics", not "Reports". It is provider-neutral: CallGrid, Ringba, Twilio,
// Meta, Google Ads, TikTok, HubSpot, Salesforce, Stripe, and internal systems
// are all Sensors that feed the SAME canonical model (packages/marketplace-
// intelligence, PR #43–#46). This page is the shell only; it will CONSUME the
// canonical MarketplaceIntelligence snapshot (already assembled + Brain-enriched
// elsewhere) and never compute intelligence itself.
//
// Gated server-side by the existing IAM matrix (resource 'intelligence'), so
// only roles the matrix permits can reach it — no UI-only hiding.

export default async function MarketplaceIntelligencePage() {
  await requireWorkspacePermission('ADMIN', 'intelligence', 'view');

  return (
    <ShellPage
      eyebrow="Admin Workspace · Provider-neutral"
      title="Marketplace Intelligence"
      description="One canonical, sensor-agnostic view of the marketplace. Sensors change; Marketplace Intelligence does not."
      icon="chart"
      plannedFor={[
        'Consumes the canonical MarketplaceIntelligence snapshot (PR #43).',
        'Reads Brain-enriched health, confidence, recommendations, and insights (PR #46).',
        'Sensors: CallGrid, Ringba, Twilio, Meta, Google Ads, TikTok, HubSpot, Salesforce, Stripe, internal.',
        'Never CallGrid Analytics; never Reports; always provider-neutral.',
      ]}
    />
  );
}
