import { handleMetaDeletion } from '../../../../../meta/meta-deletion';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { return handleMetaDeletion(request, false); }
