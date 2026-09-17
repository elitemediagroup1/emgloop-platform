// Serializable transactions: recognising the conflict Postgres asks the caller to retry.
//
// Shared by the AI usage ledger (services/ai-usage-ledger.service.ts) and the Google
// connection repository. Kept at the repository level so a repository that opens a
// serializable transaction can retry it without importing a service.

/** Postgres aborted a serializable transaction because a concurrent one conflicted. */
export function isSerializationFailure(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; meta?: { code?: unknown } };
  if (e?.code === 'P2034') return true;
  if (e?.meta?.code === '40001') return true;
  return typeof e?.message === 'string' && /could not serialize access|40001/.test(e.message);
}
