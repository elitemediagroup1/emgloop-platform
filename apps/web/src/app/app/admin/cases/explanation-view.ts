// What the Case page shows of an explanation, and nothing more. Slice AI-5.
//
// A PLAIN MODULE, safe for the client leaf to import: types and one pure mapping, no
// server code. The mapping decides what crosses to the browser -- the validated answer,
// ids and versions, what was withheld (as counts), and the pseudonym key the operator
// can already see on this page. Never a prompt, never a provider's words, never a
// partial answer.

export type ExplanationAvailability = 'AVAILABLE' | 'NOT_AUTHORIZED' | 'NOT_ENABLED' | 'PAUSED' | 'NOT_CONFIGURED';

export interface ExplanationClaimView {
  readonly kind: 'OBSERVATION' | 'SIGNIFICANCE' | 'CONSIDERATION';
  readonly statement: string;
  readonly citations: readonly string[];
}

export type ExplanationView =
  | {
      readonly state: 'ANSWERED';
      readonly summary: string;
      readonly claims: readonly ExplanationClaimView[];
      readonly limitations: readonly string[];
      readonly model: string;
      readonly generatedAt: string;
      readonly versions: string;
      readonly withheld: readonly string[];
      readonly aliases: readonly { readonly alias: string; readonly name: string }[];
    }
  | { readonly state: 'NOT_SHOWN'; readonly reason: string; readonly detail: readonly string[] };

const WITHHELD_LABELS: Record<string, string> = {
  HUMAN_REPORTED_EVIDENCE: 'evidence people reported',
  EVIDENCE_CONTEXT_NOTES: 'notes on evidence',
  EVIDENCE_BEYOND_CAP: 'older evidence beyond the limit',
  AUTHORIZATION_NOTE: 'the authorization note',
  TIMELINE_NOTES_AND_REASONS: 'timeline notes',
  CASE_TITLE_AND_SUBJECT: 'the title and subject',
  HUMAN_AUTHORED_FINDING: 'a finding written by a person',
  RECOMMENDATIONS: 'recommendations',
  PARTICIPATION_AND_WORK: 'who is involved and their work',
  MONITORING_CONDITIONS_AND_NOTES: 'monitoring notes',
  USER_IDENTIFIERS: 'user identifiers',
  ENTITY_NAMES: 'names of companies and people (shown as labels)',
};

const REFUSAL_REASONS: Record<string, string> = {
  NOT_ACTIVATED: 'AI explanations are not enabled for this workspace.',
  ORGANIZATION_NOT_ENABLED: 'AI explanations are not enabled for this workspace.',
  TASK_NOT_ENABLED: 'AI explanations are not enabled for this workspace.',
  PROVIDER_NOT_ENABLED: 'No AI provider is enabled for this workspace.',
  PROVIDER_NOT_REGISTERED: 'No AI provider is configured.',
  KILL_SWITCH: 'AI explanations are paused.',
  BUDGET_TASK_EXHAUSTED: "Today's allowance for AI explanations is used up.",
  BUDGET_ORGANIZATION_EXHAUSTED: "Today's AI allowance for this workspace is used up.",
  BUDGET_GLOBAL_EXHAUSTED: 'The AI allowance is used up for now.',
  RESERVATION_CONTENDED: 'Too many requests at once. Try again shortly.',
  INPUT_LIMIT_ABOVE_POLICY: 'This investigation has more evidence than an explanation can take.',
  LEDGER_UNAVAILABLE: 'Usage could not be recorded, so nothing was sent.',
};

/** The subset of a service result the mapping reads. Structural, so this module imports no server code. */
export interface ExplanationResultLike {
  readonly outcome: string;
  readonly explanation?: { readonly summary: string; readonly claims: readonly ExplanationClaimView[]; readonly limitations: readonly string[] };
  readonly provenance?: { readonly servedModel: string | null; readonly requestedModel: { readonly modelId: string }; readonly recordedAt: string; readonly taskVersion: string; readonly templateVersion: string; readonly routingPolicyVersion: string };
  readonly refusals?: readonly string[];
  readonly rejections?: readonly string[];
  readonly failure?: string;
  readonly withheld?: Readonly<Record<string, number | undefined>>;
  readonly entityAliases?: Readonly<Record<string, { readonly entityName: string | null }>>;
}

export function explanationViewOf(result: ExplanationResultLike): ExplanationView {
  switch (result.outcome) {
    case 'ANSWERED': {
      const e = result.explanation!;
      const p = result.provenance!;
      return {
        state: 'ANSWERED',
        summary: e.summary,
        claims: e.claims.map((c) => ({ kind: c.kind, statement: c.statement, citations: [...c.citations] })),
        limitations: [...e.limitations],
        model: p.servedModel ?? p.requestedModel.modelId,
        generatedAt: p.recordedAt,
        versions: `task ${p.taskVersion} · template ${p.templateVersion} · ${p.routingPolicyVersion}`,
        withheld: Object.entries(result.withheld ?? {})
          .filter(([, n]) => (n ?? 0) > 0)
          .map(([k, n]) => `${n} ${WITHHELD_LABELS[k] ?? k}`),
        aliases: Object.entries(result.entityAliases ?? {})
          .filter(([, v]) => v.entityName)
          .map(([alias, v]) => ({ alias, name: v.entityName! })),
      };
    }
    case 'NOT_AUTHORIZED':
      return { state: 'NOT_SHOWN', reason: 'Explanations can be requested by owners and admins.', detail: [] };
    case 'NOT_FOUND':
      return { state: 'NOT_SHOWN', reason: 'This investigation could not be found.', detail: [] };
    case 'REFUSED_BY_LOOP': {
      const refusals = result.refusals ?? [];
      const reason = refusals.map((r) => REFUSAL_REASONS[r]).find(Boolean) ?? 'Loop did not send this request.';
      return { state: 'NOT_SHOWN', reason, detail: [...refusals] };
    }
    case 'REJECTED_OUTPUT':
      return {
        state: 'NOT_SHOWN',
        reason: "The model's answer broke Loop's evidence rules, so none of it is shown.",
        detail: [...(result.rejections ?? [])],
      };
    case 'REFUSED_BY_MODEL':
      return { state: 'NOT_SHOWN', reason: 'The model declined to explain this investigation.', detail: [] };
    default:
      return {
        state: 'NOT_SHOWN',
        reason: 'The explanation could not be produced. Nothing was shown.',
        detail: result.failure ? [result.failure] : [],
      };
  }
}
