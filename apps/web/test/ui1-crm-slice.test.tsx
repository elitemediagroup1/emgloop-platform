// UI-1: the redesigned CRM slice (People, Person, Relationship), the Subject Display
// System, the record primitives and the Brain work states (Charlie and Lexi's
// handoff, 2026-09-16).
//
// What these prove:
//   - Only governed authority reaches the screen: People are established PERSON
//     Parties; no role or kind label is invented; no contact detail, opportunity,
//     campaign or Party activity is fabricated.
//   - Unknown, none-found, unavailable, refused and failed stay distinct.
//   - Pages guard themselves before any read and render no client code.
//   - Brain states are provider-neutral and never present finished work as truth.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BRAIN_WORK_DISPLAY_STATES,
  type CrmRelationshipCapabilitiesV1,
  type CrmRelationshipListItemV1,
  type CrmRelationshipRecordV1,
  type PartyListItemV1,
  type PartyRecordV1,
} from '@emgloop/shared';
import { BRAIN_WORK_PHASES } from '@emgloop/database';

import {
  businessDate,
  governedTerm,
  intakeSubject,
  partyListSubject,
  partyRecordSubject,
  partyRelationshipContext,
  partyStateDisplay,
  relationshipSubject,
  subjectInitials,
  unresolvedActivitySubject,
  workspaceSubject,
  type SubjectDisplay,
} from '../src/crm/subject-display';
import {
  readPeopleDirectory,
  readPersonView,
  readRelationshipDirectory,
  readRelationshipView,
  type CrmSubjectReadDeps,
} from '../src/crm/crm-subject-reads';
import { relationshipEventCategory, relationshipHistoryEntries } from '../src/crm/relationship-history';
import { SubjectCard } from '../src/app/app/_loop-os/subject-card';
import { ActionButton, ContextTabs, StateBlock, SummaryStrip } from '../src/app/app/_loop-os/record';
import { BrainWorkState } from '../src/app/app/_loop-os/brain-state';
import { ActivityItem } from '../src/app/app/_loop-os/activity-item';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const render = (el: unknown) => renderToStaticMarkup(el as never);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, ' ').trim();

// ---- fixtures -------------------------------------------------------------------------------

const ORG_NAME = 'EMG';
const at = '2026-09-10T15:00:00.000Z';
const establishment = { established: true, basis: 'MANUAL' as const, establishedAt: at, establishedBy: { userId: 'u_1', displayName: 'Charlie' } };

function listItem(partyId: string, displayName: string | null, partyType: 'PERSON' | 'COMPANY' = 'PERSON'): PartyListItemV1 {
  return { contractVersion: 'party-read-model.v1', partyId, partyType, displayName, establishment, createdAt: at };
}

function partyRecord(partyId: string, over: Partial<PartyRecordV1> = {}): PartyRecordV1 {
  return {
    contractVersion: 'party-read-model.v1',
    partyId,
    partyType: 'PERSON',
    displayName: 'Denise K',
    reference: { state: 'ESTABLISHED', canonicalPartyId: null },
    archived: false,
    establishment,
    posture: { establishment: 'ESTABLISHED', basis: 'MANUAL', sameParty: 'UNRESOLVED', evidenceTier: 'NOT_AVAILABLE', limitations: ['EVIDENCE_NOT_COLLECTED'] },
    linkedIntakeRecords: [],
    createdAt: at,
    ...over,
  };
}

const established = (partyId: string, partyType: 'PERSON' | 'COMPANY' = 'PERSON') => ({ state: 'ESTABLISHED' as const, partyId, partyType, archived: false });

function talent(relationshipId: string, partyId: string, state: 'ACTIVE' | 'ENDED' | 'VOIDED' = 'ACTIVE'): CrmRelationshipListItemV1 {
  return {
    relationshipId,
    kind: 'TALENT_REPRESENTATION',
    kindLabel: 'Talent representation',
    structure: 'OWN',
    state,
    sides: [{ side: 'COUNTERPARTY', label: 'is represented by the workspace', party: established(partyId), role: 'CREATOR' }],
    label: null,
    ownerUserId: null,
    businessStartDate: '2026-01-15',
    businessEndDate: null,
    createdAt: at,
    activeParticipantCount: 1,
  };
}

function affiliation(relationshipId: string, personId: string, companyId: string): CrmRelationshipListItemV1 {
  return {
    ...talent(relationshipId, personId),
    kind: 'AFFILIATION',
    kindLabel: 'Affiliation',
    structure: 'THIRD_PARTY',
    sides: [
      { side: 'A', label: 'is affiliated with', party: established(personId), role: 'EMPLOYEE' },
      { side: 'B', label: 'has affiliate', party: established(companyId, 'COMPANY'), role: 'BRAND' },
    ],
    activeParticipantCount: 2,
  };
}

