// TEMPORARY — REMOVE IMMEDIATELY AFTER USE.
//
// POST /api/admin/setup-database
//
// One-time, token-protected bootstrap endpoint that applies the Prisma schema
// to the live database (prisma migrate deploy) and runs the demo seed, from
// the DEPLOYED environment. It exists ONLY because migrations/seed cannot be
// run locally for this project.
//
// SECURITY:
//   - Disabled unless the SETUP_SECRET env var is set.
//   - Rejects every request whose x-setup-token header (or JSON body "token")
//     does not match SETUP_SECRET, using a constant-time comparison.
//   - Never returns or logs database credentials / connection strings.
//
// CLEANUP (REQUIRED): This route MUST be deleted in an immediate follow-up
// hotfix once setup succeeds. See docs/HOTFIX-NEON-DB-SETUP.md. Leaving a
// migrate+seed endpoint in production is a standing risk and is not a feature.
//
// Scope: bootstrap only. No business features, no real providers, no
// ServicesInMyCity integration are introduced here.

import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// Resolve the @emgloop/database package dir so we run prisma against its
// schema + migrations regardless of the function's cwd.
const DB_DIR = path.join(process.cwd(), '..', '..', 'packages', 'database');
const SCHEMA_PATH = path.join(DB_DIR, 'prisma', 'schema.prisma');

function tokensMatch(provided: string, expected: string): boolean {
const a = Buffer.from(provided);
const b = Buffer.from(expected);
if (a.length !== b.length) return false;
return timingSafeEqual(a, b);
}

interface CommandResult {
ok: boolean;
code: number | null;
stdout: string;
stderr: string;
}

// Runs a command, capturing output. The child inherits process.env so the
// Prisma CLI picks up DATABASE_URL itself; we never echo env back to callers.
function runCommand(command: string, args: string[], dbUrl: string): Promise<CommandResult> {
return new Promise((resolve) => {
const child = spawn(command, args, {
cwd: DB_DIR,
env: { ...process.env, DATABASE_URL: dbUrl },
shell: false,
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => { stdout += d.toString(); });
child.stderr.on('data', (d) => { stderr += d.toString(); });
child.on('error', (err) => {
resolve({ ok: false, code: null, stdout, stderr: stderr + String(err) });
});
child.on('close', (code) => {
resolve({ ok: code === 0, code, stdout, stderr });
});
});
}

export async function POST(request: Request): Promise<Response> {
const expected = process.env.SETUP_SECRET;

// Hard-disable unless an operator has configured the secret.
if (!expected) {
return NextResponse.json(
{ ok: false, error: 'Setup endpoint is disabled (SETUP_SECRET is not set).' },
{ status: 404 },
);
}

// Token may arrive via header or JSON body; header is preferred.
let provided = request.headers.get('x-setup-token') ?? '';
if (!provided) {
try {
const body = (await request.json()) as { token?: unknown };
if (typeof body?.token === 'string') provided = body.token;
} catch {
// no/invalid body — fall through to rejection
}
}

if (!provided || !tokensMatch(provided, expected)) {
return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
}

// Migrations must use a DIRECT (non-pooled) connection. Fall back to the
// pooled URL only if no direct URL is configured.
const directUrl = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!directUrl) {
return NextResponse.json(
{ ok: false, error: 'No database URL configured (DIRECT_DATABASE_URL / DATABASE_URL).' },
{ status: 500 },
);
}

// 1) Apply the schema.
const migrate = await runCommand(
'npx',
['prisma', 'migrate', 'deploy', '--schema', SCHEMA_PATH],
directUrl,
);
if (!migrate.ok) {
return NextResponse.json(
{
ok: false,
step: 'migrate',
exitCode: migrate.code,
// Output is Prisma CLI text only; it does not print the connection URL.
log: migrate.stdout + migrate.stderr,
},
{ status: 500 },
);
}

// 2) Seed demo data (idempotent upserts).
const seed = await runCommand('npx', ['prisma', 'db', 'seed'], directUrl);
if (!seed.ok) {
return NextResponse.json(
{
ok: false,
step: 'seed',
migrate: 'ok',
exitCode: seed.code,
log: seed.stdout + seed.stderr,
},
{ status: 500 },
);
}

return NextResponse.json({
ok: true,
migrate: 'ok',
seed: 'ok',
note: 'Setup complete. DELETE this endpoint now (see docs/HOTFIX-NEON-DB-SETUP.md).',
migrateLog: migrate.stdout,
seedLog: seed.stdout,
});
}

// Reject all non-POST methods explicitly.
export function GET(): Response {
return NextResponse.json({ ok: false, error: 'Method not allowed. Use POST.' }, { status: 405 });
}
