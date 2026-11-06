import { verifyMetaDeletionReceipt } from '@emgloop/database';
import { handleMetaDeletion } from '../../../../../meta/meta-deletion';
import { readMetaEnvironment } from '../../../../../meta/meta-environment';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { return handleMetaDeletion(request, true); }
export async function GET(request: Request) {
  const env = readMetaEnvironment();
  const q = new URL(request.url).searchParams;
  const valid = env && verifyMetaDeletionReceipt(env.config.appSecret, q.get('confirmation') ?? '', q.get('signature') ?? '');
  return new Response(valid ? 'Your Meta analytics connection and imported Meta analytics data have been deleted from EMG Loop.' : 'Deletion receipt not found.', { status: valid ? 200 : 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}