const CAPS: CrmRelationshipCapabilitiesV1 = {
  create: true, updateDetails: true, addParticipant: true, changeParticipant: true, endRelationship: true,
  reactivateRelationship: true, endParticipant: true, voidRelationship: false, voidParticipant: false,
};
const PARTY_CAPS = { createParty: true, establishParty: true };
const page = <T,>(items: T[], nextCursor: string | null = null) => ({ contractVersion: 'crm-relationship-read-model.v1' as const, items, nextCursor });

function deps(over: Partial<CrmSubjectReadDeps> = {}): CrmSubjectReadDeps {
  const records: Record<string, PartyRecordV1> = {
    p_denise: partyRecord('p_denise'),
    p_kai: partyRecord('p_kai', { displayName: 'Kai Kona' }),
    c_kona: partyRecord('c_kona', { partyType: 'COMPANY', displayName: 'Kona, Kai & Kaleo' }),
  };
  return {
    listPeople: async () => ({ outcome: 'OK', value: { items: [listItem('p_denise', 'Denise K'), listItem('p_kai', 'Kai Kona'), listItem('c_kona', 'Kona', 'COMPANY')], nextCursor: null }, capabilities: PARTY_CAPS }),
    establishmentQueue: async () => ({ outcome: 'OK', value: { items: [listItem('p_new', null)], nextCursor: null }, capabilities: PARTY_CAPS }),
    partyRecord: async (id) => (records[id] ? { outcome: 'OK', value: records[id]!, capabilities: PARTY_CAPS } : { outcome: 'NOT_FOUND' }),
    relationships: async () => ({ outcome: 'OK', value: page([talent('r_1', 'p_denise'), affiliation('r_2', 'p_kai', 'c_kona')]), capabilities: CAPS }),
    relationshipsForParty: async (id) => ({
      outcome: 'OK',
      value: page(id === 'p_denise' ? [talent('r_1', 'p_denise')] : [affiliation('r_2', 'p_kai', 'c_kona')]),
      capabilities: CAPS,
    }),
    relationship: async () => ({ outcome: 'NOT_FOUND' }),
    workspaceName: async () => ORG_NAME,
    ...over,
  };
}

// ---- the model -------------------------------------------------------------------------------

