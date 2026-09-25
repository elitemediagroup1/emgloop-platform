// Loop Intelligence PR 2 (the fabric), 2026-09-26: the shared contracts.
//
//   - canonical entity references: grammar, closed kinds, principal-only kinds refused in org scope;
//   - the participation contract: typed signals, closed vocabularies, OBSERVED/MEASURED/INFERRED,
//     bounded, fail-closed on unknown fields, MEASURED only from a RULE producer with a metric;
//   - the domain and source registries: complete, consistent, private sources feed only private domains;
//   - domain-reading.v1: portable for both providers, registered, parsed and validated fail-closed;
//   - the generic projection: one digest -> statement, freshness, top signal, measured metric.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_OUTPUT_CONTRACTS,
  AI_PORTABLE_SCHEMA_EXEMPTIONS,
  AI_TASKS,
  DOMAIN_READING_SCHEMA,
  DOMAIN_READING_SCHEMA_ID,
  ENTITY_REF_KINDS,
  INTELLIGENCE_DIGEST_SCOPES,
  INTELLIGENCE_DOMAINS,
  INTELLIGENCE_DOMAIN_REGISTRY,
  INTELLIGENCE_EVIDENCE_FAMILIES,
  INTELLIGENCE_SIGNAL_KINDS,
  INTELLIGENCE_SOURCE_REGISTRY,
  PRINCIPAL_ONLY_ENTITY_REF_KINDS,
  PRIVATE_INTELLIGENCE_DOMAINS,
  SIGNALS_MAX_PER_DIGEST,
  aiOutputContract,
  aiPortableSchemaViolations,
  digestContentRefusals,
  entityRef,
  entityRefRefusal,
  intelligenceDomainAllowsScope,
  intelligenceReadingRefusals,
  intelligenceSignalRefusals,
  intelligenceSignalsRefusals,
  intelligenceSourceScopes,
  intelligenceSourceUseRefusals,
  intelligenceSynthesisEligibility,
  parseDomainReadingOutput,
  projectDomainDigest,
  rankDomainSignals,
  validateDomainReadingOutput,
  type AiSupportedEvidence,
  type AiTaskDefinition,
  type IntelligenceSignal,
} from '../src';

// --- EntityRef ----------------------------------------------------------------------------------

test('entity refs: every kind has a grammar; good refs pass and malformed ones are refused by reason', () => {
  const good = [
    'party:cm123abc',
    'relationship:rel_1',
    'customer:c-9',
    'creator:cr_1',
    'opportunity:op1',
    'campaign:camp_7',
    'case:case_1',
    'work_instance:wi_1',
    'work_item:it_1',
    'provider_member:callgrid:buyer:B-1234',
    'market:us',
    'market:us-fl',
    'market:us-fl-tampa-bay',
    'web_property:servicesinmycity',
    'page:servicesinmycity:/plumbing/tampa',
    'telegram_conversation:' + 'a'.repeat(32),
    'work_thread:th_1',
    'work_event:ev_1',
    'correspondent:' + 'f'.repeat(64),
    'user:u_1',
  ];
  for (const ref of good) assert.equal(entityRefRefusal(ref), null, ref);
  assert.equal(new Set(good.map((r) => r.split(':')[0])).size, ENTITY_REF_KINDS.length, 'every kind is exercised');

  assert.equal(entityRefRefusal(42), 'NOT_A_STRING');
  assert.equal(entityRefRefusal('party'), 'NO_KIND');
  assert.equal(entityRefRefusal(':x'), 'NO_KIND');
  assert.equal(entityRefRefusal('person:1'), 'UNKNOWN_KIND');
  assert.equal(entityRefRefusal('party:has space'), 'BAD_ID');
  assert.equal(entityRefRefusal('provider_member:callgrid:employee:1'), 'BAD_ID', 'dimension is closed');
  assert.equal(entityRefRefusal('market:USA'), 'BAD_ID');
  assert.equal(entityRefRefusal('page:site:no-leading-slash'), 'BAD_ID');
  assert.equal(entityRefRefusal('page:site:/a?q=1'), 'BAD_ID', 'no query string in a page ref');
  assert.equal(entityRefRefusal('correspondent:dana@example.com'), 'BAD_ID', 'an address is never a correspondent ref -- only its hash');
  assert.equal(entityRefRefusal('telegram_conversation:12345'), 'BAD_ID', 'a raw chat id is never a conversation ref -- only its key');
  assert.equal(entityRefRefusal('party:' + 'x'.repeat(300)), 'TOO_LONG');
  assert.throws(() => entityRef('party', 'bad id'));
  assert.equal(entityRef('party', 'p_1'), 'party:p_1');
});

