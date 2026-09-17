// Reading the Google outcome a redirect carried back to a page. Presentation only: an
// unknown value is ignored, and nothing here decides anything.

import {
  isGoogleConnectOutcome,
  parseGoogleWorkspaceCapabilities,
  type GoogleConnectOutcome,
  type GoogleWorkspaceCapability,
} from '@emgloop/shared';

export type PageSearchParams = { readonly [key: string]: string | string[] | undefined } | undefined;

function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

export function googleOutcomeParam(searchParams: PageSearchParams): GoogleConnectOutcome | null {
  const value = single(searchParams?.google);
  return isGoogleConnectOutcome(value) ? value : null;
}

export function googleReconnectParam(searchParams: PageSearchParams): GoogleWorkspaceCapability[] {
  const value = single(searchParams?.reconnect);
  return value ? (parseGoogleWorkspaceCapabilities(value) ?? []) : [];
}