describe('Subject Display System: the model', () => {
  it('shows governed values as themselves and never substitutes a synonym', () => {
    assert.equal(governedTerm('PRIMARY_CONTACT'), 'Primary contact');
    assert.equal(governedTerm('CREATOR'), 'Creator');
    const src = code(read('crm/subject-display.ts'));
    for (const invented of ['Managed creator', 'Managed Creator', 'Commercial lead', 'Talent lead', 'Client Contact', 'Buyer contact']) {
      assert.equal(src.includes(invented), false, invented);
    }
  });

  it('draws initials from a recorded name and a neutral mark otherwise; never an image', () => {
    assert.equal(subjectInitials('Denise K', 'PERSON'), 'DK');
    assert.equal(subjectInitials('Dr. Shannalee Stevens', 'PERSON'), 'DS');
    assert.equal(subjectInitials('Cher', 'PERSON'), 'C');
    assert.equal(subjectInitials(null, 'PERSON'), '·');
    assert.equal(subjectInitials('EMG ↔ Denise K', 'RELATIONSHIP'), '↔', 'a connection has no initials');
    assert.equal(subjectInitials('Inbound call', 'UNRESOLVED_ACTIVITY'), '?', 'unresolved activity has no identity');
    assert.equal(subjectInitials('EMG Local', 'WORKSPACE'), 'EL');
  });

  it('uses the handoff words for the Person states', () => {
    assert.deepEqual(partyStateDisplay('ESTABLISHED'), { label: 'Established', tone: 'good' });
    assert.deepEqual(partyStateDisplay('NOT_ESTABLISHED'), { label: 'Identity review required', tone: 'attention' });
    assert.equal(partyStateDisplay('SUPERSEDED').label, 'Superseded');
    assert.equal(partyStateDisplay('ARCHIVED').label, 'Archived');
  });

  it('keeps unavailable, none-found and known relationship context apart', () => {
    const unavailable = partyRelationshipContext('p_denise', null, new Map(), ORG_NAME);
    assert.deepEqual(unavailable.fact, { text: 'Relationship context unavailable', knowledge: 'unavailable' });
    assert.equal(unavailable.activeCount, null, 'unknown, not zero');
    const none = partyRelationshipContext('p_denise', [], new Map(), ORG_NAME);
    assert.deepEqual(none.fact, { text: 'No relationship recorded', knowledge: 'none-found' });
    assert.equal(none.activeCount, 0);
    const ended = partyRelationshipContext('p_denise', [talent('r_1', 'p_denise', 'ENDED')], new Map(), ORG_NAME);
    assert.equal(ended.fact.text, 'No active relationship');
    const own = partyRelationshipContext('p_denise', [talent('r_1', 'p_denise')], new Map(), ORG_NAME);
    assert.deepEqual([own.role, own.relationship, own.fact.text], ['Creator', 'EMG · Talent representation', '1 active relationship']);
  });

  it('a Party that is only a participant is described as one, never as a side', () => {
    const names = new Map([['p_denise', 'Denise K']]);
    const ctx = partyRelationshipContext('p_avery', [talent('r_1', 'p_denise')], names, ORG_NAME);
    assert.deepEqual([ctx.role, ctx.relationship], [null, 'Participant in EMG ↔ Denise K · Talent representation']);
    const row = partyListSubject(listItem('p_avery', 'Avery Stone'), ctx, '/x');
    assert.equal([row.context, row.affiliation].filter(Boolean).join(' · '), 'Participant in EMG ↔ Denise K · Talent representation');
    assert.equal(businessDate('2026-01-15'), 'Jan 15, 2026');
    assert.equal(businessDate('not-a-date'), 'not-a-date');
  });

  it('names an affiliation only from a governed Affiliation, and the type is never the role', () => {
    const names = new Map([['c_kona', 'Kona, Kai & Kaleo']]);
    const ctx = partyRelationshipContext('p_kai', [affiliation('r_2', 'p_kai', 'c_kona')], names, ORG_NAME);
    assert.equal(ctx.affiliation, 'Kona, Kai & Kaleo');
    const subject = partyListSubject(listItem('p_kai', 'Kai Kona'), ctx, '/app/crm/people/p_kai');
    assert.equal(subject.typeLabel, 'Person');
    assert.equal(subject.context, 'Employee');
    assert.equal(partyRelationshipContext('p_kai', [affiliation('r_2', 'p_kai', 'c_kona')], new Map(), ORG_NAME).affiliation, null, 'no name, no affiliation text');
  });

  it('a Relationship is one subject: its sides are named inside it, with honest placeholders', () => {
    const named = relationshipSubject(talent('r_1', 'p_denise'), new Map([['p_denise', 'Denise K']]), ORG_NAME, '/app/crm/relationships/r_1');
    assert.equal(named.name, 'EMG ↔ Denise K');
    assert.equal(named.typeLabel, 'Relationship');
    assert.equal(named.context, 'Talent representation · Since 2026');
    const hidden = relationshipSubject(talent('r_1', 'p_denise'), new Map(), ORG_NAME, null);
    assert.equal(hidden.name, 'EMG ↔ A person');
    assert.equal(hidden.named, false);
    const labelled = relationshipSubject({ ...talent('r_1', 'p_denise'), label: 'Fall roster' }, new Map([['p_denise', 'Denise K']]), ORG_NAME, null);
    assert.deepEqual([labelled.name, labelled.affiliation], ['Fall roster', 'EMG ↔ Denise K']);
  });

  it('covers all six subject kinds, and neither intake nor unresolved activity becomes a Person', () => {
    const intake = intakeSubject({ id: 'c_1', name: 'Caller 555', source: 'Website', status: 'NEW' }, null);
    assert.deepEqual([intake.kind, intake.typeLabel, intake.fact?.text], ['INTAKE', 'Intake record', 'Not an established person']);
    const unresolved = unresolvedActivitySubject({ id: 'a_1', summary: 'Inbound call', source: 'CallGrid', identifierAvailable: true });
    assert.deepEqual([unresolved.kind, unresolved.state.label], ['UNRESOLVED_ACTIVITY', 'Identity unresolved']);
    const ws = workspaceSubject({ id: 'o_1', name: ORG_NAME }, null);
    assert.deepEqual([ws.kind, ws.typeLabel], ['WORKSPACE', 'Workspace']);
    const company = partyRecordSubject(partyRecord('c_kona', { partyType: 'COMPANY', displayName: null }), partyRelationshipContext('c_kona', [], new Map(), null));
    assert.deepEqual([company.kind, company.name, company.named], ['COMPANY', 'Unnamed company', false]);
  });
});

// ---- the read models --------------------------------------------------------------------------

const href = (id: string) => `/app/crm/people/${id}`;

