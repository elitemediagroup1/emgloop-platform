// Prisma seed — Sprint 4 (Real Data Layer).
//
// Seeds REAL persisted demo data via the repository layer (never raw Prisma):
//   - a demo organization (ServicesInMyCity, the FIRST data source)
//   - a default AI Employee ("Ava")
//   - a handful of HVAC customers
//   - a "quote_request" interaction on each customer's timeline
//
// Idempotent: re-running upserts the org and ensures the AI Employee + customers
// by externalId, so `prisma db seed` is safe to run repeatedly.
//
// Run: npm run seed  (workspace @emgloop/database) — see package.json.

import { prisma } from '../src';
import { createRepositories } from '../src/repositories';

const ORG_SLUG = 'servicesinmycity-demo';

interface SeedCustomer {
  externalId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  serviceType: string;
  notes?: string;
}

const SEED_CUSTOMERS: SeedCustomer[] = [
  {
    externalId: 'sic-demo-maria',
    firstName: 'Maria',
    lastName: 'Gonzalez',
    email: 'maria@example.com',
    phone: '+15125550133',
    city: 'Austin',
    state: 'TX',
    serviceType: 'AC repair',
    notes: 'Upstairs unit not cooling.',
  },
  {
    externalId: 'sic-demo-james',
    firstName: 'James',
    lastName: 'Carter',
    email: 'james@example.com',
    phone: '+14155550178',
    city: 'San Jose',
    state: 'CA',
    serviceType: 'furnace tune-up',
  },
  {
    externalId: 'sic-demo-priya',
    firstName: 'Priya',
    lastName: 'Nair',
    email: 'priya@example.com',
    phone: '+12065550190',
    city: 'Seattle',
    state: 'WA',
    serviceType: 'thermostat install',
  },
];

async function main(): Promise<void> {
  const repos = createRepositories(prisma);

  // 1) Demo organization. ServicesInMyCity is the FIRST data source.
  const organization = await prisma.organization.upsert({
    where: { slug: ORG_SLUG },
    update: {},
    create: {
      name: 'ServicesInMyCity (Demo)',
      slug: ORG_SLUG,
      industry: 'HOME_SERVICES',
      status: 'ACTIVE',
      sourceKey: 'servicesinmycity',
      timezone: 'America/Chicago',
    },
  });
  console.log('Organization:', organization.slug, organization.id);

  // 2) Default AI Employee.
  const ai = await repos.aiEmployees.ensureDefault({
    organizationId: organization.id,
    name: 'Ava',
    title: 'Front Desk AI Employee',
  });
  console.log('AI Employee:', ai.name, ai.id);

  // 3) Customers + their inbound quote-request interaction.
  for (const c of SEED_CUSTOMERS) {
    const customer = await repos.customers.upsertByExternalId({
      organizationId: organization.id,
      externalId: c.externalId,
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      phone: c.phone,
      attributes: {
        source: 'servicesinmycity',
        serviceType: c.serviceType,
        city: c.city,
        state: c.state,
      },
    });

    await repos.interactions.create({
      organizationId: organization.id,
      customerId: customer.id,
      channel: 'WEB_CHAT',
      kind: 'FORM_SUBMISSION',
      direction: 'INBOUND',
      summary: `HVAC quote request (${c.serviceType})`,
      payload: {
        loopKind: 'quote_request',
        serviceType: c.serviceType,
        notes: c.notes ?? null,
        preferredWindow: 'Tomorrow morning',
      },
    });

    await repos.signals.record({
      organizationId: organization.id,
      customerId: customer.id,
      label: 'lead.received',
      payload: { serviceType: c.serviceType, city: c.city },
    });

    await repos.domainEvents.emit({
      organizationId: organization.id,
      name: 'customer.created',
      aggregateType: 'customer',
      aggregateId: customer.id,
      payload: { externalId: c.externalId },
    });

    console.log('Seeded customer:', c.firstName, c.lastName, customer.id);
  }

  console.log('Seed complete.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