test('entity refs: principal-only kinds are refused in ORGANIZATION scope, and nothing else is', () => {
  assert.deepEqual([...PRINCIPAL_ONLY_ENTITY_REF_KINDS].sort(), ['correspondent', 'telegram_conversation', 'work_event', 'work_thread']);
  assert.equal(entityRefRefusal('telegram_conversation:' + 'a'.repeat(32), 'ORGANIZATION'), 'PRINCIPAL_ONLY_KIND');
  assert.equal(entityRefRefusal('correspondent:' + 'f'.repeat(64), 'ORGANIZATION'), 'PRINCIPAL_ONLY_KIND');
  assert.equal(entityRefRefusal('work_thread:t1', 'ORGANIZATION'), 'PRINCIPAL_ONLY_KIND');
  assert.equal(entityRefRefusal('party:p1', 'ORGANIZATION'), null);
  assert.equal(entityRefRefusal('provider_member:callgrid:vendor:V1', 'ORGANIZATION'), null);
});

// --- Participation contract ---------------------------------------------------------------------

const signal = (patch: Partial<IntelligenceSignal> & Record<string, unknown> = {}): IntelligenceSignal =>
  ({ key: 'buyer-concern', kind: 'RISK', knowledge: 'INFERRED', statement: 'The buyer is questioning call quality.', evidenceRefs: ['work_thread:t1'], ...patch }) as IntelligenceSignal;

test('signals: a well-formed signal passes; unknown fields, bad vocabularies and missing evidence are refused', () => {
  const ctx = { scope: 'PRINCIPAL' as const, producerKind: 'MODEL' as const };
  assert.deepEqual(intelligenceSignalRefusals(signal(), ctx), []);
  assert.deepEqual(intelligenceSignalRefusals(signal({ entities: ['party:p1'], dueAt: '2026-09-30T17:00:00Z', severity: 'HIGH', confidence: 'MEDIUM' }), ctx), []);
  assert.ok(intelligenceSignalRefusals(signal({ extra: 1 } as never), ctx).includes('UNKNOWN_KEY'), 'fail closed on unknown fields');
  assert.ok(intelligenceSignalRefusals(signal({ kind: 'GOSSIP' as never }), ctx).includes('UNKNOWN_VALUE'));
  assert.ok(intelligenceSignalRefusals(signal({ knowledge: 'CERTAIN' as never }), ctx).includes('UNKNOWN_VALUE'));
  assert.ok(intelligenceSignalRefusals(signal({ evidenceRefs: [] }), ctx).includes('NO_EVIDENCE'), 'a signal with no evidence is not written');
  assert.ok(intelligenceSignalRefusals(signal({ evidenceRefs: ['has space'] }), ctx).includes('BAD_EVIDENCE_REF'));
  assert.ok(intelligenceSignalRefusals(signal({ statement: 'x'.repeat(281) }), ctx).includes('STRING_TOO_LONG'));
  assert.ok(intelligenceSignalRefusals(signal({ statement: '  ' }), ctx).includes('EMPTY_STRING'));
  assert.ok(intelligenceSignalRefusals(signal({ dueAt: '30 Sept' }), ctx).includes('BAD_INSTANT'));
  assert.ok(intelligenceSignalRefusals(signal({ entities: ['party:p1', 'party:p1'] }), ctx).includes('DUPLICATE_KEY'));
  assert.ok(intelligenceSignalRefusals(signal({ entities: Array.from({ length: 7 }, (_, i) => `party:p${i}`) }), ctx).includes('LIST_TOO_LONG'));
  assert.ok(intelligenceSignalRefusals(signal({ owedBy: 'VIEWER' }), ctx).includes('OWED_BY_NOT_OBLIGATION'), 'owedBy only on an obligation');
  assert.deepEqual(intelligenceSignalRefusals(signal({ kind: 'OBLIGATION', owedBy: 'COWORKER' }), ctx), []);
});

