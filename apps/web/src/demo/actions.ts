// Server actions for the Sprint 3 demo (First Customer Loop).
//
// A single Server Action runs the loop engine for a submitted HVAC quote
// request, then redirects to the timeline for the created customer. All work
// happens server-side through the provider abstractions — no external calls.

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

  // Fresh run (reset = true) so the demo is deterministic and self-contained.
  const result = await runQuoteToBooking(input, true);
  redirect(`/demo/timeline?customer=${result.customer.id}`);
}
