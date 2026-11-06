import { createHmac, timingSafeEqual } from 'crypto';
export function verifyMetaSignedRequest(value: string, secret: string, now = Date.now()): string | null {
  if (!secret || value.length > 16_000) return null;
  const parts = value.split('.');
  if (parts.length !== 2 || parts.some(p => !p || !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  const [signature, payload] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(payload).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(expected, received)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
    if (data.algorithm !== 'HMAC-SHA256' || typeof data.user_id !== 'string' || !/^\d+$/.test(data.user_id) || typeof data.issued_at !== 'number' || data.issued_at * 1000 > now + 60_000 || data.issued_at * 1000 < now - 86400_000) return null;
    return data.user_id;
  } catch { return null; }
}
export function metaDeletionReceipt(secret: string, confirmation: string) { return createHmac('sha256', secret).update(`meta-deletion:${confirmation}`).digest('base64url'); }
export function verifyMetaDeletionReceipt(secret: string, confirmation: string, signature: string): boolean {
  if (!/^[a-f0-9-]{36}$/.test(confirmation) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(metaDeletionReceipt(secret, confirmation)), Buffer.from(signature));
}