describe('People directory', () => {
  it('lists established people only, with relationship context and the identity-review count', async () => {
    const dir = await readPeopleDirectory(deps(), { cursor: null, personHref: href });
    assert.equal(dir.outcome, 'OK');
    if (dir.outcome !== 'OK') return;
    assert.deepEqual(dir.rows.map((r) => r.subject.name), ['Denise K', 'Kai Kona'], 'a Company is never a person');
    assert.equal(dir.rows[0]!.context.relationship, 'EMG · Talent representation');
    assert.equal(dir.rows[1]!.context.affiliation, 'Kona, Kai & Kaleo');
    assert.deepEqual(dir.review, { state: 'OK', value: { count: 1, more: false } });
    assert.equal(dir.partialContext, false);
    assert.equal(dir.rows[0]!.subject.action?.href, '/app/crm/people/p_denise');
    // The table has a relationship column, so the line under the name carries role and affiliation only.
    assert.deepEqual([dir.rows[0]!.subject.context, dir.rows[0]!.subject.affiliation], ['Creator', null]);
    assert.deepEqual([dir.rows[1]!.subject.context, dir.rows[1]!.subject.affiliation], ['Employee', 'Kona, Kai & Kaleo']);
  });

  it('refused, failed and stale reads are three different outcomes', async () => {
    assert.deepEqual(await readPeopleDirectory(deps({ listPeople: async () => ({ outcome: 'NOT_AUTHORIZED' }) }), { personHref: href }), { outcome: 'NOT_AUTHORIZED' });
    assert.deepEqual(await readPeopleDirectory(deps({ listPeople: async () => { throw new Error('connect ECONNREFUSED'); } }), { personHref: href }), { outcome: 'FAILED' });
    assert.deepEqual(await readPeopleDirectory(deps({ listPeople: async () => ({ outcome: 'INVALID_CURSOR' }) }), { cursor: 'x', personHref: href }), { outcome: 'INVALID_CURSOR' });
  });

  it('a relationship read that fails or is refused marks that row unavailable and the page partial', async () => {
    const dir = await readPeopleDirectory(
      deps({
        relationshipsForParty: async (id) => {
          if (id === 'p_denise') throw new Error('timeout');
          return { outcome: 'NOT_AUTHORIZED' };
        },
      }),
      { personHref: href },
    );
    assert.equal(dir.outcome, 'OK');
    if (dir.outcome !== 'OK') return;
    assert.equal(dir.partialContext, true);
    for (const row of dir.rows) assert.equal(row.context.fact.knowledge, 'unavailable');
  });

  it('an empty workspace is empty, not an error, and the review count still shows', async () => {
    const dir = await readPeopleDirectory(deps({ listPeople: async () => ({ outcome: 'OK', value: { items: [], nextCursor: null }, capabilities: PARTY_CAPS }) }), { personHref: href });
    assert.equal(dir.outcome, 'OK');
    if (dir.outcome === 'OK') {
      assert.deepEqual(dir.rows, []);
      assert.equal(dir.firstPage, true);
      assert.equal(dir.review.state, 'OK');
    }
    const refusedQueue = await readPeopleDirectory(deps({ establishmentQueue: async () => ({ outcome: 'NOT_AUTHORIZED' }) }), { personHref: href });
    assert.equal(refusedQueue.outcome === 'OK' && refusedQueue.review.state, 'NOT_AUTHORIZED');
  });
});

describe('Person view', () => {
  const rel = { relationship: (id: string) => `/app/crm/relationships/${id}` };

  it('refused and missing both read as not found; a Company is not a Person', async () => {
    assert.deepEqual(await readPersonView(deps({ partyRecord: async () => ({ outcome: 'NOT_AUTHORIZED' }) }), 'p_denise', rel), { outcome: 'NOT_FOUND' });
    assert.deepEqual(await readPersonView(deps(), 'p_missing', rel), { outcome: 'NOT_FOUND' });
    assert.deepEqual(await readPersonView(deps(), 'c_kona', rel), { outcome: 'NOT_FOUND' });
    assert.deepEqual(await readPersonView(deps({ partyRecord: async () => { throw new Error('x'); } }), 'p_denise', rel), { outcome: 'FAILED' });
  });

  it('composes identity with relationship context, and a superseded person points to the current one', async () => {
    const view = await readPersonView(deps(), 'p_denise', rel);
    assert.equal(view.outcome, 'OK');
    if (view.outcome !== 'OK') return;
    assert.equal(view.subject.state.label, 'Established');
    assert.equal(view.relationships.state, 'OK');
    if (view.relationships.state === 'OK') assert.equal(view.relationships.value[0]!.name, 'EMG ↔ Denise K');
    assert.equal(view.current, null);

    const superseded = await readPersonView(
      deps({
        partyRecord: async (id) =>
          id === 'p_old'
            ? { outcome: 'OK', value: partyRecord('p_old', { reference: { state: 'SUPERSEDED', canonicalPartyId: 'p_denise' } }), capabilities: PARTY_CAPS }
            : { outcome: 'OK', value: partyRecord(id), capabilities: PARTY_CAPS },
      }),
      'p_old',
      rel,
    );
    assert.equal(superseded.outcome === 'OK' && superseded.subject.state.label, 'Superseded');
    assert.deepEqual(superseded.outcome === 'OK' && superseded.current, { partyId: 'p_denise', name: 'Denise K' });
  });

  it('relationships the viewer may not read are reported as such, never as none', async () => {
    const view = await readPersonView(deps({ relationshipsForParty: async () => ({ outcome: 'NOT_AUTHORIZED' }) }), 'p_denise', rel);
    assert.equal(view.outcome === 'OK' && view.relationships.state, 'NOT_AUTHORIZED');
    assert.equal(view.outcome === 'OK' && view.context.activeCount, null);
  });
});

