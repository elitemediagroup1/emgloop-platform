import { requireWorkspace } from '../../../../workspaces/guard';
import UnavailablePage from '../../../../workspaces/UnavailablePage';

// An address in the admin tree with no page of its own. It states the tree's
// authority itself and renders the honest "not available" state: never a
// placeholder that presents an unbuilt or relocated surface as if it lived here.

export const dynamic = 'force-dynamic';

export default async function ADMINUnavailableRoute({
  params,
}: {
  params: { slug: string[] };
}) {
  await requireWorkspace('ADMIN');
  return <UnavailablePage href={'/app/admin/' + params.slug.join('/')} />;
}
