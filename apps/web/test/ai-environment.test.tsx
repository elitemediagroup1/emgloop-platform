// The AI deployment environment boundary. Slice AI-2.
//
// WHAT THESE PROVE
//
// CONFIGURED IS NOT ON. A deployment holding both keys constructs no provider and
// admits nothing until LOOP_AI_ENABLED is exactly "true" -- and even then only the
// organizations, tasks and providers listed, with provider terms confirmed.
//
// NO CREDENTIAL LEAVES THE MODULE. The value goes to the factory and nowhere else.
// The returned structure, serialized every way a log or a prop would serialize it,
// does not contain it.
//
// THE BROWSER CANNOT REACH IT. The module declares `server-only`, and this file walks
// the import graph from every 'use client' file to prove no path leads to it -- or to
// the one file that imports a model SDK.
//
// NO VALUE HERE IS A CREDENTIAL. The placeholders are obviously fake, and the factory
// is stubbed, so no SDK client is built at all.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inspect } from 'node:util';

import {
  AI_ENVIRONMENT,
  parseAiKillSwitches,
  parseAiList,
  readAiEnvironment,
  type AiEnvironmentDeps,
} from '../src/ai/ai-environment';

const ANTHROPIC_PLACEHOLDER = 'placeholder-anthropic-not-a-key';
const OPENAI_PLACEHOLDER = 'placeholder-openai-not-a-key';

function stubs() {
  const seen: { providerId: string; apiKey: unknown }[] = [];
  const deps: AiEnvironmentDeps = {
    createAnthropicProvider: (o) => {
      seen.push({ providerId: 'anthropic', apiKey: o.apiKey });
      return o.apiKey ? { providerId: 'anthropic', state: 'CONFIGURED', provider: { providerId: 'anthropic' } as never } : { providerId: 'anthropic', state: 'PROVIDER_NOT_CONFIGURED' };
    },
    createOpenAiProvider: (o) => {
      seen.push({ providerId: 'openai', apiKey: o.apiKey });
      return o.apiKey ? { providerId: 'openai', state: 'CONFIGURED', provider: { providerId: 'openai' } as never } : { providerId: 'openai', state: 'PROVIDER_NOT_CONFIGURED' };
    },
  };
  return { seen, deps };
}

const KEYS = { ANTHROPIC_API_KEY: ANTHROPIC_PLACEHOLDER, OPENAI_API_KEY: OPENAI_PLACEHOLDER };
const FULLY_ON = {
  ...KEYS,
  LOOP_AI_ENABLED: 'true',
  LOOP_AI_ORGANIZATIONS: 'org_a',
  LOOP_AI_TASKS: 'case.explanation',
  LOOP_AI_PROVIDERS: 'anthropic,openai',
  LOOP_AI_PROVIDER_TERMS_CONFIRMED: 'anthropic,openai',
};