test('signals: MEASURED needs a RULE producer AND a metric; a model can never measure; a metric is never inferred', () => {
  const metric = { name: 'conversion_rate', value: 12.5, unit: 'percent' as const, baseline: 18 };
  const rule = { scope: 'ORGANIZATION' as const, producerKind: 'RULE' as const };
  assert.deepEqual(intelligenceSignalRefusals(signal({ knowledge: 'MEASURED', metric, entities: ['campaign:c1'] }), rule), []);
  assert.ok(intelligenceSignalRefusals(signal({ knowledge: 'MEASURED' }), rule).includes('MEASURED_WITHOUT_METRIC'));
  assert.ok(intelligenceSignalRefusals(signal({ knowledge: 'MEASURED', metric }), { scope: 'ORGANIZATION', producerKind: 'MODEL' }).includes('MEASURED_BY_MODEL'));
  assert.ok(intelligenceSignalRefusals(signal({ knowledge: 'MEASURED', metric }), { scope: 'ORGANIZATION', producerKind: null }).includes('MEASURED_BY_MODEL'), 'an unstated producer is not trusted to measure');
  assert.ok(intelligenceSignalRefusals(signal({ knowledge: 'INFERRED', metric }), rule).includes('METRIC_NOT_MEASURED'));
  assert.ok(intelligenceSignalRefusals(signal({ knowledge: 'MEASURED', metric: { ...metric, unit: 'minor_currency', value: 12.5 } }), rule).includes('BAD_METRIC'), 'money is integer minor units');
  assert.ok(intelligenceSignalRefusals(signal({ knowledge: 'MEASURED', metric: { ...metric, value: Number.NaN } }), rule).includes('BAD_METRIC'));
});

test('signals: organization scope refuses a principal-only entity; the list is bounded and keys unique', () => {
  const org = { scope: 'ORGANIZATION' as const, producerKind: 'RULE' as const };
  assert.ok(intelligenceSignalRefusals(signal({ entities: ['telegram_conversation:' + 'a'.repeat(32)] }), org).includes('PRIVATE_ENTITY_REF'));
  const many = Array.from({ length: SIGNALS_MAX_PER_DIGEST + 1 }, (_, i) => signal({ key: `k${i}` }));
  assert.ok(intelligenceSignalsRefusals(many, org).includes('LIST_TOO_LONG'));
  assert.ok(intelligenceSignalsRefusals([signal(), signal()], org).includes('DUPLICATE_KEY'));
  assert.deepEqual(intelligenceSignalsRefusals([], org), []);
  assert.deepEqual(intelligenceSignalsRefusals('nope', org), ['NOT_A_LIST']);
});

test('the reading is closed and bounded', () => {
  assert.deepEqual(intelligenceReadingRefusals({ statement: 'Two buyers are cooling.', status: 'WATCH', confidence: 'MEDIUM' }), []);
  assert.ok(intelligenceReadingRefusals({ statement: 'x', status: 'PANIC', confidence: 'MEDIUM' }).includes('UNKNOWN_VALUE'));
  assert.ok(intelligenceReadingRefusals({ statement: 'x', status: 'CALM' }).includes('MISSING_FIELD'));
  assert.ok(intelligenceReadingRefusals({ statement: 'x', status: 'CALM', confidence: 'LOW', score: 0.9 }).includes('UNKNOWN_KEY'));
});

test('digest content carries the typed reading and signals, validated in the digest\'s scope', () => {
  const content = { reading: { statement: 'Quiet week.', status: 'CALM', confidence: 'HIGH' }, signals: [signal()] };
  assert.deepEqual(digestContentRefusals(content), []);
  assert.deepEqual(digestContentRefusals({ ...content, signals: [signal({ knowledge: 'MEASURED' })] }), ['INVALID_SIGNALS']);
  assert.deepEqual(digestContentRefusals({ ...content, reading: { statement: 'x' } }), ['INVALID_READING']);
  assert.deepEqual(
    digestContentRefusals({ signals: [signal({ entities: ['work_thread:t1'] })] }, { scope: 'ORGANIZATION', producerKind: 'RULE' }),
    ['INVALID_SIGNALS'],
    'an org digest cannot point at a private thread',
  );
  // Every field within its own bound, and still too large in bytes (four-byte characters): refused whole.
  const wide = '\u{1F600}'.repeat(280);
  assert.ok(
    digestContentRefusals({ synthesis: wide, topics: Array.from({ length: 8 }, () => wide), limitations: Array.from({ length: 8 }, () => wide), signals: Array.from({ length: 12 }, (_, i) => signal({ key: `k${i}`, statement: wide })) }).includes('CONTENT_TOO_LARGE'),
  );
});

