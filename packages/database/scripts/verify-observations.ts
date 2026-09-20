// Read-only staging observation acceptance check. Prints ONLY safe PASS/FAIL results and counts.
//
// Usage (the workflow runs this): DATABASE_URL is injected from the staging secret; the provider is
// an argument (default TELEGRAM). It performs no writes and never prints the DATABASE_URL or any
// observation field -- the verifier returns a redacted report by construction.

import { PrismaClient } from '@prisma/client';
import { verifyObservations, isVerifiableProvider } from '../src/verification/source-observation-verifier';

async function main(): Promise<void> {
  const providerArg = process.argv[2] ?? 'TELEGRAM';
  if (!isVerifiableProvider(providerArg)) {
    console.error(`Unknown provider: ${providerArg}`);
    process.exitCode = 2;
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaClient();
  try {
    const report = await verifyObservations(prisma, providerArg);
    console.log(`Connections observation acceptance -- provider ${report.provider}`);
    console.log('----------------------------------------------------------------');
    for (const r of report.results) {
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.criterion}`);
      console.log(`      ${r.detail}`);
    }
    console.log('----------------------------------------------------------------');
    console.log(`Counts: ${JSON.stringify(report.counts)}`);
    console.log(`OVERALL: ${report.overall}`);
    process.exitCode = report.overall === 'PASS' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
