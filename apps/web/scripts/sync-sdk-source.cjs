// Regenerate apps/web/src/app/sdk/sdk-source.ts from the static tracker (the source of truth).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'public/sdk/emg-loop.js'), 'utf8');
const version = /v(\d+\.\d+\.\d+)/.exec(src.split('\n')[0])[1];
const out =
  '// GENERATED -- do not edit. A byte-for-byte mirror of apps/web/public/sdk/emg-loop.js, the tracker sites load at\n' +
  '// /sdk/emg-loop.js. This copy is served at /api/sdk/emg-loop for programmatic consumers. Regenerate after\n' +
  '// editing the static file:  node apps/web/scripts/sync-sdk-source.cjs  (test/website-sdk.test.tsx enforces it).\n\n' +
  "export const EMG_LOOP_SDK_VERSION = '" + version + "';\n\n" +
  'export const EMG_LOOP_SDK_SOURCE: string = ' + JSON.stringify(src) + ';\n';
fs.writeFileSync(path.join(root, 'src/app/sdk/sdk-source.ts'), out);
