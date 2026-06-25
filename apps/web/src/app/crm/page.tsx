import { redirect } from 'next/navigation';

// /crm — Sprint 5 (Internal CRM, Phase 1).
// The CRM home redirects to the Customers console, which is the primary
// operating surface for the internal team.

export const dynamic = 'force-dynamic';

export default function CrmIndex() {
  redirect('/crm/customers');
}