test('provenance sources: an organization reading may name organization sources only', () => {
  const at = '2026-09-26T08:00:00Z';
  assert.deepEqual(intelligenceSourceUseRefusals([{ sourceId: 'CALLGRID', asOf: at, coverage: 'CONNECTED_SUFFICIENT' }], 'ORGANIZATION', intelligenceSourceScopes), []);
  for (const privateSource of ['TELEGRAM', 'GMAIL', 'GOOGLE_CALENDAR']) {
    assert.deepEqual(intelligenceSourceUseRefusals([{ sourceId: privateSource, asOf: at, coverage: 'CONNECTED_SUFFICIENT' }], 'ORGANIZATION', intelligenceSourceScopes), ['PRIVATE_SOURCE'], privateSource);
  }
  assert.deepEqual(intelligenceSourceUseRefusals([{ sourceId: 'NOT_A_SOURCE', asOf: at, coverage: 'CONNECTED_SUFFICIENT' }], 'ORGANIZATION', intelligenceSourceScopes), ['UNKNOWN_VALUE']);
  assert.deepEqual(intelligenceSourceUseRefusals([{ sourceId: 'CALLGRID', asOf: 'yesterday', coverage: 'CONNECTED_SUFFICIENT' }], 'ORGANIZATION', intelligenceSourceScopes), ['BAD_INSTANT']);
  assert.equal(intelligenceSynthesisEligibility('PRINCIPAL'), 'OWNER_ONLY');
  assert.equal(intelligenceSynthesisEligibility('ORGANIZATION'), 'ORGANIZATION');
});

// --- Registries ---------------------------------------------------------------------------------

test('the domain registry is complete: exactly one entry per domain, each with a scope, surface, Home decision and evidence family', () => {
  assert.deepEqual(INTELLIGENCE_DOMAIN_REGISTRY.map((d) => d.domain).sort(), [...INTELLIGENCE_DOMAINS].sort());
  assert.deepEqual([...INTELLIGENCE_DOMAINS].sort(), ['CALENDAR', 'CALLGRID', 'CAMPAIGNS', 'CHATS', 'CREATORS', 'CRM', 'MAIL', 'PIPELINE', 'WEBSITE', 'WORK'].sort());
  const tiles = new Set<string>();
  for (const d of INTELLIGENCE_DOMAIN_REGISTRY) {
    assert.ok(d.scopes.length > 0 && d.scopes.every((s) => (INTELLIGENCE_DIGEST_SCOPES as readonly string[]).includes(s)), d.domain);
    assert.ok(d.surfaces.length > 0 && d.surfaces.every((p) => p.startsWith('/')), `${d.domain} lives on a real route`);
    assert.ok(d.evidenceFamilies.length > 0 && d.evidenceFamilies.every((f) => (INTELLIGENCE_EVIDENCE_FAMILIES as readonly string[]).includes(f)));
    if (d.home.tile === null) assert.ok('reason' in d.home && d.home.reason.length > 20, `${d.domain} says why it has no Home tile`);
    else {
      assert.equal(tiles.has(d.home.tile), false, 'one domain per Home tile');
      tiles.add(d.home.tile);
    }
    assert.ok(d.readAuthority.permission !== null || d.readAuthority.workspace !== null, `${d.domain} names the authority its surface enforces`);
  }
  // Terminology reconciled: each legacy name maps to exactly one domain.
  const aka = INTELLIGENCE_DOMAIN_REGISTRY.flatMap((d) => d.aka.map((a) => a.toLowerCase()));
  assert.equal(new Set(aka).size, aka.length, 'no legacy name maps to two domains');
});

test('private domains are PRINCIPAL-only, forever; organization domains never admit a private source', () => {
  assert.deepEqual([...PRIVATE_INTELLIGENCE_DOMAINS], ['CHATS', 'MAIL', 'CALENDAR']);
  for (const d of PRIVATE_INTELLIGENCE_DOMAINS) {
    assert.equal(intelligenceDomainAllowsScope(d, 'ORGANIZATION'), false, d);
    assert.equal(intelligenceDomainAllowsScope(d, 'PRINCIPAL'), true, d);
  }
  for (const d of ['CALLGRID', 'CAMPAIGNS', 'PIPELINE', 'CRM', 'CREATORS', 'WEBSITE']) assert.deepEqual(INTELLIGENCE_DOMAIN_REGISTRY.find((e) => e.domain === d)!.scopes, ['ORGANIZATION'], d);
  assert.deepEqual(INTELLIGENCE_DOMAIN_REGISTRY.find((e) => e.domain === 'WORK')!.scopes, ['PRINCIPAL', 'ORGANIZATION']);
  assert.equal(intelligenceDomainAllowsScope('NOPE', 'PRINCIPAL'), false, 'an unknown domain admits nothing');
});

