// Run manually against the EMG registry after confirming each site's production tag.
// Numeric IDs come from the GA account picker. A measurement ID is never a substitute.
import { prisma, WebPropertyRepository } from '@emgloop/database';

const portfolio = [
  ['gamedayinmycity', 'gamedayinmycity.com', '566017878'],
  ['foodinmycity', 'foodinmycity.com', '543673238'],
  ['marriageinmycity', 'marriageinmycity.com', '543501985'],
  ['merchinmycity', 'merchinmycity.com', '565352063'],
  ['petsinmycity', 'petsinmycity.com', '538920002'],
  ['servicesinmycity', 'servicesinmycity.com', '543157441'],
  ['consumersupporthelp', 'consumersupporthelp.com', null],
  ['jerseyshorehomeinfo', 'jerseyshorehomeinfo.com', null],
  ['dinnersdunn', 'dinnersdunn.app', null],
] as const;

async function main() {
  const apply = process.argv.includes('--apply');
  const org = await prisma.organization.findUniqueOrThrow({ where: { slug: 'servicesinmycity-demo' }, select: { id: true, status: true } });
  if (['SUSPENDED', 'CANCELED'].includes(org.status)) throw new Error('Organization is inactive');
  const registry = new WebPropertyRepository(prisma);
  const keys = portfolio.map(([key]) => key);
  for (const [key, primaryDomain, ga4PropertyId] of portfolio) {
    const registration = { key, primaryDomain, ...(ga4PropertyId ? { ga4PropertyId } : {}) };
    const preview = await registry.previewRegistration(org.id, registration);
    if (preview.outcome === 'REFUSED') throw new Error(key + ': ' + preview.problems.join(', '));
    const existing = await registry.findForOrganization(org.id, key);
    if (existing && (existing.lifecycle === 'RETIRED' || existing.lifecycle === 'PAUSED')) throw new Error(key + ' is paused or retired');
    if (existing?.ga4PropertyId && ga4PropertyId && existing.ga4PropertyId !== ga4PropertyId) throw new Error(key + ' already has a different GA4 property');
    console.log(key, existing ? existing.lifecycle + '/' + existing.ingestion : 'new', ga4PropertyId || 'GA ID not mapped');
  }
  if (!apply) return;
  for (const [key, primaryDomain, ga4PropertyId] of portfolio) {
    const existing = await registry.findForOrganization(org.id, key);
    if (!existing) {
      const result = await registry.register(org.id, { key, primaryDomain, ga4PropertyId });
      if (result.outcome === 'REFUSED') throw new Error(key + ': ' + result.problems.join(', '));
    } else if (ga4PropertyId && existing.ga4PropertyId !== ga4PropertyId) {
      const updated = await prisma.webProperty.updateMany({
        where: { id: existing.id, organizationId: org.id, primaryDomain, ga4PropertyId: null },
        data: { ga4PropertyId },
      });
      if (updated.count !== 1) throw new Error(key + ': binding changed during reconciliation');
    }
  }
  const planned = await registry.previewLiveCommission(org.id, keys);
  if (planned.outcome === 'REFUSED') throw new Error(JSON.stringify(planned.entries));
  const result = await registry.commissionLive(org.id, keys, new Date());
  if (result.outcome !== 'COMMISSIONED') throw new Error(JSON.stringify(result.entries));
  for (const [key, domain, ga] of portfolio) {
    const row = await registry.findForOrganization(org.id, key);
    if (row?.primaryDomain !== domain || row.lifecycle !== 'LIVE' || row.ingestion !== 'ENABLED' || (ga && row.ga4PropertyId !== ga)) throw new Error('Read-back failed: ' + key);
    console.log('Verified', domain, row.lifecycle, row.ingestion, row.ga4PropertyId || 'GA ID not mapped');
  }
}
main().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
