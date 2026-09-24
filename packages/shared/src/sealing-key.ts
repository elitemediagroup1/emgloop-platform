// A 32-byte sealing key, read from configuration text. PURE -- no I/O, no environment.
//
// Every AES-256-GCM sealer in Loop (Google refresh tokens, TikTok tokens) takes exactly 32
// bytes, handed in as base64 or base64url. This is the ONE parser: a key of any other length
// is a different key, not a shorter one, and is refused rather than padded or truncated.

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$|^[A-Za-z0-9_-]+$/;

/** Exactly 32 bytes, base64 or base64url; null for anything else. */
export function parseSealingKey(raw: string): Uint8Array | null {
  const text = raw.trim();
  if (!BASE64.test(text)) return null;
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  if (binary.length !== 32) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