test('the source registry: every source feeds registered domains in a scope those domains admit, and no model reads a source', () => {
  const ids = INTELLIGENCE_SOURCE_REGISTRY.map((s) => s.sourceId);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of INTELLIGENCE_SOURCE_REGISTRY) {
    assert.match(s.sourceId, /^[A-Z][A-Z0-9_]{0,63}$/);
    assert.equal(s.access, 'LOOP_GOVERNED_COPY', `${s.sourceId}: models get Loop's governed context, never the source`);
    for (const domain of s.domains) {
      const entry = INTELLIGENCE_DOMAIN_REGISTRY.find((d) => d.domain === domain);
      assert.ok(entry, `${s.sourceId} feeds a registered domain`);
      assert.ok(s.scopes.some((scope) => entry!.scopes.includes(scope)), `${s.sourceId} -> ${domain} share a scope`);
      assert.ok(entry!.evidenceFamilies.includes(s.evidenceFamily) || s.evidenceFamily === 'WEB_ACTIVITY', `${s.sourceId} evidence family belongs to ${domain}`);
    }
    // A person's private source feeds private domains only, and an organization source rests on Loop records.
    if (s.scopes.includes('PRINCIPAL') && !s.scopes.includes('ORGANIZATION')) {
      assert.ok(s.domains.every((d) => PRIVATE_INTELLIGENCE_DOMAINS.includes(d)), `${s.sourceId} is private and feeds only private domains`);
    }
    if (s.scopes.includes('ORGANIZATION')) assert.equal(s.basis, 'LOOP_RECORDS', `${s.sourceId} organization evidence is Loop's own records`);
  }
  // Every domain has at least one source.
  for (const d of INTELLIGENCE_DOMAINS) assert.ok(INTELLIGENCE_SOURCE_REGISTRY.some((s) => s.domains.includes(d)), `${d} has a source`);
  // No vendor product appears in a domain id (provider-neutral domain code).
  for (const d of INTELLIGENCE_DOMAIN_REGISTRY) assert.doesNotMatch(d.domain, /TELEGRAM|GMAIL|GOOGLE|ANTHROPIC|OPENAI/);
});

test('reading tasks: only Chats has one today, and it is the existing triage task (no new production task in PR 2)', () => {
  const withTask = INTELLIGENCE_DOMAIN_REGISTRY.filter((d) => d.readingTask !== null);
  assert.deepEqual(withTask.map((d) => [d.domain, d.readingTask]), [['CHATS', 'telegram.content.triage']]);
  assert.ok(AI_TASKS.some((t) => t.taskId === 'telegram.content.triage'));
});

// --- domain-reading.v1 ----------------------------------------------------------------------------

test('domain-reading.v1 is portable for both providers with NO exemption, and registered with its own contract', () => {
  assert.deepEqual(aiPortableSchemaViolations(DOMAIN_READING_SCHEMA), []);
  assert.equal(Object.prototype.hasOwnProperty.call(AI_PORTABLE_SCHEMA_EXEMPTIONS, DOMAIN_READING_SCHEMA_ID), false);
  assert.ok(aiOutputContract(DOMAIN_READING_SCHEMA_ID));
  assert.equal(AI_OUTPUT_CONTRACTS[DOMAIN_READING_SCHEMA_ID]!.schemaId, DOMAIN_READING_SCHEMA_ID);
  const kinds = (DOMAIN_READING_SCHEMA.properties.signals.items.properties.kind as { enum: string[] }).enum;
  assert.deepEqual(kinds, [...INTELLIGENCE_SIGNAL_KINDS]);
  const knowledge = (DOMAIN_READING_SCHEMA.properties.signals.items.properties.knowledge as { enum: string[] }).enum;
  assert.deepEqual(knowledge, ['OBSERVED', 'INFERRED'], 'a model is never offered MEASURED');
});

