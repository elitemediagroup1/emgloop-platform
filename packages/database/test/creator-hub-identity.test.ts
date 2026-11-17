import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCreatorBrandRows,
  validCreatorBrandAliases,
} from '../src/creator/creator-brand-identity';
test('reviewed aliases consolidate identity across CRM and discovered mail without merging agencies', () => {
  const rows = [
    { brandId: 'candidate:old', brand: 'ACR' },
    { brandId: 'crm-one', brand: 'ACR Electronics' },
    { brandId: 'agency', brand: 'An Agency' },
  ];
  const mapped = resolveCreatorBrandRows(rows, { ACR: 'ACR Electronics' });
  assert.equal(mapped[0]!.brandId, 'crm-one');
  assert.equal(mapped[0]!.brand, 'ACR Electronics');
  assert.equal(mapped[2]!.brandId, 'agency');
  assert.equal(resolveCreatorBrandRows(rows, {})[0]!.brand, 'ACR');
});
test('cyclic, chained, empty and conflicting aliases cannot enter creator identity settings', () => {
  assert.equal(validCreatorBrandAliases({ ACR: 'ACR Electronics' }), true);
  for (const aliases of [
    { A: 'B', B: 'A' },
    { A: 'B', B: 'C' },
    { '': 'x' },
    { ACR: 'X', 'a.c.r.': 'Y' },
  ])
    assert.equal(validCreatorBrandAliases(aliases), false);
});
