// TEMPORARY — REMOVE IN CLEANUP HOTFIX (see docs/HOTFIX-NEON-DB-SETUP.md).
//
// Server action for the internal /admin/setup-database page. Runs entirely on
// the server: it reads SETUP_SECRET from process.env only to gate execution,
// validates the typed confirmation phrase, and calls the shared
// runDatabaseSetup(). The secret is NEVER sent to the client or returned.

'use server';

import { runDatabaseSetup, type SetupResult } from '@/lib/setup-database';

const CONFIRM_PHRASE = 'RUN DATABASE SETUP';

export interface ActionState {
status: 'idle' | 'ok' | 'error';
message?: string;
result?: SetupResult;
}

export async function runSetupAction(
_prev: ActionState,
formData: FormData,
): Promise<ActionState> {
// Re-check server-side that setup is enabled. Never expose the secret value.
if (!process.env.SETUP_SECRET) {
return { status: 'error', message: 'Setup is disabled (SETUP_SECRET is not set).' };
}

const confirm = String(formData.get('confirm') ?? '').trim();
if (confirm !== CONFIRM_PHRASE) {
return {
status: 'error',
message: `Confirmation text did not match. Type exactly: ${CONFIRM_PHRASE}`,
};
}

const result = await runDatabaseSetup();
return {
status: result.ok ? 'ok' : 'error',
message: result.ok ? 'Database setup completed.' : 'Database setup failed.',
result,
};
}
