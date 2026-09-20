import { requirePermission } from '../../../auth/guard';
import { LOOP_HOME } from '../../../auth/landing';
import { googleWorkspace } from '../../../google/google-runtime';
import { loadGoogleSourceViews } from '../../../daily-loop/source-state';
import { viewerTime } from '../../../time/viewer-time';
import WorkspaceShell from '../../../workspaces/WorkspaceShell';
import { GoogleWorkspacePanel } from '../_google/google-workspace-panel';
import { googleOutcomeParam, googleReconnectParam, type PageSearchParams } from '../_google/search-params';
import { SourceConnectionsPanel } from '../_connections/source-connections-panel';
import { connectionOutcomeParam } from '../_connections/search-params';
import { sourceConnections } from '../../../connections/source-connection-runtime';
import { LoopPage, PageHead, StateBlock } from '../_loop-os/record';

export const dynamic = 'force-dynamic';

// Connections: a person's OWN communication sources -- their Google Workspace connection
// (google-workspace-connection.md §11.3) and their Microsoft Teams / Telegram connections
// (source-connection.ts). Each is independently authorized and each connection is the person's
// own; the organization and person are always the signed session's. Every panel self-guards.

export default async function ConnectionsPage({ searchParams }: { searchParams?: PageSearchParams }) {
  const session = await requirePermission('googleWorkspace', 'view');
  const status = await googleWorkspace().status({
    organizationId: session.organizationId,
    userId: session.userId,
    name: session.name,
  });
  // What Loop has actually READ from each source, so a grant is never presented as a source in use.
  const sources = status.permitted ? await loadGoogleSourceViews({ organizationId: session.organizationId, userId: session.userId }, status) : {};
  // The person's own Teams/Telegram connections. Independently authorized (`sourceConnections`);
  // with the default environment nothing is configured and each tile says exactly that.
  const connectionStatus = await sourceConnections().status({ organizationId: session.organizationId, userId: session.userId, name: session.name });

  return (
    <WorkspaceShell session={session}>
      <LoopPage label="Connections">
        <PageHead
          trail={[{ label: 'Home', href: LOOP_HOME }, { label: 'Connections' }]}
          title="Connections"
          subtitle="Your own accounts: what Loop may read from them, and what it has read so far."
        />
        {status.permitted ? (
          <GoogleWorkspacePanel
            mode="CONNECTIONS"
            status={status}
            outcome={googleOutcomeParam(searchParams)}
            reconnect={googleReconnectParam(searchParams)}
            sources={sources}
            time={viewerTime()}
          />
        ) : (
          <StateBlock kind="denied" title="You cannot view connections here" body="Your role in this organization does not include a Google connection." />
        )}
        <SourceConnectionsPanel status={connectionStatus} outcome={connectionOutcomeParam(searchParams)} time={viewerTime()} />
      </LoopPage>
    </WorkspaceShell>
  );
}
