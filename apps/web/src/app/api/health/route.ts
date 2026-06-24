import { NextResponse } from 'next/server';

// Machine-readable health endpoint. Sprint 1: reports the app shell as healthy
// and downstream providers as "not configured" (none are wired up yet).
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'emgloop-web',
    sprint: 'sprint-1-platform-foundation',
    timestamp: new Date().toISOString(),
    components: {
      web: 'operational',
      database: 'not_configured',
      providers: {
        ai: 'not_configured',
        voice: 'not_configured',
        sms: 'not_configured',
        email: 'not_configured',
        payment: 'not_configured',
        calendar: 'not_configured',
      },
    },
  });
}
