import 'server-only';
import { appOrigin } from '@emgloop/shared';
import { readBusinessConfig, type TikTokBusinessKind } from '@emgloop/providers';
export { BUSINESS_CALLBACKS } from '@emgloop/providers';
export function readBusinessEnvironment(kind: TikTokBusinessKind, source: Readonly<Record<string,string|undefined>> = process.env, origin = appOrigin()) {
  return readBusinessConfig(kind,source,origin);
}
