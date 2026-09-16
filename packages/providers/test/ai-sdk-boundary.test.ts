// The provider SDKs are installed, and nothing is activated. Slice B5 (SDK step).
//
// Two dependencies arrived. That is a moment worth a test, because "the SDK is in
// package.json" is the single easiest thing to mistake for "Loop is calling a
// model". It is not, and these assertions are what keep the two apart.
//
// AN INSTALLED SDK IS NOT AN ACTIVATED PROVIDER. No adapter imports either package
// yet; nothing reads a credential; nothing makes a request. Adding the dependency
// makes S1 buildable, and changes nothing about what runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..', '..');

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', '.next', 'dist', '.turbo'].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
  };
  walk(join(REPO, root));
  return out;
}

test('both SDKs are declared by the providers package, and by nothing else', () => {
  const providers = JSON.parse(readFileSync(join(REPO, 'packages/providers/package.json'), 'utf8'));
  assert.ok(providers.dependencies['@anthropic-ai/sdk'], 'the Anthropic SDK is declared here');
  assert.ok(providers.dependencies.openai, 'the OpenAI SDK is declared here');

  // Nowhere else. A model SDK reachable from the domain or the app is how a
  // provider-neutral runtime stops being one.
  for (const manifest of ['package.json', 'apps/web/package.json', 'packages/shared/package.json', 'packages/database/package.json', 'packages/brain/package.json']) {
    const pkg = JSON.parse(readFileSync(join(REPO, manifest), 'utf8'));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    assert.equal(deps['@anthropic-ai/sdk'], undefined, `${manifest} must not depend on the Anthropic SDK`);
    assert.equal(deps.openai, undefined, `${manifest} must not depend on the OpenAI SDK`);
  }
});

test('the lockfile records both, so an install is reproducible', () => {
  const lock = readFileSync(join(REPO, 'package-lock.json'), 'utf8');
  assert.match(lock, /node_modules\/@anthropic-ai\/sdk/);
  assert.match(lock, /node_modules\/openai/);
});

const SDK_FILE = 'packages/providers/src/ai/adapters/sdk-clients.ts';
const ENV_FILE = 'apps/web/src/ai/ai-environment.ts';

