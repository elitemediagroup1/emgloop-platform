import ShellPage from '../../../../workspaces/ShellPage';
import { workspaceFor } from '../../../../workspaces/config';

// Loop OS — EMPLOYEE workspace catch-all shell (Phase 2, PR #47).
//
// Every nav destination in this workspace (other than the dashboard) resolves
// here. It looks the incoming path up in the workspace CONFIG to render the
// correct title/icon as a premium shell page. This keeps Phase 2 to shells only
// while guaranteeing every nav link is a real, guarded route (no 404s). When a
// feature ships, it replaces this catch-all with a dedicated page at that path.
//
// Note: a REQUIRED catch-all ([...slug]) is used, not optional ([[...slug]]),
// so it does not collide with the workspace's own dashboard page.tsx.

export default function EMPLOYEEShellRoute({
  params,
}: {
  params: { slug: string[] };
}) {
  const ws = workspaceFor('EMPLOYEE');
  const href = ws.basePath + (params.slug?.length ? '/' + params.slug.join('/') : '');
  const item = ws.nav.flatMap((g) => g.items).find((i) => i.href === href);

  return (
    <ShellPage
      eyebrow={ws.label + ' Workspace'}
      title={item?.label ?? 'Workspace'}
      description={
        item
          ? item.label + ' lives here. This is the Loop OS shell; functionality arrives in a later PR.'
          : 'This surface is part of the Loop OS shell.'
      }
      icon={item?.icon ?? 'grid'}
    />
  );
}
