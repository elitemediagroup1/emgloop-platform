import { redirect } from 'next/navigation';

// Retired route — team & user management moved to Administration.
//
// Team management is an Administration function, not a CRM one, so its home is
// /app/admin/administration/team. This route redirects there so old links still
// work.

export const dynamic = 'force-dynamic';

export default async function UsersRedirect() {
  redirect('/app/admin/administration/team');
}