const TASK = { taskId: 'test.domain.reading', outputSchemaId: DOMAIN_READING_SCHEMA_ID, consequence: 'READ_ONLY', resultType: 'ANALYSIS' } as unknown as AiTaskDefinition;
const EVIDENCE: AiSupportedEvidence = {
  figures: new Map([['callgrid:campaign:c1', new Set([12, 18])]]),
  dates: new Set(['2026-09-25']),
  entityRefs: new Set(['campaign:c1']),
};
const SUPPLIED = new Set(['callgrid:campaign:c1', 'callgrid:buyer:b1']);
const answer = (patch: Record<string, unknown> = {}, signalPatch: Record<string, unknown> = {}) => ({
  schemaId: DOMAIN_READING_SCHEMA_ID,
  reading: { statement: 'Campaign conversion is slipping.', status: 'WATCH', confidence: 'MEDIUM' },
  signals: [
    {
      key: 'conversion-slip',
      kind: 'RISK',
      knowledge: 'INFERRED',
      statement: 'Conversion fell from 18 to 12 percent.',
      entities: ['campaign:c1'],
      evidenceRefs: ['callgrid:campaign:c1'],
      occurredAt: '2026-09-25T00:00:00Z',
      dueAt: null,
      confidence: 'MEDIUM',
      severity: 'HIGH',
      owedBy: null,
      ...signalPatch,
    },
  ],
  limitations: [],
  ...patch,
});
const check = (value: unknown) => {
  const parsed = parseDomainReadingOutput(value);
  assert.ok(parsed, 'parses');
  return validateDomainReadingOutput(parsed!, TASK, SUPPLIED, EVIDENCE);
};

test('domain-reading.v1: a grounded answer is accepted and parsed into the typed contract (nulls become absent)', () => {
  assert.deepEqual(check(answer()), []);
  const parsed = parseDomainReadingOutput(answer())!;
  assert.equal(parsed.summary, 'Campaign conversion is slipping.');
  assert.equal('dueAt' in parsed.domainReading!.signals[0]!, false);
  assert.equal(parsed.domainReading!.signals[0]!.occurredAt, '2026-09-25T00:00:00Z');
  assert.equal(parseDomainReadingOutput({ ...answer(), schemaId: 'telegram-content-triage.v4' }), null);
  assert.equal(parseDomainReadingOutput({ ...answer(), signals: 'x' }), null);
});

test('domain-reading.v1: every rule the schema cannot say is enforced after the answer, whole-answer rejection', () => {
  assert.ok(check(answer({}, { evidenceRefs: ['callgrid:invented'] })).includes('CITATION_NOT_SUPPLIED'), 'invented citation');
  assert.ok(check(answer({}, { entities: ['party:invented'] })).includes('ENTITY_NOT_SUPPLIED'), 'invented identity');
  assert.ok(check(answer({}, { statement: 'Conversion fell to 7 percent.' })).includes('UNSUPPORTED_NUMBER_IN_TEXT'), 'fabricated metric');
  assert.ok(check(answer({}, { evidenceRefs: ['callgrid:buyer:b1'] })).includes('UNSUPPORTED_NUMBER_IN_TEXT'), 'a number must be in a source THAT signal cites');
  assert.ok(check(answer({}, { dueAt: '2026-10-01T00:00:00Z' })).includes('UNSUPPORTED_DATE_IN_TEXT'), 'invented date');
  assert.ok(check(answer({}, { knowledge: 'MEASURED' })).includes('WRONG_SCHEMA'), 'a model can never MEASURE');
  assert.ok(check(answer({}, { owedBy: 'VIEWER' })).includes('WRONG_SCHEMA'), 'owedBy only on an obligation');
  assert.ok(check(answer({}, { statement: 'They said "we are leaving".' })).includes('VERBATIM_CONTENT'), 'no quotes');
  assert.ok(check(answer({ reading: { statement: 'You should call the buyer.', status: 'ATTENTION', confidence: 'HIGH' } })).includes('RECOMMENDS_AN_ACTION'), 'the reading never instructs');
  assert.ok(check(answer({ reading: { statement: 'I am 90% confident conversion is down.', status: 'WATCH', confidence: 'HIGH' } })).includes('NUMERIC_CONFIDENCE_PRESENT'));
  assert.ok(check(answer({}, { key: 'Bad Key' })).includes('WRONG_SCHEMA'));
  assert.ok(check(answer({}, { evidenceRefs: [] })).includes('UNCITED_CLAIM'));
  // An obligation statement describing what somebody holds is not an instruction to the reader.
  assert.deepEqual(check(answer({}, { kind: 'OBLIGATION', owedBy: 'VIEWER', statement: 'You said you would call the buyer back about campaign pricing.', occurredAt: null })), []);
  const verbatim: AiSupportedEvidence = { ...EVIDENCE, verbatimRuns: new Set(['conversion fell from 18 to 12 percent']) };
  const rejected = validateDomainReadingOutput(parseDomainReadingOutput(answer())!, TASK, SUPPLIED, verbatim);
  assert.ok(rejected.length === 0 || rejected.includes('VERBATIM_CONTENT'));
});

