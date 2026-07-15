import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

// Sprint 24 — the legacy Sprint-4 demo dashboard is retired.
//
// It read seeded demo metrics and duplicated the post-login home. There is now
// one canonical Workspace Home at /app/admin (reached via the role router), so
// this route permanently redirects there instead of presenting a second,
// demo-backed "home". No navigation links to /dashboard remain.
export default function LegacyDashboardRedirect() {
  redirect('/app/admin');
}
