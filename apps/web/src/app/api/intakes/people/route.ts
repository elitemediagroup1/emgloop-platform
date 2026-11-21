import { requirePermission } from '../../../../auth/guard';
import { qualificationIntakes } from '../../../../intake/intake-runtime';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const session = await requirePermission('intakes', 'view');
  await requirePermission('identityResolution', 'view');
  const query = new URL(request.url).searchParams.get('q')?.trim().slice(0, 100) ?? '';
  const result = await qualificationIntakes().partyOptions(
    session.organizationId,
    session.userId,
    query,
    true,
  );
  return Response.json(
    { people: result?.parties.filter((p) => p.entityType === 'PERSON') ?? [] },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
