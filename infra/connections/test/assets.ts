// A stand-in for `npm run bundle`'s output so the template tests need no esbuild run: one
// placeholder index.js per function, in a fresh temp directory. Shared by every test that
// synthesizes the app (lambda.Code.fromAsset requires the directory to exist at synth time).

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONNECTIONS_FUNCTIONS } from '../scripts/bundle';

export function stubAssets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'connections-assets-'));
  for (const f of CONNECTIONS_FUNCTIONS) {
    mkdirSync(join(dir, f.name));
    writeFileSync(join(dir, f.name, 'index.js'), 'exports.handler = async () => ({});');
  }
  return dir;
}
