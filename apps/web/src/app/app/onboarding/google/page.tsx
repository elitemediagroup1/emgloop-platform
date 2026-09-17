import { redirect } from 'next/navigation';

import { LOOP_HOME, ONBOARDING_GOOGLE_PATH } from '../../../../auth/landing';
import { googleWorkspace } from '../../../../google/google-runtime';
import { viewerTime } from '../../../../time/viewer-time';
import { requireWorkspaceSession } from '../../../../workspaces/guard';
import WorkspaceShell from '../../../../workspaces/WorkspaceShell';
import { GoogleWorkspacePanel } from '../../_google/google-workspace-panel';
import { googleOutcomeParam, googleReconnectParam, type PageSearchParams } from '../../_google/search-params';
import { LoopPage, PageHead } from '../../_loop-os/record';

export const dynamic = 'force-dynamic';

// Employee onboarding: connect your own Google Workspace.
//
// Where a person lands right after accepting an invitation (landing.ts). Connecting is
// OPTIONAL (google-workspace-connection.md §2): each capability is its own approval on
// Google's screen, the person may connect some, all or none, and "Skip for now" continues
// to Loop Home exactly as "Continue" does. Anyone whose role holds no Google connection --
// an AI Employee -- continues to Loop Home without seeing this step.

export default async function GoogleOnboardingPage({ searchParams }: { searchParams?: PageSearchParams }) {
  const session = await requireWorkspaceSession(ONBOARDING_GOOGLE_PATH);
  const status = await googleWorkspace().status({
    organizationId: session.organizationId,
    userId: session.userId,
    name: session.name,
  });
  if (!status.permitted) redirect(LOOP_HOME);

  const firstName = session.name.trim().split(/\s+/)[0] || session.name;
  return (
    <WorkspaceShell session={session}>
      <LoopPage label="Onboarding">
        <PageHead
          trail={[{ label: 'Welcome' }, { label: 'Connect Google Workspace' }]}
          title={`Welcome to Loop, ${firstName}`}
          subtitle="Connect your own Google account so Loop can reference your mail, calendar and files where they matter. It is optional, and each kind of access is a separate approval."
        />
        <GoogleWorkspacePanel
          mode="ONBOARDING"
          status={status}
          outcome={googleOutcomeParam(searchParams)}
          reconnect={googleReconnectParam(searchParams)}
          time={viewerTime()}
        />
      </LoopPage>
    </WorkspaceShell>
  );
}
