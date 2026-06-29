import { NextResponse } from 'next/server';
import {
  EMG_WEBSITE_PROPERTIES,
  propertyIdentifier,
  getProviderSpec,
} from '@emgloop/database';
import { EMG_LOOP_SDK_VERSION } from '../../../sdk/sdk-source';

// GET /api/sdk/config - public, per-property SDK configuration (Sprint 17).
//
// Returns the NON-SECRET configuration the EMG Loop SDK and the Website SDK
// manager need: the public property identifier, the ingest endpoint, the SDK
// version, and the recommended event list. It NEVER returns the signing secret -
// only whether one is configured (boolean), so the Integration OS can show the
// 'ready for external setup' vs 'live' state. Query with ?property=<key> for a
// single property, or omit it to list every EMG property.

export const dynamic = 'force-dynamic';

const APP_URL = 'https://app.emgloop.com';

function configFor(key: string) {
  const prop = EMG_WEBSITE_PROPERTIES.find((x) => x.key === key);
  if (!prop) return null;
  return {
    property: prop.key,
    name: prop.name,
    domain: prop.domain,
    identifier: propertyIdentifier(prop),
    endpoint: APP_URL + '/api/webhooks/website',
    sdkUrl: APP_URL + '/sdk/emg-loop.js',
    sdkVersion: EMG_LOOP_SDK_VERSION,
  };
}

export function GET(req: Request) {
  const url = new URL(req.url);
  const property = url.searchParams.get('property');
  const spec = getProviderSpec('website');
  const secretConfigured = !!process.env.WEBSITE_WEBHOOK_SECRET;

  const common = {
    secretConfigured,
    recommendedEvents: spec?.recommendedEvents ?? [],
    signatureHeaders: spec?.signatureHeaders ?? ['x-emg-signature'],
  };

  if (property) {
    const cfg = configFor(property);
    if (!cfg) {
      return NextResponse.json({ ok: false, error: 'unknown-property' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, ...common, config: cfg });
  }

  return NextResponse.json({
    ok: true,
    ...common,
    properties: EMG_WEBSITE_PROPERTIES.map((x) => configFor(x.key)),
  });
}
