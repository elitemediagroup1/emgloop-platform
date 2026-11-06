import 'server-only';
import { randomUUID } from 'crypto';
import { metaDeletionReceipt, verifyMetaSignedRequest } from '@emgloop/database';
import { appOrigin } from '@emgloop/shared';
import { readMetaEnvironment } from './meta-environment';
import { metaRepository } from './meta-runtime';
export async function handleMetaDeletion(request: Request, erase: boolean) {
  const env = readMetaEnvironment();
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  if (!env) return json({ ok: false }, 503);
  if (Number(request.headers.get('content-length') ?? 0) > 20_000) return json({ ok: false }, 413);
  const text = await request.text();
  if (text.length > 20_000) return json({ ok: false }, 413);
  const signed = new URLSearchParams(text).get('signed_request');
  const userId = signed ? verifyMetaSignedRequest(signed, env.config.appSecret) : null;
  if (!userId) return json({ ok: false }, 401);
  try {
    await metaRepository().eraseVerifiedMetaUser(userId, erase);
    if (!erase) return json({ ok: true });
    const confirmation = randomUUID();
    const query = new URLSearchParams({ confirmation, signature: metaDeletionReceipt(env.config.appSecret, confirmation) });
    return json({ url: `${appOrigin()}/api/integrations/meta/data-deletion?${query}`, confirmation_code: confirmation });
  } catch { return json({ ok: false }, 503); }
}
