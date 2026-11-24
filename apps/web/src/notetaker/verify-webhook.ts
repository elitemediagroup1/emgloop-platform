import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhook(headers: Headers, body: Buffer, secret: string, now = Date.now()): boolean {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatures = headers.get('webhook-signature');
  if (!id || !timestamp || !signatures || !/^\d{1,12}$/.test(timestamp)
      || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > 300_000) return false;

  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  if (!key.length) return false;
  const expected = createHmac('sha256', key).update(id + '.' + timestamp + '.').update(body).digest();
  return signatures.split(' ').some(entry => {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(entry)) return false;
    const signature = Buffer.from(entry.slice(3), 'base64');
    return timingSafeEqual(signature, expected);
  });
}
