// The ONE module in Loop that reads the AI deployment environment. Slice AI-2.
//
// SERVER ONLY. The `server-only` import makes a build fail if any client component
// reaches this file, and a test walks the import graph from every 'use client' file
// to prove none does.
//
// IT READS TWO KINDS OF THING, AND KEEPS THEM APART.
//
//   Credentials -- ANTHROPIC_API_KEY, OPENAI_API_KEY. A credential's value goes
//   straight into the provider factory and nowhere else: not into a return value,
//   an error, a log line or a prop. Its PRESENCE means CONFIGURED, and nothing more.
//
//   Activation -- LOOP_AI_* variables. Whether the runtime may run, for which
//   organizations, tasks and providers, and what is killed. Every one is an
//   allowlist or an exact value, so an unset, misspelt or half-set deployment is OFF.
//
// A DEPLOYMENT HOLDING VALID KEYS MAKES NO CALL UNTIL ACTIVATED. With LOOP_AI_ENABLED
// anything but exactly "true", no provider client is even constructed.
//
// A PROVIDER IS ENABLED ONLY WHEN THREE THINGS AGREE: it is listed in
// LOOP_AI_PROVIDERS, its data terms are confirmed in LOOP_AI_PROVIDER_TERMS_CONFIRMED
// (activation gate G2), and its credential produced a usable client.
//
// KILL SWITCHES FAIL CLOSED. An entry nobody can parse stops everything.
//
// CHANGES TAKE EFFECT ON THE NEXT DEPLOY. Netlify applies environment changes to new
// deploys, so a kill switch here is minutes, not instant. An instant switch would need
// a stored flag -- a Product decision, recorded in the activation dossier.
//
// NOT NEXT_PUBLIC_, EVER. None of these names is exposed to the browser, and a fence
// fails the build of any AI variable that is.

import 'server-only';

import {
  AI_ACTIVATION_OFF,
  AI_KILL_SWITCH_SCOPES,
  type AiActivation,
  type AiControlFloor,
  type AiKillSwitch,
  type AiModelCapabilities,
} from '@emgloop/shared';
import {
  createAnthropicProvider,
  createOpenAiProvider,
  type AiProviderClient,
  type AiProviderClientOptions,
} from '@emgloop/providers/src/ai/adapters/sdk-clients';

/** Every variable this module reads, by name. The names are not secrets; the credential values are. */
export const AI_ENVIRONMENT = Object.freeze({
  anthropicKey: 'ANTHROPIC_API_KEY',
  openAiKey: 'OPENAI_API_KEY',
  enabled: 'LOOP_AI_ENABLED',
  organizations: 'LOOP_AI_ORGANIZATIONS',
  tasks: 'LOOP_AI_TASKS',
  providers: 'LOOP_AI_PROVIDERS',
  termsConfirmed: 'LOOP_AI_PROVIDER_TERMS_CONFIRMED',
  killSwitches: 'LOOP_AI_KILL_SWITCHES',
} as const);

export type AiEnvironmentSource = Readonly<Record<string, string | undefined>>;

/** What may be shown to an operator: which provider, and in what state. Never a value. */
export interface AiProviderConfiguration {
  readonly providerId: string;
  readonly credential: 'PRESENT' | 'ABSENT';
  readonly listed: boolean;
  readonly termsConfirmed: boolean;
}

export interface AiEnvironment {
  readonly activation: AiActivation;
  readonly killSwitches: readonly AiKillSwitch[];
  /** Constructed only when the runtime is enabled. Each is CONFIGURED or says why not. */
  readonly providers: readonly AiProviderClient[];
  readonly configuration: readonly AiProviderConfiguration[];
}

export interface AiEnvironmentDeps {
  readonly createAnthropicProvider?: (options: AiProviderClientOptions) => AiProviderClient;
  readonly createOpenAiProvider?: (options: AiProviderClientOptions) => AiProviderClient;
  readonly capabilities?: (providerId: string, modelId: string) => AiModelCapabilities;
}

const LIST_ITEM = /^[A-Za-z0-9_.:@-]{1,200}$/;

/** A comma-separated allowlist. Anything that is not a plain token is dropped, not guessed at. */
export function parseAiList(raw: string | undefined): string[] {
  if (typeof raw !== 'string') return [];
  return [...new Set(raw.split(',').map((item) => item.trim()).filter((item) => LIST_ITEM.test(item)))];
}

/**
 * `GLOBAL`, or `SCOPE:value` for PROVIDER, MODEL, TASK and ORGANIZATION. An entry that
 * cannot be read is a GLOBAL stop: an operator who typed a kill switch meant to stop
 * something, and "nothing" is the one wrong answer.
 */
export function parseAiKillSwitches(raw: string | undefined): AiKillSwitch[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const out: AiKillSwitch[] = [];
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    if (entry.toUpperCase() === 'GLOBAL') {
      out.push({ scope: 'GLOBAL' });
      continue;
    }
    const at = entry.indexOf(':');
    const scope = at > 0 ? entry.slice(0, at).toUpperCase() : '';
    const value = at > 0 ? entry.slice(at + 1).trim() : '';
    if (scope !== 'GLOBAL' && (AI_KILL_SWITCH_SCOPES as readonly string[]).includes(scope) && LIST_ITEM.test(value)) {
      out.push({ scope: scope as AiKillSwitch['scope'], value });
    } else {
      out.push({ scope: 'GLOBAL' });
    }
  }
  return out;
}

