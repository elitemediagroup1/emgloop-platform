import { redirect } from 'next/navigation';

// Retired route — team & user management moved into the approved EMG Loop shell.
//
// It used to render inside the legacy CRM sidebar (this file lives under app/crm,
// so Next applied CRM_SHELL). Team management is an Administration function, not a
// CRM one, so the canonical home is now /app/admin/administration/team inside the
// global application shell. This route redirects there so old links still work.

export const dynamic = 'force-dynamic';

export default async function UsersRedirect() {
  redirect('/app/admin/administration/team');
}