describe('configured is not on', () => {
  it('both keys present and nothing else: OFF, and no client is even built', () => {
    const { seen, deps } = stubs();
    const env = readAiEnvironment(KEYS, deps);
    assert.equal(env.activation.enabled, false);
    assert.deepEqual([...env.activation.organizations], []);
    assert.deepEqual(env.providers, []);
    assert.deepEqual(seen, [], 'a disabled runtime constructs nothing');
    assert.deepEqual(env.configuration.map((c) => [c.providerId, c.credential]), [['anthropic', 'PRESENT'], ['openai', 'PRESENT']]);
  });

  it('enabled means exactly "true"', () => {
    for (const value of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', '']) {
      const { seen, deps } = stubs();
      const env = readAiEnvironment({ ...FULLY_ON, LOOP_AI_ENABLED: value }, deps);
      assert.equal(env.activation.enabled, false, JSON.stringify(value));
      assert.equal(seen.length, 0);
    }
  });

  it('fully on: exactly the listed organization, task and providers', () => {
    const { seen, deps } = stubs();
    const env = readAiEnvironment(FULLY_ON, deps);
    assert.deepEqual(env.activation, { enabled: true, organizations: ['org_a'], tasks: ['case.explanation'], providers: ['anthropic', 'openai'] });
    assert.deepEqual(seen.map((s) => s.providerId), ['anthropic', 'openai']);
    assert.equal(seen[0]!.apiKey, ANTHROPIC_PLACEHOLDER, 'the credential goes to the factory');
  });

  it('a provider is enabled only when listed, terms-confirmed and actually configured', () => {
    const { deps } = stubs();
    const unlisted = readAiEnvironment({ ...FULLY_ON, LOOP_AI_PROVIDERS: 'anthropic' }, deps);
    assert.deepEqual([...unlisted.activation.providers], ['anthropic']);
    const unconfirmed = readAiEnvironment({ ...FULLY_ON, LOOP_AI_PROVIDER_TERMS_CONFIRMED: 'openai' }, deps);
    assert.deepEqual([...unconfirmed.activation.providers], ['openai'], 'G2: unconfirmed terms, not enabled');
    const noKey = readAiEnvironment({ ...FULLY_ON, ANTHROPIC_API_KEY: '' }, deps);
    assert.deepEqual([...noKey.activation.providers], ['openai']);
    assert.equal(noKey.providers.find((p) => p.providerId === 'anthropic')?.state, 'PROVIDER_NOT_CONFIGURED');
    const none = readAiEnvironment({ ...FULLY_ON, LOOP_AI_PROVIDERS: '' }, deps);
    assert.deepEqual([...none.activation.providers], []);
  });

  it('the activation it returns is frozen', () => {
    const env = readAiEnvironment(FULLY_ON, stubs().deps);
    assert.ok(Object.isFrozen(env.activation));
    assert.ok(Object.isFrozen(env.activation.organizations));
  });
});

describe('lists and kill switches', () => {
  it('an allowlist keeps plain tokens and drops everything else', () => {
    assert.deepEqual(parseAiList(' org_a, org_b ,,org_a'), ['org_a', 'org_b']);
    assert.deepEqual(parseAiList('org a,<script>,*,org_c'), ['org_c'], 'a wildcard is not an organization');
    assert.deepEqual(parseAiList(undefined), []);
  });

  it('kill switches parse by scope, and anything unreadable stops everything', () => {
    assert.deepEqual(parseAiKillSwitches(undefined), []);
    assert.deepEqual(parseAiKillSwitches('  '), []);
    assert.deepEqual(parseAiKillSwitches('GLOBAL'), [{ scope: 'GLOBAL' }]);
    assert.deepEqual(parseAiKillSwitches('provider:anthropic, MODEL:model-x, TASK:case.explanation, ORGANIZATION:org_a'), [
      { scope: 'PROVIDER', value: 'anthropic' },
      { scope: 'MODEL', value: 'model-x' },
      { scope: 'TASK', value: 'case.explanation' },
      { scope: 'ORGANIZATION', value: 'org_a' },
    ]);
    for (const garbage of ['PROVIDR:anthropic', 'PROVIDER:', 'PROVIDER', 'stop please', 'GLOBAL:x']) {
      assert.deepEqual(parseAiKillSwitches(garbage), [{ scope: 'GLOBAL' }], garbage);
    }
    const env = readAiEnvironment({ ...FULLY_ON, LOOP_AI_KILL_SWITCHES: 'TASK:case.explanation' }, stubs().deps);
    assert.deepEqual(env.killSwitches, [{ scope: 'TASK', value: 'case.explanation' }]);
  });
});