// --- The generic projection ----------------------------------------------------------------------

test('the projection: one digest becomes statement, freshness, top signal and a MEASURED metric from a RULE producer only', () => {
  const now = new Date('2026-09-26T12:00:00Z');
  const digest = {
    scope: 'ORGANIZATION' as const,
    content: {
      reading: { statement: 'Two campaigns are slipping.', status: 'WATCH' as const, confidence: 'MEDIUM' as const },
      signals: [
        signal({ key: 'quiet', kind: 'QUIET', severity: 'LOW', entities: ['campaign:c2'] }),
        signal({ key: 'slip', kind: 'RISK', knowledge: 'MEASURED', severity: 'HIGH', metric: { name: 'conversion_rate', value: 12, unit: 'percent', baseline: 18 }, entities: ['campaign:c1'] }),
      ],
    },
    coverage: 'CONNECTED_SUFFICIENT',
    status: 'CURRENT',
    windowEnd: new Date('2026-09-26T00:00:00Z'),
    expiresAt: new Date('2026-10-20T00:00:00Z'),
    generatedAt: new Date('2026-09-26T06:00:00Z'),
    version: 4,
    provenance: { producerKind: 'RULE' },
  };
  const p = projectDomainDigest(digest, { connectionLive: true, sourceLastEvidenceAt: null, now });
  assert.equal(p.state, 'CURRENT');
  assert.equal(p.statement, 'Two campaigns are slipping.');
  assert.equal(p.status, 'WATCH');
  assert.equal(p.topSignal?.key, 'slip', 'severity leads');
  assert.deepEqual(p.metric, { name: 'conversion_rate', value: 12, unit: 'percent', baseline: 18, signalKey: 'slip' });
  assert.equal(p.version, 4);
  // Newer evidence than the window: not current, and must be disclosed.
  const stale = projectDomainDigest(digest, { connectionLive: true, sourceLastEvidenceAt: new Date('2026-09-26T09:00:00Z'), now });
  assert.equal(stale.state, 'NOT_CURRENT');
  assert.equal(stale.coverage, 'STALE');
  assert.equal(stale.asCurrent, false);
  // Disconnected, and absent: honest states, never an empty reading.
  assert.equal(projectDomainDigest(digest, { connectionLive: false, sourceLastEvidenceAt: null, now }).coverage, 'DISCONNECTED');
  assert.equal(projectDomainDigest(null, { connectionLive: true, sourceLastEvidenceAt: null, now }).state, 'NONE');
  // A digest whose content no longer validates is an ERROR, never a reading.
  const broken = projectDomainDigest({ ...digest, provenance: { producerKind: 'MODEL' } }, { connectionLive: true, sourceLastEvidenceAt: null, now });
  assert.equal(broken.coverage, 'ERROR');
  assert.equal(broken.statement, null);
  // PR A digests (no typed reading) project their synthesis.
  const prA = projectDomainDigest({ ...digest, scope: 'PRINCIPAL', content: { synthesis: 'A renewal waiting on you.' }, provenance: {} }, { connectionLive: true, sourceLastEvidenceAt: null, now });
  assert.equal(prA.statement, 'A renewal waiting on you.');
  assert.equal(prA.topSignal, null);
  assert.equal(prA.metric, null);
});

test('signal ranking: severity first, then the fixed precedence, then key', () => {
  const ranked = rankDomainSignals([
    signal({ key: 'b', kind: 'CHANGE', severity: 'HIGH' }),
    signal({ key: 'a', kind: 'ATTENTION', severity: 'MEDIUM' }),
    signal({ key: 'c', kind: 'OBLIGATION', severity: 'HIGH' }),
  ]);
  assert.deepEqual(ranked.map((s) => s.key), ['c', 'b', 'a']);
});
