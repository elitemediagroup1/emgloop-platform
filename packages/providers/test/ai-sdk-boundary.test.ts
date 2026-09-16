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

test('nothing imports either SDK yet, anywhere', () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const root of ['packages/shared/src', 'packages/database/src', 'packages/providers/src', 'packages/brain/src', 'apps/web/src']) {
    for (const file of sourceFiles(root)) {
      scanned += 1;
      const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/from ['"](@anthropic-ai|openai)/.test(src) || /require\(['"](@anthropic-ai|openai)/.test(src)) {
        offenders.push(file.slice(REPO.length));
      }
    }
  }
  // When S1 adds the adapters this assertion changes to "only under
  // packages/providers/src/ai/adapters/" -- deliberately, in that PR, not silently.
  assert.deepEqual(offenders, [], 'an installed SDK is not an activated provider');
  assert.ok(scanned > 200, `the scan covered the repository (${scanned} files)`);
});

test('no AI credential is read anywhere in the source', () => {
  const offenders: string[] = [];
  for (const root of ['packages/shared/src', 'packages/database/src', 'packages/providers/src', 'apps/web/src']) {
    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // The integration catalog names secrets for its configured/not-configured
      // display and reads no value; everything else must not mention them at all.
      if (file.endsWith('integration-catalog.ts')) continue;
      if (/(ANTHROPIC_API_KEY|OPENAI_API_KEY)/.test(src)) offenders.push(file.slice(REPO.length));
    }
  }
  assert.deepEqual(offenders, []);
});
