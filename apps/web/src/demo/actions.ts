// Server actions for the demo intake — Sprint 4 (Real Data Layer).
//
// A single Server Action runs the loop engine for a submitted HVAC quote
// request, persisting every record to PostgreSQL, then redirects to the
// timeline for the created customer. All provider work still happens through
// the mock provider abstractions — no external calls.

'use server';

import { redirect } from 'next/navigation';
import { runQuoteToBooking, type QuoteRequestInput } from './loop-engine';

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function submitQuoteRequest(formData: FormData): Promise<void> {
  const input: QuoteRequestInput = {
    name: str(formData, 'name') || 'Demo Customer',
    phone: str(formData, 'phone') || '+15555550000',
    email: str(formData, 'email') || 'demo@example.com',
    serviceType: str(formData, 'serviceType') || 'AC repair',
    city: str(formData, 'city') || 'Austin',
    state: str(formData, 'state') || 'TX',
    preferredWindow: str(formData, 'preferredWindow') || 'Tomorrow morning',
    notes: str(formData, 'notes') || undefined,
  };

  // Persisted run: appends a new customer journey to the database.
  const result = await runQuoteToBooking(input);
  redirect(`/demo/timeline?customer=${result.customerId}`);
}
