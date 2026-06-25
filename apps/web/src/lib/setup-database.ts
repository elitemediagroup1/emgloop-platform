// TEMPORARY — REMOVE IN CLEANUP HOTFIX (see docs/HOTFIX-NEON-DB-SETUP.md).
//
// Shared, SERVER-ONLY database bootstrap logic for the one-time Neon setup.
// Both the token-protected API route (POST /api/admin/setup-database) and the
// internal browser page (/admin/setup-database) call runDatabaseSetup().
//
// This module must NEVER be imported into a client component. It spawns the
// Prisma CLI to run `migrate deploy` + `db seed` against a DIRECT (non-pooled)
// connection. It does not read or return SETUP_SECRET, and it never logs or
// returns the database connection string.

import { spawn } from 'node:child_process';
import path from 'node:path';

const DB_DIR = path.join(process.cwd(), '..', '..', 'packages', 'database');
const SCHEMA_PATH = path.join(DB_DIR, 'prisma', 'schema.prisma');

export interface CommandResult {
ok: boolean;
code: number | null;
stdout: string;
stderr: string;
}

export interface SetupResult {
ok: boolean;
step?: 'migrate' | 'seed';
migrate?: 'ok';
seed?: 'ok';
exitCode?: number | null;
log?: string;
migrateLog?: string;
seedLog?: string;
error?: string;
}

// Runs a command, capturing output. The child inherits process.env so the
// Prisma CLI reads DATABASE_URL itself; we never echo env back to callers.
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

// Applies the schema (prisma migrate deploy) then seeds demo data (prisma db
// seed). Idempotent. Returns status text only — never credentials.
export async function runDatabaseSetup(): Promise<SetupResult> {
const directUrl = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!directUrl) {
return { ok: false, error: 'No database URL configured (DIRECT_DATABASE_URL / DATABASE_URL).' };
}

const migrate = await runCommand(
'npx',
['prisma', 'migrate', 'deploy', '--schema', SCHEMA_PATH],
directUrl,
);
if (!migrate.ok) {
return {
ok: false,
step: 'migrate',
exitCode: migrate.code,
log: migrate.stdout + migrate.stderr,
};
}

const seed = await runCommand('npx', ['prisma', 'db', 'seed'], directUrl);
if (!seed.ok) {
return {
ok: false,
step: 'seed',
migrate: 'ok',
exitCode: seed.code,
log: seed.stdout + seed.stderr,
};
}

return {
ok: true,
migrate: 'ok',
seed: 'ok',
migrateLog: migrate.stdout,
seedLog: seed.stdout,
};
}
