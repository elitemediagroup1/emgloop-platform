import { AI_ADMISSION_REFUSALS } from '@emgloop/shared';

const PREFIX = 'MODEL_POLICY_REFUSED:';
/** Closed codes only. Never persist runtime/provider prose in capture status. */
export function creatorCapturePolicyFailure(refusals: readonly string[]): string {
  const codes = AI_ADMISSION_REFUSALS.filter(code => refusals.includes(code));
  return codes.length ? `${PREFIX}${codes.join(',')}` : 'MODEL_POLICY_REFUSED';
}

export function creatorCapturePolicyReasons(failure: string): readonly string[] {
  if (!failure.startsWith(PREFIX)) return [];
  const codes = failure.slice(PREFIX.length).split(',');
  return AI_ADMISSION_REFUSALS.filter(code => codes.includes(code));
}