describe('Relationships', () => {
  it('lists relationships as their own subjects, with names only when the viewer may read them', async () => {
    const dir = await readRelationshipDirectory(deps(), { includeVoided: false, href: (id) => `/r/${id}` });
    assert.equal(dir.outcome, 'OK');
    if (dir.outcome !== 'OK') return;
    assert.deepEqual(dir.subjects.map((s) => s.name), ['EMG ↔ Denise K', 'Kai Kona ↔ Kona, Kai & Kaleo']);
    assert.equal(dir.namesReadable, true);
    const hidden = await readRelationshipDirectory(deps({ partyRecord: async () => ({ outcome: 'NOT_AUTHORIZED' }) }), { includeVoided: false, href: (id) => `/r/${id}` });
    assert.equal(hidden.outcome === 'OK' && hidden.namesReadable, false);
    assert.deepEqual(hidden.outcome === 'OK' && hidden.subjects.map((s) => s.name), ['EMG ↔ A person', 'A person ↔ A company']);
  });

  it('a record reads its history newest first, as changes and audit, without reason text', async () => {
    const record: CrmRelationshipRecordV1 = {
      ...talent('r_1', 'p_denise'),
      description: null,
      participants: [
        { participantId: 'pt_1', party: established('p_denise'), role: 'CREATOR', roleFamily: 'CAPACITY', side: 'COUNTERPARTY', actsForSide: null, state: 'ACTIVE', effectiveFrom: null, effectiveTo: null, reasonRecorded: false },
        { participantId: 'pt_2', party: established('p_kai'), role: 'PRIMARY_CONTACT', roleFamily: 'ENGAGEMENT', side: null, actsForSide: 'COUNTERPARTY', state: 'ENDED', effectiveFrom: null, effectiveTo: at, reasonRecorded: true },
      ],
      history: [
        { sequence: 1, type: 'RELATIONSHIP_CREATED', occurredAt: at, occurredAtBasis: 'LOOP_CLOCK', recordedAt: at, actorUserId: 'u_1', participantId: null, fromState: null, toState: 'ACTIVE', reasonRecorded: false },
        { sequence: 2, type: 'PARTICIPANT_ENDED', occurredAt: at, occurredAtBasis: 'OPERATOR_STATED', recordedAt: at, actorUserId: 'u_1', participantId: 'pt_2', fromState: 'ACTIVE', toState: 'ENDED', reasonRecorded: true },
      ],
      duplicates: [],
    };
    const view = await readRelationshipView(deps({ relationship: async () => ({ outcome: 'OK', value: record, capabilities: CAPS }) }), 'r_1');
    assert.equal(view.outcome, 'OK');
    if (view.outcome !== 'OK') return;
    const entries = relationshipHistoryEntries(record, view.names, { dateTime: (v) => `T(${v})`, iso: (v) => v });
    assert.deepEqual(entries.map((e) => [e.category, e.story]), [
      ['AUDIT', 'Participant ended: Kai Kona (Primary contact)'],
      ['STATE_CHANGE', 'Relationship created'],
    ]);
    const reason = entries[0]!.evidence.find((r) => r.label === 'Reason');
    assert.equal(reason?.value, 'Recorded (kept with the relationship)');
    assert.equal(relationshipEventCategory('RELATIONSHIP_VOIDED'), 'STATE_CHANGE');
    assert.equal(relationshipEventCategory('RELATIONSHIP_OWNER_CHANGED'), 'AUDIT');
    assert.deepEqual(await readRelationshipView(deps({ relationship: async () => ({ outcome: 'NOT_AUTHORIZED' }) }), 'r_1'), { outcome: 'NOT_FOUND' });
  });
});

// ---- the primitives ----------------------------------------------------------------------------

const denise: SubjectDisplay = partyListSubject(
  listItem('p_denise', 'Denise K'),
  partyRelationshipContext('p_denise', [talent('r_1', 'p_denise')], new Map(), ORG_NAME),
  '/app/crm/people/p_denise',
);

