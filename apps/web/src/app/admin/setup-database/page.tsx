// TEMPORARY — REMOVE IN CLEANUP HOTFIX (see docs/HOTFIX-NEON-DB-SETUP.md).
//
// Internal, DANGEROUS bootstrap page: /admin/setup-database
//
// Lets an operator run the one-time Neon migrate + seed from the browser WITHOUT
// exposing SETUP_SECRET. The secret is read server-side only (here, to gate
// rendering, and in the server action, to gate execution). It is never sent to
// the client, never rendered in HTML, and never logged or returned.
//
// Guarded by a typed confirmation phrase ("RUN DATABASE SETUP"). The page 404s
// unless SETUP_SECRET is configured. This is bootstrap plumbing, not a feature.

import { notFound } from 'next/navigation';
import { SetupForm } from './setup-form';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata = { robots: { index: false, follow: false } };

export default function SetupDatabasePage() {
// Render only if setup is enabled. We check for existence only — the value is
// never read into the response.
if (!process.env.SETUP_SECRET) {
notFound();
}

return (
<main style={{ maxWidth: 760, margin: '0 auto', padding: 24, color: '#eee', fontFamily: 'system-ui, sans-serif' }}>
<div
style={{
border: '2px solid #b91c1c',
background: '#1f0a0a',
borderRadius: 8,
padding: 16,
marginBottom: 20,
}}
>
<p style={{ margin: 0, fontWeight: 800, letterSpacing: 1, color: '#fca5a5' }}>
⚠ DANGER — INTERNAL / TEMPORARY
</p>
<p style={{ marginBottom: 0 }}>
This page runs <strong>prisma migrate deploy</strong> and the{' '}
<strong>seed</strong> against the live database for this environment. It is a
one-time bootstrap tool and must be removed immediately after use.
</p>
</div>

<h1 style={{ fontSize: 24, marginTop: 0 }}>Database setup</h1>
<p style={{ color: '#bbb' }}>
Running this applies the Prisma schema and seeds demo data. The seed is
idempotent, but only run this when you intend to initialize this environment&apos;s
database.
</p>

<SetupForm />
</main>
);
}
