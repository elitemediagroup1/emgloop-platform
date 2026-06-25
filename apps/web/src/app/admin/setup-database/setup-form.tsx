// TEMPORARY — REMOVE IN CLEANUP HOTFIX (see docs/HOTFIX-NEON-DB-SETUP.md).
//
// Client form for the internal /admin/setup-database page. It only collects the
// confirmation phrase and shows the server action's result. It never receives
// or references SETUP_SECRET — all secret handling stays on the server.

'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { runSetupAction, type ActionState } from './actions';

const initialState: ActionState = { status: 'idle' };

function RunButton() {
const { pending } = useFormStatus();
return (
<button
type="submit"
disabled={pending}
style={{
background: pending ? '#7f1d1d' : '#b91c1c',
color: 'white',
border: 'none',
padding: '10px 16px',
borderRadius: 6,
fontWeight: 600,
cursor: pending ? 'not-allowed' : 'pointer',
}}
>
{pending ? 'Running setup…' : 'Run database setup'}
</button>
);
}

export function SetupForm() {
const [state, formAction] = useFormState(runSetupAction, initialState);

return (
<form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 }}>
<label htmlFor="confirm" style={{ fontWeight: 600 }}>
Type <code>RUN DATABASE SETUP</code> to confirm:
</label>
<input
id="confirm"
name="confirm"
type="text"
autoComplete="off"
placeholder="RUN DATABASE SETUP"
style={{ padding: '10px 12px', borderRadius: 6, border: '1px solid #555', background: '#111', color: '#eee' }}
/>
<RunButton />

{state.status !== 'idle' && state.message ? (
<p style={{ color: state.status === 'ok' ? '#4ade80' : '#f87171', fontWeight: 600 }}>
{state.message}
</p>
) : null}

{state.result ? (
<pre
style={{
background: '#0a0a0a',
border: '1px solid #333',
borderRadius: 6,
padding: 12,
overflowX: 'auto',
fontSize: 12,
whiteSpace: 'pre-wrap',
}}
>
{JSON.stringify(state.result, null, 2)}
</pre>
) : null}
</form>
);
}