function present(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The AI deployment environment. `source` is process.env in production; tests pass a
 * record. The credential values are read here and handed to the factory directly.
 */
export function readAiEnvironment(source: AiEnvironmentSource = process.env, deps: AiEnvironmentDeps = {}): AiEnvironment {
  const listed = parseAiList(source[AI_ENVIRONMENT.providers]);
  const confirmed = parseAiList(source[AI_ENVIRONMENT.termsConfirmed]);
  const killSwitches = parseAiKillSwitches(source[AI_ENVIRONMENT.killSwitches]);

  const configuration: AiProviderConfiguration[] = [
    { providerId: 'anthropic', credential: present(source[AI_ENVIRONMENT.anthropicKey]) ? 'PRESENT' : 'ABSENT', listed: listed.includes('anthropic'), termsConfirmed: confirmed.includes('anthropic') },
    { providerId: 'openai', credential: present(source[AI_ENVIRONMENT.openAiKey]) ? 'PRESENT' : 'ABSENT', listed: listed.includes('openai'), termsConfirmed: confirmed.includes('openai') },
  ];

  // Exactly "true". Not "TRUE", not "1", not "yes": a switch that spends money is
  // turned on deliberately or not at all.
  if (source[AI_ENVIRONMENT.enabled] !== 'true') {
    return { activation: AI_ACTIVATION_OFF, killSwitches, providers: [], configuration };
  }

  // A factory that throws yields "not configured" and nothing else: its error text is
  // exactly where a credential could leak, so none of it is kept.
  const build = (providerId: string, factory: (o: AiProviderClientOptions) => AiProviderClient, options: AiProviderClientOptions): AiProviderClient => {
    try {
      return factory(options);
    } catch {
      return { providerId, state: 'PROVIDER_NOT_CONFIGURED' };
    }
  };
  const capabilitiesFor = (providerId: string) =>
    deps.capabilities ? (modelId: string) => deps.capabilities!(providerId, modelId) : undefined;
  const providers: AiProviderClient[] = [];
  // Only providers an operator listed AND confirmed terms for are even constructed.
  if (listed.includes('anthropic') && confirmed.includes('anthropic')) {
    providers.push(
      build('anthropic', deps.createAnthropicProvider ?? createAnthropicProvider, {
        apiKey: source[AI_ENVIRONMENT.anthropicKey],
        capabilities: capabilitiesFor('anthropic'),
      }),
    );
  }
  if (listed.includes('openai') && confirmed.includes('openai')) {
    providers.push(
      build('openai', deps.createOpenAiProvider ?? createOpenAiProvider, {
        apiKey: source[AI_ENVIRONMENT.openAiKey],
        capabilities: capabilitiesFor('openai'),
      }),
    );
  }

  const usable = providers.filter((p) => p.state === 'CONFIGURED').map((p) => p.providerId);
  const activation: AiActivation = Object.freeze({
    enabled: true,
    organizations: Object.freeze(parseAiList(source[AI_ENVIRONMENT.organizations])),
    tasks: Object.freeze(parseAiList(source[AI_ENVIRONMENT.tasks])),
    providers: Object.freeze(usable),
  });
  return { activation, killSwitches, providers, configuration };
}

/**
 * This deployment's FLOOR for Brain work (B5): whether it allows AI at all, for which
 * organizations, tasks and providers, and what it kills. It reads no credential and builds
 * no client -- Brain work executes elsewhere, with its own credentials, so this web tier
 * needs none to accept it. A provider counts when it is listed AND its data terms are
 * confirmed. The recorded controls in Neon are combined with this by
 * `aiEffectiveControls`; neither is ever copied into the other.
 */
export function readAiControlFloor(source: AiEnvironmentSource = process.env): AiControlFloor {
  const killSwitches = parseAiKillSwitches(source[AI_ENVIRONMENT.killSwitches]);
  if (source[AI_ENVIRONMENT.enabled] !== 'true') return { activation: AI_ACTIVATION_OFF, killSwitches };
  const confirmed = parseAiList(source[AI_ENVIRONMENT.termsConfirmed]);
  return {
    activation: Object.freeze({
      enabled: true,
      organizations: Object.freeze(parseAiList(source[AI_ENVIRONMENT.organizations])),
      tasks: Object.freeze(parseAiList(source[AI_ENVIRONMENT.tasks])),
      providers: Object.freeze(parseAiList(source[AI_ENVIRONMENT.providers]).filter((p) => confirmed.includes(p))),
    }),
    killSwitches,
  };
}

/** The deployment's AI environment, read from process.env. The runtime assembly calls this. */
export function aiEnvironment(deps: AiEnvironmentDeps = {}): AiEnvironment {
  return readAiEnvironment(process.env, deps);
}
