import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

// Sprint 24 — the legacy Sprint-4 demo dashboard is retired.
//
// It read seeded demo metrics and duplicated the post-login home. There is one
// Loop Home, at /app, so this route redirects straight there. No navigation
// links to /dashboard remain.
export default function LegacyDashboardRedirect() {
  redirect('/app');
}