describe('no credential leaves the module', () => {
  it('no serialization of the environment carries a credential', () => {
    for (const source of [KEYS, FULLY_ON]) {
      const env = readAiEnvironment(source, stubs().deps);
      for (const rendered of [JSON.stringify(env), inspect(env, { depth: 20, showHidden: true }), String(env)]) {
        assert.doesNotMatch(rendered, /placeholder-(anthropic|openai)-not-a-key/, rendered.slice(0, 200));
      }
    }
  });

  it('a factory that throws is "not configured", and its error text goes nowhere', () => {
    const { deps } = stubs();
    const throwing: AiEnvironmentDeps = {
      ...deps,
      createAnthropicProvider: (o) => {
        throw new Error(`boom ${String(o.apiKey)}`);
      },
    };
    const env = readAiEnvironment(FULLY_ON, throwing);
    assert.equal(env.providers.find((p) => p.providerId === 'anthropic')?.state, 'PROVIDER_NOT_CONFIGURED');
    assert.deepEqual([...env.activation.providers], ['openai'], 'a provider that failed to build is not enabled');
    assert.doesNotMatch(JSON.stringify(env) + inspect(env, { depth: 20 }), /placeholder|boom/);
    // And the real factory never interpolates a credential into any string at all.
    const factory = readFileSync(join(__dirname, '..', '..', '..', 'packages/providers/src/ai/adapters/sdk-clients.ts'), 'utf8');
    assert.doesNotMatch(factory, /\$\{[^}]*apiKey[^}]*\}/);
  });
});

// --- The boundary -------------------------------------------------------------------------

const WEB = resolve(__dirname, '..');
const REPO = resolve(WEB, '..', '..');
const ENV_MODULE = join(WEB, 'src/ai/ai-environment.ts');
const SDK_MODULE = join(REPO, 'packages/providers/src/ai/adapters/sdk-clients.ts');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (['node_modules', '.next'].includes(f)) return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

function resolveImport(from: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else if (spec.startsWith('@/')) base = join(WEB, 'src', spec.slice(2));
  else if (spec.startsWith('@emgloop/')) {
    const [, pkg, ...rest] = spec.split('/');
    const dir = pkg === 'web' ? WEB : join(REPO, 'packages', pkg!);
    base = rest.length ? join(dir, ...rest) : join(dir, 'src', 'index');
  }
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const specs = [...src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((m) => m[1] ?? m[2] ?? m[3])
    .filter((s): s is string => Boolean(s));
  return specs.map((s) => resolveImport(file, s)).filter((f): f is string => Boolean(f));
}

describe('the browser cannot reach the environment or an SDK', () => {
  it('the module declares server-only, first', () => {
    const src = readFileSync(ENV_MODULE, 'utf8').replace(/^\s*\/\/.*$/gm, '').trimStart();
    assert.match(src, /^import 'server-only';/);
  });

  it('no client component reaches either module through any import chain', () => {
    const clients = walk(join(WEB, 'src')).filter((f) => /^\s*['"]use client['"]/.test(readFileSync(f, 'utf8')));
    assert.ok(clients.length >= 5, `found the client components (${clients.length})`);
    for (const entry of clients) {
      const seen = new Set<string>();
      const stack = [entry];
      while (stack.length) {
        const file = stack.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        assert.notEqual(file, ENV_MODULE, `${entry.slice(WEB.length)} reaches the AI environment`);
        assert.notEqual(file, SDK_MODULE, `${entry.slice(WEB.length)} reaches a model SDK`);
        // A 'use server' module imported by a client becomes a reference to an action,
        // not code in the bundle; the walk stops there, as Next's bundler does.
        if (file !== entry && /^\s*['"]use server['"]/.test(readFileSync(file, 'utf8'))) continue;
        stack.push(...importsOf(file));
      }
    }
  });

  it('the walker itself finds a path when one exists', () => {
    // Guard against a walker that silently resolves nothing.
    const reached = importsOf(ENV_MODULE);
    assert.ok(reached.includes(SDK_MODULE), 'the environment module imports the SDK factory');
    assert.ok(reached.some((f) => f.endsWith(join('packages', 'shared', 'src', 'index.ts'))));
  });

  it('no AI variable is ever NEXT_PUBLIC', () => {
    const offenders = walk(join(WEB, 'src'))
      .concat(walk(join(REPO, 'packages')).filter((f) => f.includes(`${join('packages')}`)))
      .filter((f) => /NEXT_PUBLIC_[A-Z_]*(AI|ANTHROPIC|OPENAI|LOOP_AI)/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, []);
    for (const name of Object.values(AI_ENVIRONMENT)) assert.doesNotMatch(name, /^NEXT_PUBLIC_/);
  });
});
