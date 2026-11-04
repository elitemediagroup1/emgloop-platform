import { AI_ADMISSION_REFUSALS, AI_OUTPUT_REJECTIONS } from '@emgloop/shared';

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

const OUTPUT_PREFIX = 'MODEL_OUTPUT_REJECTED:';
export function creatorCaptureOutputFailure(rejections: readonly string[]): string {
  const codes = AI_OUTPUT_REJECTIONS.filter(code => rejections.includes(code));
  return codes.length ? `${OUTPUT_PREFIX}${codes.join(',')}` : 'MODEL_OUTPUT_REJECTED';
}
export function creatorCaptureOutputReasons(failure: string): readonly string[] {
  if (!failure.startsWith(OUTPUT_PREFIX)) return [];
  const codes = failure.slice(OUTPUT_PREFIX.length).split(',');
  return AI_OUTPUT_REJECTIONS.filter(code => codes.includes(code));
}
