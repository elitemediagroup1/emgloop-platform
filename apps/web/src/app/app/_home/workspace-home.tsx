import ShellPage from '../../../workspaces/ShellPage';
import { workspaceFor, type WorkspaceRole } from '../../../workspaces/config';

// The home content for workspaces whose home is not built yet. Previously each
// lived at its own /app/<workspace> page; they now render at /app, unchanged.
// These show no data, so they need no authority beyond the signed-in session.

const DESCRIPTIONS: Record<Exclude<WorkspaceRole, 'ADMIN'>, string> = {
  EMPLOYEE: 'Your employee home inside Loop OS. Brain-powered summaries plug in here.',
  BUSINESS_OWNER: 'Your business home inside Loop OS. Brain-powered summaries plug in here.',
  CREATOR: 'Your creator home inside Loop OS. Brain-powered summaries plug in here.',
  CLIENT: 'Your client home inside Loop OS. Brain-powered summaries plug in here.',
};

export function WorkspacePlaceholderHome({ role }: { role: Exclude<WorkspaceRole, 'ADMIN'> }) {
  const ws = workspaceFor(role);
  return (
    <ShellPage
      eyebrow={ws.label + ' Workspace'}
      title="Dashboard"
      description={DESCRIPTIONS[role]}
      icon="grid"
      plannedFor={[
        'Consumes Brain Activity and Brain Briefings (read-only).',
        'Surfaces Recommendation Envelopes from the existing Brain.',
        'Never computes intelligence in the page.',
      ]}
    />
  );
}