describe('Subject Display System: drawn', () => {
  it('draws every density from the same subject, with initials and never an image', () => {
    for (const density of ['row', 'card', 'context', 'featured'] as const) {
      const html = render(<SubjectCard subject={denise} density={density} />);
      assert.match(html, new RegExp(`loop-subject--${density}`));
      assert.match(html, />DK</);
      assert.equal(html.includes('<img'), false, density);
      assert.match(text(html), /Denise K/);
    }
    const row = render(<SubjectCard subject={denise} density="row" />);
    assert.match(row, /<a class="loop-subject loop-subject--row" aria-label="Open Denise K" data-subject-kind="PERSON" href="\/app\/crm\/people\/p_denise">/);
    const card = render(<SubjectCard subject={denise} density="card" />);
    assert.match(text(card), /Person Established Creator · EMG · Talent representation 1 active relationship Open Denise K →/);
    const featured = render(<SubjectCard subject={denise} density="featured" headingLevel="h1" />);
    assert.match(featured, /<h1 class="loop-subject__name">Denise K<\/h1>/);
    assert.equal(featured.includes('<a '), false, 'the featured block is the page, not a link');
  });

  it('marks placeholders and unavailable facts so they never read as data', () => {
    const unnamed = partyListSubject(listItem('p_x', null), partyRelationshipContext('p_x', null, new Map(), null), '/x');
    const html = render(<SubjectCard subject={unnamed} density="card" />);
    assert.match(html, /class="loop-subject__name is-placeholder">Unnamed person</);
    assert.match(html, /loop-subject__fact--unavailable">Relationship context unavailable</);
  });

  it('states, tabs, actions and summaries never pretend', () => {
    const kinds = ['empty', 'unavailable', 'error', 'denied', 'attention'] as const;
    const blocks = kinds.map((kind) => render(<StateBlock kind={kind} title="t" body="b" />));
    assert.equal(new Set(blocks).size, kinds.length);
    assert.match(blocks[2]!, /role="alert"/);
    assert.equal(blocks[0]!.includes('role="alert"'), false);

    const tabs = render(<ContextTabs label="x" tabs={[{ label: 'Overview', href: '/o', current: true }, { label: 'Activity', href: null, reason: 'Not connected' }]} />);
    assert.match(tabs, /<a class="loop-tab" aria-current="page" href="\/o">Overview<\/a>/);
    assert.match(tabs, /<span class="loop-tab loop-tab--unavailable" aria-disabled="true" title="Not connected">Activity/);
    assert.equal((tabs.match(/href=/g) ?? []).length, 1);

    const inert = render(<ActionButton action={{ label: 'Email', href: null, reason: 'No governed channel.' }} />);
    assert.match(inert, /aria-disabled="true"/);
    assert.equal(inert.includes('href'), false);
    assert.equal(/mailto:|tel:|sms:/.test(inert), false);

    const strip = render(<SummaryStrip label="s" items={[{ label: 'Opportunities', value: null, unknownText: 'Not tracked yet' }, { label: 'Relationships', value: '0 active' }]} />);
    assert.match(text(strip), /Opportunities Not tracked yet Relationships 0 active/);
  });

  it('an activity item names its kind of truth and keeps interpretation apart from fact', () => {
    const entry = (category: 'FINDING' | 'STATE_CHANGE') => ({ key: category, category, story: 'x', when: 'w', whenIso: at, evidence: [] });
    assert.match(text(render(<ActivityItem entry={entry('FINDING')} />)), /Finding x w Kind of truth Interpretation, not a recorded fact/);
    assert.match(text(render(<ActivityItem entry={entry('STATE_CHANGE')} />)), /Change x w Kind of truth Recorded by its authority/);
  });
});

describe('Brain work states', () => {
  it('every display state renders its dictionary words, provider-neutral, with the authority boundary', () => {
    for (const state of BRAIN_WORK_DISPLAY_STATES) {
      const html = render(<BrainWorkState state={state} title="Brain on this relationship" />);
      assert.match(html, new RegExp(`data-brain-state="${state}"`));
      assert.match(text(html), /It does not establish facts or make decisions/);
      assert.equal(/anthropic|openai|claude|gpt|\bmodel\b/i.test(text(html)), false, state);
    }
    assert.match(render(<BrainWorkState state="WORKING" title="t" completedSteps={2} />), /aria-live="polite"/);
    assert.match(text(render(<BrainWorkState state="WORKING" title="t" completedSteps={2} />)), /2 steps finished/);
    assert.match(text(render(<BrainWorkState state="FAILED" title="t" endReason="PROVIDER_UNAVAILABLE" />)), /The reasoning service was unavailable/);
    assert.equal(/Verified|Accepted|Confirmed/.test(text(render(<BrainWorkState state="COMPLETED" title="t" />))), false);
  });

  it('every phase the Brain API reports has a display state', () => {
    for (const phase of BRAIN_WORK_PHASES) assert.ok((BRAIN_WORK_DISPLAY_STATES as readonly string[]).includes(phase), phase);
  });
});

// ---- the pages -------------------------------------------------------------------------------

const PAGES = {
  people: 'app/app/crm/people/page.tsx',
  person: 'app/app/crm/people/[partyId]/page.tsx',
  relationships: 'app/app/crm/relationships/page.tsx',
  relationship: 'app/app/crm/relationships/[relationshipId]/page.tsx',
} as const;

describe('The redesigned pages', () => {
  it('guard themselves before any read, with the permission their nav item states', () => {
    const expected: Record<keyof typeof PAGES, string> = {
      people: "requirePermission('identityResolution', 'view')",
      person: "requirePermission('identityResolution', 'view')",
      relationships: "requirePermission('relationships', 'view')",
      relationship: "requirePermission('relationships', 'view')",
    };
    for (const [name, file] of Object.entries(PAGES) as [keyof typeof PAGES, string][]) {
      const src = code(read(file));
      const guard = src.indexOf(`await ${expected[name]}`);
      assert.ok(guard > 0, `${name} guards itself`);
      assert.ok(guard < src.indexOf('crmSubjectReads('), `${name}: guard before the read`);
      assert.equal(src.includes("'use client'"), false, name);
    }
    assert.match(code(read('app/app/crm/layout.tsx')), /await requireWorkspaceSession\(\)/);
  });

  it('refused and foreign records are not found; failures say so; nothing says the database is not configured', () => {
    for (const file of [PAGES.person, PAGES.relationship]) {
      const src = code(read(file));
      assert.match(src, /if \(view\.outcome === 'NOT_FOUND'\) notFound\(\);/);
      assert.match(src, /<ReadFailed what=/);
    }
    for (const file of Object.values(PAGES)) {
      const src = code(read(file));
      assert.equal(/DataUnavailable|DbNotConfigured|not configured/i.test(src), false, file);
    }
  });

  it('fabricate nothing: no intake rows as people, no contact values, no opportunity numbers, no provider names', () => {
    for (const file of Object.values(PAGES)) {
      const src = code(read(file));
      assert.equal(/loadCustomers|customers\.list|crmRepos/.test(src), false, `${file} reads no intake records as people`);
      assert.equal(/mailto:|tel:|sms:|\.email\b|\.phone\b/.test(src), false, `${file} shows no contact value`);
      assert.equal(/anthropic|openai|claude|gpt-/i.test(src), false, file);
      assert.equal(/Managed [Cc]reator|Commercial lead|Talent lead/.test(src), false, file);
    }
    const person = code(read(PAGES.person));
    for (const channel of ['Email', 'Call', 'Message']) assert.match(person, new RegExp(`channel\\('${channel}'\\)`));
    assert.match(person, /const channel = \(label: string\): ActionSpec => \(\{ label, href: null, reason: NO_CHANNEL \}\);/);
    assert.match(person, /label: 'Opportunities', value: null/);
    assert.match(code(read(PAGES.people)), /Opportunities are not tracked in Loop yet/);
  });

  it('each list route has a loading state; no new CSS file was added', () => {
    assert.ok(existsSync(join(SRC, 'app/app/crm/people/loading.tsx')));
    assert.ok(existsSync(join(SRC, 'app/app/crm/relationships/loading.tsx')));
    const css = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? css(join(dir, e.name)) : e.name.endsWith('.css') ? [e.name] : []));
    assert.deepEqual(css(join(SRC, 'app/app')), []);
  });

  it('the new primitives stay server components', () => {
    for (const file of ['record.tsx', 'subject-card.tsx', 'activity-item.tsx', 'brain-state.tsx']) {
      assert.equal(read(`app/app/_loop-os/${file}`).includes("'use client'"), false, file);
    }
  });
});

