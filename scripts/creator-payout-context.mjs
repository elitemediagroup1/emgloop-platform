import {writeFileSync} from 'node:fs';
// Netlify CONTEXT is build-only, not a reliable runtime variable. Bake this nonsecret gate
// into both the Next server and the scheduled function, never into client configuration.
const context=['production','deploy-preview','branch-deploy'].includes(process.env.CONTEXT)?process.env.CONTEXT:'local';
writeFileSync(new URL('../packages/database/src/creator/payments/deploy-context.ts',import.meta.url),`// Generated at Netlify build time; contains no credentials. Local default is fail-closed.\nexport const PLAID_DEPLOY_CONTEXT = ${JSON.stringify(context)};\n`);
