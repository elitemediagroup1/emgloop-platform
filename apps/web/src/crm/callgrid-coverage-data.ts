import 'server-only';
import { repositories } from '@emgloop/database';
import { callGridPollCoverage } from './callgrid-coverage';

/** Session organization is supplied by the already-guarded page. No provider request. */
export async function loadCallGridPollCoverage(organizationId: string, now = new Date()) {
  try {
    const checkpoint = await repositories.pollCheckpoints.find(organizationId, 'callgrid', 'calls');
    return callGridPollCoverage({ readOk: true, now, checkpoint });
  } catch {
    return callGridPollCoverage({ readOk: false, now, checkpoint: null });
  }
}
