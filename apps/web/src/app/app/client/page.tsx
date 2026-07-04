import ShellPage from '../../../workspaces/ShellPage';
import { workspaceFor } from '../../../workspaces/config';

// Loop OS — Client dashboard (Phase 2, PR #47). Workspace home; shell only.
// It will consume Brain Activity / Briefings / Marketplace Intelligence /
// Recommendation Envelopes in a later PR — never computing intelligence here.

export default function CLIENTDashboard() {
  const ws = workspaceFor('CLIENT');
  return (
    <ShellPage
      eyebrow={ws.label + ' Workspace'}
      title="Dashboard"
      description="Your client home inside Loop OS. Brain-powered summaries plug in here."
      icon="grid"
      plannedFor={[
        'Consumes Brain Activity and Brain Briefings (read-only).',
        'Surfaces Recommendation Envelopes from the existing Brain.',
        'Never computes intelligence in the page.',
      ]}
    />
  );
}