function code(file: string): string {
  return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('exactly one file imports a model SDK', () => {
  const importers: string[] = [];
  let scanned = 0;
  for (const root of ['packages/shared/src', 'packages/database/src', 'packages/providers/src', 'packages/brain/src', 'apps/web/src']) {
    for (const file of sourceFiles(root)) {
      scanned += 1;
      const src = code(file);
      if (/from ['"](@anthropic-ai|openai)/.test(src) || /require\(['"](@anthropic-ai|openai)/.test(src) || /import\(['"](@anthropic-ai|openai)/.test(src)) {
        importers.push(file.slice(REPO.length + 1));
      }
    }
  }
  // The client factory builds a client from a credential it is HANDED. Nothing else
  // may see an SDK: not the runtime, not the adapters, not the app.
  assert.deepEqual(importers, [SDK_FILE]);
  assert.ok(scanned > 200, `the scan covered the repository (${scanned} files)`);
});

test('exactly one file imports the SDK factory, and the providers barrel does not export it', () => {
  const importers: string[] = [];
  for (const root of ['packages/shared/src', 'packages/database/src', 'packages/providers/src', 'packages/brain/src', 'apps/web/src']) {
    for (const file of sourceFiles(root)) {
      if (/sdk-clients['"]/.test(code(file))) importers.push(file.slice(REPO.length + 1));
    }
  }
  assert.deepEqual(importers, [ENV_FILE]);
  // Importing '@emgloop/providers' -- which webhooks and email do -- must never load an SDK.
  assert.doesNotMatch(code(join(REPO, 'packages/providers/src/index.ts')), /sdk-clients/);
});

test('exactly one file reads an AI credential; one pre-existing check reads only its presence', () => {
  const offenders: string[] = [];
  for (const root of ['packages/shared/src', 'packages/database/src', 'packages/providers/src', 'packages/brain/src', 'apps/web/src']) {
    for (const file of sourceFiles(root)) {
      const rel = file.slice(REPO.length + 1);
      const src = code(file);
      // The integration catalog NAMES the secrets for its configured/not-configured
      // display. IntegrationOsService.isSecretConfigured looks names up dynamically and
      // returns only a boolean. Neither can return a value.
      if (rel === 'packages/database/src/integration-catalog.ts') continue;
      if (/(ANTHROPIC_API_KEY|OPENAI_API_KEY)/.test(src) && rel !== ENV_FILE) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, []);
  const presence = code(join(REPO, 'packages/database/src/services/integration-os.service.ts'));
  assert.match(presence, /static isSecretConfigured\(envVar: string\): boolean/);
  assert.match(presence, /return typeof v === 'string' && v\.trim\(\)\.length > 0;/, 'presence, never the value');
});

test('the adapters, the factory and the runtime read no environment at all', () => {
  const files = [
    ...sourceFiles('packages/providers/src/ai'),
    ...sourceFiles('packages/shared/src/ai'),
    ...sourceFiles('packages/database/src/services/ai-runtime'),
    join(REPO, 'packages/database/src/services/ai-usage-ledger.service.ts'),
    join(REPO, 'packages/database/src/repositories/ai-usage-ledger.repository.ts'),
  ];
  assert.ok(files.length >= 10);
  for (const file of files) {
    assert.doesNotMatch(code(file), /process\.env|readEnv\(|import\.meta\.env/, `${file.slice(REPO.length + 1)} must be handed its configuration`);
  }
});

test('the environment boundary is server-only and the only reader of LOOP_AI_ settings', () => {
  const env = code(join(REPO, ENV_FILE));
  assert.match(env.trimStart(), /^import 'server-only';/);
  for (const root of ['packages/shared/src', 'packages/database/src', 'packages/providers/src', 'apps/web/src']) {
    for (const file of sourceFiles(root)) {
      const rel = file.slice(REPO.length + 1);
      if (rel === ENV_FILE) continue;
      assert.doesNotMatch(code(file), /LOOP_AI_(ENABLED|ORGANIZATIONS|TASKS|PROVIDERS|PROVIDER_TERMS_CONFIRMED|KILL_SWITCHES)/, rel);
    }
  }
});

test('the provider runtime Node version satisfies both SDKs, everywhere it is declared', () => {
  const nvmrc = readFileSync(join(REPO, '.nvmrc'), 'utf8').trim();
  const netlify = readFileSync(join(REPO, 'netlify.toml'), 'utf8').match(/NODE_VERSION\s*=\s*"(\d+)/)?.[1];
  const openai = JSON.parse(readFileSync(join(REPO, 'node_modules/openai/package.json'), 'utf8'));
  const required = Number(String(openai.engines?.node ?? '').match(/(\d+)/)?.[1]);
  assert.ok(Number.isFinite(required) && required >= 22, `openai requires Node ${openai.engines?.node}`);
  assert.ok(Number(nvmrc) >= required, `.nvmrc (${nvmrc}) satisfies openai (${openai.engines.node})`);
  assert.ok(Number(netlify) >= required, `netlify NODE_VERSION (${netlify}) satisfies openai`);
  const factory = readFileSync(join(REPO, SDK_FILE), 'utf8');
  assert.match(factory, new RegExp(`AI_MINIMUM_NODE_MAJOR = ${required};`), 'the runtime guard agrees');
  // The two CI jobs that execute provider code run on the same version.
  for (const workflow of ['verified-knowledge-ci.yml', 'poll-callgrid-interval.yml']) {
    const yml = readFileSync(join(REPO, '.github/workflows', workflow), 'utf8');
    assert.match(yml, /node-version-file:\s*['"]?\.nvmrc/, `${workflow} reads .nvmrc`);
  }
});
