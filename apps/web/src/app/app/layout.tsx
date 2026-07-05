import '../crm/crm.css';
import '../crm/sprint7.css';
import '../crm/sprint8.css';
import '../crm/sprint9.css';
import '../crm/sprint10.css';
import '../crm/design-system.css';
import '../crm/sprint16.css';

// Loop OS — /app layout (Phase 2, PR #47).
//
// Loads the shared operating-system design language (the same brand, sidebar,
// and design-system CSS the CRM uses) for every workspace under /app. It adds
// no shell of its own: each workspace layout renders WorkspaceShell with its own
// config, so the five workspaces share one design language but different nav.

export const metadata = {
  title: 'EMG Loop — Operating System',
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return children;
}
