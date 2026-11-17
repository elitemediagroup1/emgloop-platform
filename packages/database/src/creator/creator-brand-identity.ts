/** Only exact normalized names or manager-approved aliases join identities. Never fuzzy/agency inference. */
export const creatorBrandNameKey = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
export function creatorBrandAliasName(
  name: string,
  aliases: Readonly<Record<string, string>>,
): string {
  const key = creatorBrandNameKey(name);
  const pair = Object.entries(aliases).find(([a]) => creatorBrandNameKey(a) === key);
  return pair?.[1] ?? name;
}
export function resolveCreatorBrandRows<T extends { brandId: string; brand: string }>(
  rows: readonly T[],
  aliases: Readonly<Record<string, string>>,
): T[] {
  const identities = new Map<string, Set<string>>(),
    reviewed = new Set(Object.keys(aliases).map(creatorBrandNameKey));
  for (const row of rows) {
    const key = creatorBrandNameKey(creatorBrandAliasName(row.brand, aliases));
    if (!row.brandId.startsWith('candidate:')) {
      const ids = identities.get(key) ?? new Set<string>();
      ids.add(row.brandId);
      identities.set(key, ids);
    }
  }
  const ambiguous = new Set(
    [...identities]
      .filter(
        ([key, ids]) =>
          ids.size > 1 &&
          !rows.some(
            (row) =>
              creatorBrandNameKey(creatorBrandAliasName(row.brand, aliases)) === key &&
              reviewed.has(creatorBrandNameKey(row.brand)),
          ),
      )
      .map(([key]) => key),
  );
  const target = new Map<string, { id: string; name: string }>();
  for (const row of rows) {
    const name = creatorBrandAliasName(row.brand, aliases),
      key = creatorBrandNameKey(name),
      old = target.get(key);
    if (
      !old ||
      (old.id.startsWith('candidate:') && !row.brandId.startsWith('candidate:')) ||
      (old.id.startsWith('candidate:') === row.brandId.startsWith('candidate:') &&
        row.brandId.localeCompare(old.id) < 0)
    )
      target.set(key, { id: row.brandId, name });
  }
  return rows.map((row) => {
    const canonical = creatorBrandAliasName(row.brand, aliases);
    // Same display name is not enough to merge two distinct registered businesses.
    if (ambiguous.has(creatorBrandNameKey(canonical))) return { ...row, brand: canonical };
    const value = target.get(creatorBrandNameKey(creatorBrandAliasName(row.brand, aliases)))!;
    return { ...row, brandId: value.id, brand: value.name };
  });
}
export function validCreatorBrandAliases(aliases: Readonly<Record<string, string>>) {
  const normalized = new Map<string, string>();
  for (const [a, b] of Object.entries(aliases)) {
    const from = creatorBrandNameKey(a),
      to = creatorBrandNameKey(b);
    if (!from || !to || (normalized.has(from) && normalized.get(from) !== to)) return false;
    normalized.set(from, to);
  }
  // Targets must be final canonical names, never another intermediate alias or a cycle.
  return [...normalized].every(([, to]) => !normalized.has(to) || normalized.get(to) === to);
}