// ---- one design system ------------------------------------------------------------------------

describe('The Loop design system is the only visual language', () => {
  const APP_DIR = join(SRC, 'app');
  const cssFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : [],
    );
  const shell = read('app/loop-os.css');
  const rootBlock = shell.slice(shell.indexOf(':root {'), shell.indexOf('}', shell.indexOf(':root {')) + 1);
  const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  const tokenValue = (name: string): string => {
    const m = rootBlock.match(new RegExp(`--loop-${name}:\\s*([^;]+);`));
    assert.ok(m, `--loop-${name}`);
    const v = m![1]!.trim();
    const alias = v.match(/^var\(--loop-([a-z0-9-]+)\)$/);
    return alias ? tokenValue(alias[1]!) : v;
  };

  it('declares its palette once, on :root in loop-os.css; every other colour token is an alias', () => {
    assert.ok(rootBlock.length > 100, 'the :root foundation exists');
    for (const file of cssFiles(APP_DIR)) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const scoped = file.endsWith('loop-os.css') ? css.replace(rootBlock.replace(/\/\*[\s\S]*?\*\//g, ''), '') : css;
      for (const m of scoped.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
        const [, name, value] = m;
        if (file.endsWith('globals.css')) continue; // the standalone public screens' aliases (asserted below)
        assert.equal(COLOR.test(value!), false, `${file.split('/src/')[1]} declares ${name} as a colour of its own`);
      }
    }
    const ds = read('app/crm/design-system.css');
    const crmTokens = [...ds.matchAll(/(--crm-[a-z0-9-]+)\s*:\s*([^;]+);/g)];
    assert.ok(crmTokens.length >= 20);
    for (const [, name, value] of crmTokens) {
      if (/radius-sm|ease|dur/.test(name!)) continue;
      assert.match(value!.trim(), /^var\(--loop-[a-z0-9-]+\)$/, `${name} aliases the Loop palette`);
    }
    // The public screens use the same values as the Loop palette.
    const g = read('app/globals.css');
    for (const [alias, loop] of [['--bg', 'canvas'], ['--panel', 'surface'], ['--text', 'ink'], ['--muted', 'muted'], ['--accent', 'accent'], ['--border', 'line']] as const) {
      const m = g.match(new RegExp(`${alias}:\\s*(#[0-9a-fA-F]{6})`));
      assert.equal(m?.[1]?.toLowerCase(), tokenValue(loop).toLowerCase(), alias);
    }
  });

  it('keeps no CRM-local or redesign-local layer: no .lx, no --lx-*', () => {
    for (const file of cssFiles(APP_DIR)) assert.equal(/\.lx\b|--lx-/.test(readFileSync(file, 'utf8')), false, file);
    const walkTsx = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walkTsx(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
      );
    for (const file of walkTsx(SRC)) assert.equal(/\blx-|className="lx"|LxPage/.test(readFileSync(file, 'utf8')), false, file);
  });

  it('text tokens meet WCAG AA on every surface token, and the rail text on the rail', () => {
    for (const fg of ['ink', 'body', 'muted', 'faint', 'accent', 'good', 'warn', 'crit', 'neutral']) {
      for (const bg of ['canvas', 'surface', 'sunken', 'hover']) {
        assert.ok(ratio(tokenValue(fg), tokenValue(bg)) >= 4.5, `${fg} on ${bg}: ${ratio(tokenValue(fg), tokenValue(bg)).toFixed(2)}`);
      }
    }
    for (const [fg, bg] of [['good', 'good-soft'], ['warn', 'warn-soft'], ['crit', 'crit-soft'], ['neutral', 'neutral-soft'], ['accent', 'accent-soft'], ['avatar-ink', 'avatar']] as const) {
      assert.ok(ratio(tokenValue(fg), tokenValue(bg)) >= 4.5, `${fg} on ${bg}`);
    }
    assert.ok(ratio('#ffffff', tokenValue('primary')) >= 4.5, 'text on the primary action');
    for (const fg of ['rail-text', 'rail-muted', 'rail-active']) {
      for (const bg of ['rail', 'rail-2']) assert.ok(ratio(tokenValue(fg), tokenValue(bg)) >= 4.5, `${fg} on ${bg}`);
    }
  });

  it('no stylesheet paints a dark surface outside the navigation rail', () => {
    for (const file of cssFiles(APP_DIR)) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/background(?:-color)?\s*:\s*([^;}]+)/g)) {
        for (const hex of m[1]!.match(/#[0-9a-fA-F]{6}\b/g) ?? []) {
          assert.ok(lum(hex) >= 0.2, `${file.split('/src/')[1]} paints ${hex} as a background`);
        }
      }
    }
  });

  it('the shell is a navy rail, light top bar and light canvas on desktop, and a light header on phones', () => {
    assert.match(shell, /\.loop-sidebar \{[^}]*background: var\(--loop-rail\);/);
    assert.match(shell, /\.loop-main \{[^}]*background: var\(--loop-canvas\);/);
    assert.match(shell, /\.loop-appbar \{[^}]*border-bottom: 1px solid var\(--loop-line\);/);
    // Desktop: the navy rail (Matt, 2026-09-17). Phone: the light responsive header.
    const shellTsx = read('workspaces/WorkspaceShell.tsx');
    assert.match(shellTsx, /<span className="loop-sb__mark loop-sb__mark--rail">\s*<EmgLoopWordmark height=\{22\} tone="onDark" \/>/);
    assert.match(shellTsx, /<span className="loop-sb__mark loop-sb__mark--light">\s*<EmgLoopWordmark height=\{22\} \/>/);
    const phone = shell.slice(shell.indexOf('/* ---- Shell: desktop and phone ----'));
    assert.match(phone, /@media \(max-width: 820px\) \{\n  \.loop-shell \{ grid-template-columns: 1fr; \}\n  \.loop-sidebar \{[^}]*background: var\(--loop-surface\);/);
  });

  it('Loop Home and the redesigned CRM pages are built from the same primitives', () => {
    for (const file of ['app/app/_home/admin-home.tsx', 'app/app/_home/module-home.tsx', ...Object.values(PAGES)]) {
      const src = code(read(file));
      assert.match(src, /<LoopPage\b/, `${file} renders on the shared page`);
      assert.match(src, /from '\.\.\/(\.\.\/)*_loop-os\/record'/, `${file} imports the shared primitives`);
    }
    const home = code(read('app/app/_home/admin-home.tsx'));
    assert.match(home, /<PageHead\b/);
    assert.equal(/className="(cmd|tiles|tile)\b/.test(home), false, 'Home no longer uses the old dashboard classes');
    assert.equal(/Search companies, contacts, work/.test(home), false, 'the search box names what it searches');
  });
});
