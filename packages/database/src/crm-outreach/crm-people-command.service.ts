// The People command center's read service (CRM slice 6).
//
// Decision record: docs/architecture/crm-people-command-center.md.
//
// TWO AUTHORITIES, COMBINED AT READ TIME, FOR ONE VIEWER:
//   1. SHARED CRM facts, the same for everyone who may see People (identityResolution:view + the
//      outreach VIEW act): the Person, title, company and creator context, notes, the human-set state
//      and next action, the import's recorded last contact.
//   2. THE VIEWER'S OWN mail and calendar (employeeIntelligence:view, their own rows only, §20.1):
//      sends, replies, meetings -- linked to Parties by exact keyed hash, qualified by fixed rules.
// Nothing derived from (2) is stored, and nothing from one viewer's mail reaches another viewer.
//
// NO N+1. A fixed number of queries per read, whatever the directory size: the directory, the
// current facts, the states, the Contact Point index, the viewer's correspondents, their messages
// with linked addresses, their events with linked addresses, and the names those reference. A
// directory larger than CRM_PEOPLE_MAX_DIRECTORY is refused (TOO_LARGE), never read partially.

import type { PrismaClient } from '@prisma/client';
import {
  CRM_PEOPLE_MAX_DIRECTORY,
  crmDiscoveryProposedName,
  crmInternalDomains,
  decideCrmDiscovery,
  deriveCrmOutreach,
  isCrmHumanConversationState,
  type CrmContextFactKind,
  type CrmDiscoveryReason,
  type CrmMailVisibility,
  type CrmMessageQualification,
  type CrmOutreachDerivation,
  type CrmPeopleRow,
  type CrmTimePrecision,
  type WorkSourceFreshness,
} from '@emgloop/shared';

import { IamRepository } from '../repositories/iam.repository';
import { IntelligenceDigestRepository } from '../repositories/intelligence/intelligence-digest.repository';
import { absentUntilMigrated } from '../creator/until-migrated';
import { CrmContactPointRepository } from '../repositories/crm-contact-point.repository';
import { PartyReadModelRepository } from '../repositories/party-read-model.repository';
import { PartyReferenceRepository } from '../repositories/party-reference.repository';
import { WorkOutreachRepository, type OutreachCorrespondent, type OutreachEvent } from '../repositories/work-state/work-outreach.repository';
import { crmOutreachRole, type CrmOutreachActor } from './crm-outreach-access';
import { CrmOutreachRepository, type CrmContextFactRecord, type CrmOutreachStateRecord } from './crm-outreach.repository';
import { crmOutreachActPermitted } from '@emgloop/shared';
import { eventStart, linkCorrespondents, partyMeetings, qualifyPartyMail, type MailLinks, type PartyMailEvidence } from './crm-outreach-mail-link';

/** What the caller knows about the viewer's own Gmail and Calendar (`deriveSourceState`), or null when not connected. */
export interface CrmViewerSources {
  readonly gmail: { readonly freshness: WorkSourceFreshness; readonly lastReadAt: Date | null } | null;
  readonly calendar: { readonly freshness: WorkSourceFreshness; readonly lastReadAt: Date | null } | null;
}

export interface CrmViewerMailStatus {
  /** Whether the viewer may read their own work state at all (employeeIntelligence:view). */
  readonly permitted: boolean;
  readonly gmail: CrmMailVisibility;
  readonly calendar: 'FRESH' | 'STALE' | 'UNAVAILABLE';
  readonly calendarReadAt: Date | null;
  /** Contact Points hashed under another key: they cannot be linked to mail by this runtime. */
  readonly keyMismatchedPoints: number;
  /** The viewer's mail exceeded a read bound; what is shown is incomplete and says so. */
  readonly truncated: boolean;
  readonly linkedPeople: number;
}

export interface CrmPeopleCapabilities {
  readonly setState: boolean;
  readonly setNextAction: boolean;
  readonly recordNote: boolean;
  readonly retractFact: boolean;
}

/**
 * A viewer-private AI reading of the Gmail threads linked exactly to one Person.
 * It is interpretation, never a CRM fact: the UI may summarize or suggest an action from it, but
 * it never writes a state, Relationship, Opportunity, cadence event, or Contact Point.
 */
export interface CrmConversationIntelligence {
  readonly summary: string;
  readonly generatedAt: Date;
  readonly lastEvidenceAt: Date | null;
  readonly confidence: string | null;
  readonly suggestion: 'REPLY' | 'WAIT' | 'CIRCLE_BACK' | 'REVIEW' | 'NONE';
  readonly suggestionText: string | null;
}

export interface CrmDiscoveryCandidate {
  readonly correspondentHash: string;
  readonly address: string;
  readonly proposedName: string | null;
  readonly displayName: string | null;
  /** When the viewer's mail first and last observed this address. */
  readonly firstObservedAt: Date;
  readonly lastObservedAt: Date;
  readonly directSends: number;
  readonly humanReplies: number;
  readonly reasons: readonly CrmDiscoveryReason[];
  /** The most recent thread with them in the viewer's own mail: id, subject, direction and time. */
  readonly recentThread: { readonly threadId: string; readonly subject: string | null; readonly direction: string; readonly at: Date } | null;
}

export type CrmPeopleCommandResult =
  | { readonly outcome: 'NOT_AUTHORIZED' }
  | { readonly outcome: 'TOO_LARGE'; readonly limit: number }
  | {
      readonly outcome: 'OK';
      readonly rows: readonly CrmPeopleRow[];
      readonly mail: CrmViewerMailStatus;
      readonly capabilities: CrmPeopleCapabilities;
      readonly discovery: { readonly count: number; readonly newThisWeek: number } | null;
      readonly creators: readonly { readonly key: string; readonly label: string }[];
      readonly companies: readonly { readonly partyId: string; readonly name: string }[];
      readonly owners: readonly { readonly userId: string; readonly name: string }[];
      /** Viewer-private, body-aware Mail intelligence when commissioned and authorized. */
      readonly intelligenceByParty: ReadonlyMap<string, CrmConversationIntelligence>;
    };

export type CrmTimelineSource = 'IMPORT' | 'OPERATOR' | 'CRM' | 'GMAIL' | 'CALENDAR';

export interface CrmTimelineEntry {
  readonly key: string;
  readonly at: Date | null;
  readonly precision: CrmTimePrecision;
  readonly source: CrmTimelineSource;
  readonly kind: string;
  readonly title: string;
  readonly detail: string | null;
  /** The viewer's own mail thread, when the entry is one of their messages. */
  readonly threadId: string | null;
  /** True for entries derived from the viewer's own mail or calendar (no one else sees them). */
  readonly private: boolean;
  readonly retracted: boolean;
  readonly factId: string | null;
}

export type CrmPersonOutreachResult =
  | { readonly outcome: 'NOT_AUTHORIZED' }
  | { readonly outcome: 'NOT_FOUND' }
  | {
      readonly outcome: 'OK';
      readonly row: CrmPeopleRow;
      readonly mail: CrmViewerMailStatus;
      readonly capabilities: CrmPeopleCapabilities;
      readonly timeline: readonly CrmTimelineEntry[];
      readonly facts: readonly CrmContextFactRecord[];
      readonly lastOutboundAt: Date | null;
      readonly lastInboundAt: Date | null;
      readonly nextMeeting: { readonly at: Date; readonly title: string | null } | null;
      readonly names: ReadonlyMap<string, string>;
      readonly conversationIntelligence: CrmConversationIntelligence | null;
    };

export interface CrmPeopleCommandServiceDeps {
  outreach?: CrmOutreachRepository;
  parties?: PartyReadModelRepository;
  references?: Pick<PartyReferenceRepository, 'resolve'>;
  contactPoints?: Pick<CrmContactPointRepository, 'matchIndex'>;
  work?: WorkOutreachRepository;
  iam?: Pick<IamRepository, 'canEach'>;
  keyFingerprint?: () => string;
}

const DIRECTORY_FACT_KINDS: readonly CrmContextFactKind[] = ['TITLE', 'COMPANY_CONTEXT', 'CREATOR_CONTEXT', 'NOTE', 'SOURCE_STATUS', 'SOURCE_LAST_CONTACTED'];
const DAY = 86_400_000;

function visibility(src: CrmViewerSources['gmail'], observedFrom: Date | null): CrmMailVisibility {
  if (!src || !src.lastReadAt) return { state: 'UNAVAILABLE' };
  if (src.freshness === 'CURRENT') return { state: 'FRESH', observedFrom, observedThrough: src.lastReadAt };
  if (src.freshness === 'STALE') return { state: 'STALE', observedFrom, observedThrough: src.lastReadAt };
  return { state: 'UNAVAILABLE' };
}

export class CrmPeopleCommandService {
  private readonly outreach: CrmOutreachRepository;
  private readonly parties: PartyReadModelRepository;
  private readonly references: Pick<PartyReferenceRepository, 'resolve'>;
  private readonly contactPoints: Pick<CrmContactPointRepository, 'matchIndex'>;
  private readonly work: WorkOutreachRepository;
  private readonly iam: Pick<IamRepository, 'canEach'>;
  private readonly keyFingerprint: (() => string) | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CrmPeopleCommandServiceDeps = {},
  ) {
    this.outreach = deps.outreach ?? new CrmOutreachRepository(prisma);
    this.parties = deps.parties ?? new PartyReadModelRepository(prisma);
    this.references = deps.references ?? new PartyReferenceRepository(prisma);
    this.contactPoints = deps.contactPoints ?? new CrmContactPointRepository(prisma);
    this.work = deps.work ?? new WorkOutreachRepository(prisma);
    this.iam = deps.iam ?? new IamRepository(prisma);
    this.keyFingerprint = deps.keyFingerprint;
  }

  // --- The directory -----------------------------------------------------------------------------

  async directory(actor: CrmOutreachActor, sources: CrmViewerSources, options: { readonly now: Date; readonly timeZone: string }): Promise<CrmPeopleCommandResult> {
    const access = await this.access(actor);
    if (!access) return { outcome: 'NOT_AUTHORIZED' };
    const org = actor.organizationId;

    const directory = await this.parties.directory(org, 'PERSON', CRM_PEOPLE_MAX_DIRECTORY);
    if (directory.truncated) return { outcome: 'TOO_LARGE', limit: CRM_PEOPLE_MAX_DIRECTORY };
    const [facts, states, index] = await Promise.all([
      this.outreach.currentFacts(org, DIRECTORY_FACT_KINDS),
      this.outreach.states(org),
      this.contactPoints.matchIndex(org, ['EMAIL']),
    ]);
    const mail = await this.viewerMail(actor, access.mailPermitted, sources, index, null);

    const factsByParty = groupBy(facts, (f) => f.partyId);
    const stateByParty = new Map(states.map((s) => [s.partyId, s]));
    const importedParties = new Set(index.filter((p) => p.basis === 'IMPORTED').map((p) => p.partyId));
    const importedLastContact = latestImportedContact(index);

    const companyIds = facts.filter((f) => f.kind === 'COMPANY_CONTEXT' && f.relatedPartyId).map((f) => f.relatedPartyId!);
    const creatorIds = facts.filter((f) => f.kind === 'CREATOR_CONTEXT' && f.relatedPartyId).map((f) => f.relatedPartyId!);
    const names = await this.parties.names(org, [...companyIds, ...creatorIds]);

    const intelligenceByParty = await this.conversationIntelligenceByParty(actor, mail);
    const rows: CrmPeopleRow[] = directory.rows.map((p) =>
      buildRow({
        partyId: p.id,
        displayName: p.displayName?.trim() || 'Unnamed person',
        establishedAt: p.establishedAt ?? new Date(0),
        facts: factsByParty.get(p.id) ?? [],
        state: stateByParty.get(p.id) ?? null,
        imported: importedParties.has(p.id),
        importedLastContact: importedLastContact.get(p.id) ?? null,
        mail,
        names,
        now: options.now,
        timeZone: options.timeZone,
      }),
    );

    const creators = new Map<string, string>();
    const companies = new Map<string, string>();
    const owners = new Set<string>();
    for (const r of rows) {
      if (r.creator) creators.set(r.creator.partyId ?? r.creator.label, r.creator.label);
      if (r.company) companies.set(r.company.partyId, r.company.name ?? 'Unnamed company');
      if (r.workedByUserId) owners.add(r.workedByUserId);
    }
    const ownerNames = await this.outreach.memberNames(org, [...owners]);
    const discovery = mail.status.permitted && mail.status.gmail.state !== 'UNAVAILABLE' ? await this.discoveryFrom(actor, mail) : null;

    return {
      outcome: 'OK',
      rows,
      mail: mail.status,
      capabilities: access.capabilities,
      discovery: discovery ? { count: discovery.length, newThisWeek: discovery.filter((c) => options.now.getTime() - c.firstObservedAt.getTime() <= 7 * DAY).length } : null,
      creators: [...creators].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label)),
      companies: [...companies].map(([partyId, name]) => ({ partyId, name })).sort((a, b) => a.name.localeCompare(b.name)),
      owners: [...owners].map((userId) => ({ userId, name: ownerNames.get(userId) ?? 'A team member' })).sort((a, b) => a.name.localeCompare(b.name)),
      intelligenceByParty,
    };
  }

  // --- One person ------------------------------------------------------------------------------

  async person(actor: CrmOutreachActor, partyId: string, sources: CrmViewerSources, options: { readonly now: Date; readonly timeZone: string }): Promise<CrmPersonOutreachResult> {
    const access = await this.access(actor);
    if (!access) return { outcome: 'NOT_AUTHORIZED' };
    const org = actor.organizationId;
    const resolved = await this.references.resolve(org, partyId);
    if (resolved.state !== 'ESTABLISHED' || resolved.archived || resolved.partyType !== 'PERSON' || resolved.partyId !== partyId) return { outcome: 'NOT_FOUND' };

    const [facts, state, events, index] = await Promise.all([
      this.outreach.factsForParty(org, partyId),
      this.outreach.state(org, partyId),
      this.outreach.events(org, partyId),
      this.contactPoints.matchIndex(org, ['EMAIL']),
    ]);
    const mail = await this.viewerMail(actor, access.mailPermitted, sources, index, partyId);
    const self = await this.parties.establishedOne(org, 'PERSON', partyId);
    const current = facts.filter((f) => f.retractedAt === null);
    const relatedIds = current.filter((f) => f.relatedPartyId).map((f) => f.relatedPartyId!);
    const names = await this.parties.names(org, relatedIds);
    const row = buildRow({
      partyId,
      displayName: self?.displayName?.trim() || 'Unnamed person',
      establishedAt: self?.establishedAt ?? new Date(0),
      facts: current,
      state,
      imported: index.some((p) => p.partyId === partyId && p.basis === 'IMPORTED'),
      importedLastContact: latestImportedContact(index).get(partyId) ?? null,
      mail,
      names,
      now: options.now,
      timeZone: options.timeZone,
    });

    const evidence = mail.evidence.get(partyId);
    const conversationIntelligence = (await this.conversationIntelligenceByParty(actor, mail)).get(partyId) ?? null;
    const meetings = mail.meetings.get(partyId) ?? [];
    const actorIds = [...events.map((e) => e.actorUserId), ...facts.map((f) => f.recordedByUserId ?? '')];
    const memberNames = await this.outreach.memberNames(org, actorIds);
    const timeline = buildTimeline(facts, events, evidence, meetings, latestImportedContact(index).get(partyId) ?? null, memberNames, names);
    const lastOutbound = latestDate((evidence?.messages ?? []).filter((m) => m.qualification === 'QUALIFYING_SEND').map((m) => m.message.internalDate));
    const lastInbound = latestDate((evidence?.messages ?? []).filter((m) => m.message.direction === 'INBOUND').map((m) => m.message.internalDate));
    const upcoming = meetings
      .map((e) => ({ at: eventStart(e), title: e.summary }))
      .filter((m): m is { at: Date; title: string | null } => m.at !== null && m.at.getTime() >= options.now.getTime())
      .sort((a, b) => a.at.getTime() - b.at.getTime())[0] ?? null;
    return {
      outcome: 'OK',
      row,
      mail: mail.status,
      capabilities: access.capabilities,
      timeline,
      facts,
      lastOutboundAt: lastOutbound,
      lastInboundAt: lastInbound,
      nextMeeting: upcoming,
      names: new Map([...names, ...memberNames]),
      conversationIntelligence,
    };
  }

  // --- Possible New People ---------------------------------------------------------------------

  /** The viewer's private Possible New People queue (and, separately, what they dismissed). */
  async discovery(actor: CrmOutreachActor, sources: CrmViewerSources, options: { readonly now: Date }): Promise<
    | { readonly outcome: 'NOT_AUTHORIZED' }
    | { readonly outcome: 'MAIL_UNAVAILABLE' }
    | { readonly outcome: 'OK'; readonly candidates: readonly CrmDiscoveryCandidate[]; readonly dismissed: readonly (OutreachCorrespondent & { readonly reason: string; readonly dismissedAt: Date })[]; readonly mail: CrmViewerMailStatus }
  > {
    const access = await this.access(actor);
    if (!access) return { outcome: 'NOT_AUTHORIZED' };
    if (!access.mailPermitted) return { outcome: 'MAIL_UNAVAILABLE' };
    const index = await this.contactPoints.matchIndex(actor.organizationId, ['EMAIL']);
    const mail = await this.viewerMail(actor, true, sources, index, null);
    if (mail.status.gmail.state === 'UNAVAILABLE') return { outcome: 'MAIL_UNAVAILABLE' };
    const candidates = await this.discoveryFrom(actor, mail);
    const dismissals = await this.work.dismissals(actor);
    const active = new Map(dismissals.filter((d) => d.restoredAt === null).map((d) => [d.correspondentHash, d]));
    const dismissed = mail.correspondents
      .filter((c) => active.has(c.addressHash))
      .map((c) => ({ ...c, reason: active.get(c.addressHash)!.reason, dismissedAt: active.get(c.addressHash)!.dismissedAt }));
    return { outcome: 'OK', candidates, dismissed, mail: mail.status };
  }

  // --- Internals -------------------------------------------------------------------------------

  private async access(actor: CrmOutreachActor): Promise<{ capabilities: CrmPeopleCapabilities; mailPermitted: boolean } | null> {
    const role = await crmOutreachRole(this.prisma, this.iam, actor);
    if (!role || !crmOutreachActPermitted({ act: 'VIEW', role, actorType: 'HUMAN' })) return null;
    const [mailPermitted] = await this.iam.canEach(actor.organizationId, actor.userId, [{ resource: 'employeeIntelligence', action: 'view' }]);
    const may = (act: string) => crmOutreachActPermitted({ act, role, actorType: 'HUMAN' });
    return {
      mailPermitted: mailPermitted === true,
      capabilities: { setState: may('SET_STATE'), setNextAction: may('SET_NEXT_ACTION'), recordNote: may('RECORD_NOTE'), retractFact: may('RETRACT_FACT') },
    };
  }

  /** The viewer's own mail, linked and qualified. `onlyParty` narrows the message read to one Party. */
  private async viewerMail(actor: CrmOutreachActor, permitted: boolean, sources: CrmViewerSources, index: Awaited<ReturnType<CrmContactPointRepository['matchIndex']>>, onlyParty: string | null): Promise<ViewerMail> {
    const empty: ViewerMail = {
      status: { permitted, gmail: { state: 'UNAVAILABLE' }, calendar: 'UNAVAILABLE', calendarReadAt: null, keyMismatchedPoints: 0, truncated: false, linkedPeople: 0 },
      correspondents: [],
      links: { byCorrespondent: new Map(), hashesByParty: new Map(), keyMismatchedPoints: 0 },
      evidence: new Map(),
      meetings: new Map(),
      addressOf: new Map(),
    };
    if (!permitted) return empty;
    const principal = { organizationId: actor.organizationId, userId: actor.userId };
    const [correspondents, earliest] = await Promise.all([this.work.correspondents(principal), this.work.earliestMessageAt(principal)]);
    const gmail = visibility(sources.gmail, earliest);
    const calendar = sources.calendar && sources.calendar.lastReadAt ? (sources.calendar.freshness === 'CURRENT' ? 'FRESH' : sources.calendar.freshness === 'STALE' ? 'STALE' : 'UNAVAILABLE') : 'UNAVAILABLE';
    const links = linkCorrespondents(actor.organizationId, correspondents.rows, index, this.keyFingerprint?.());
    const personHashes = new Map([...links.hashesByParty].filter(([partyId]) => (onlyParty ? partyId === onlyParty : true)));
    const wanted = [...personHashes.values()].flat();
    const [messages, events] = await Promise.all([
      gmail.state === 'UNAVAILABLE' ? Promise.resolve({ rows: [], truncated: false }) : this.work.messagesWith(principal, wanted),
      calendar === 'UNAVAILABLE' ? Promise.resolve([] as OutreachEvent[]) : this.work.eventsWith(principal, wanted),
    ]);
    const addressOf = new Map(correspondents.rows.map((c) => [c.addressHash, c.displayAddress]));
    const evidence = qualifyPartyMail(personHashes, messages.rows, addressOf);
    const meetings = partyMeetings(personHashes, events);
    const linkedPeople = [...links.byCorrespondent.values()].filter((l) => l.kind === 'PERSON').length;
    return {
      status: { permitted, gmail, calendar, calendarReadAt: sources.calendar?.lastReadAt ?? null, keyMismatchedPoints: links.keyMismatchedPoints, truncated: correspondents.truncated || messages.truncated, linkedPeople },
      correspondents: correspondents.rows,
      links,
      evidence,
      meetings,
      addressOf,
    };
  }

  /**
   * Read only the current MAIL thread digests for threads that already link to a Person through exact
   * Contact Point matching. No body is read here: the body-aware producer owns that act and stores only
   * the minimized, viewer-private digest after the existing governance and consent gates pass.
   */
  private async conversationIntelligenceByParty(actor: CrmOutreachActor, mail: ViewerMail): Promise<Map<string, CrmConversationIntelligence>> {
    if (!mail.status.permitted || mail.status.gmail.state === 'UNAVAILABLE' || mail.evidence.size === 0) return new Map();
    const principal = { organizationId: actor.organizationId, userId: actor.userId };
    const providerThreadIds = [...new Set([...mail.evidence.values()].flatMap((e) => e.messages.map((m) => m.message.threadId)))];
    if (providerThreadIds.length === 0) return new Map();
    const threads = await this.prisma.workThread.findMany({
      where: { ...principal, threadId: { in: providerThreadIds } },
      select: { id: true, threadId: true },
      take: 10_000,
    });
    const workIdByProviderThread = new Map(threads.map((t) => [t.threadId, t.id]));
    const digests = (await absentUntilMigrated(new IntelligenceDigestRepository(this.prisma).forDomain(principal, 'MAIL', { now: new Date(), limit: 200 }))) ?? [];
    const digestByRef = new Map(
      digests
        .filter((d) => d.subjectKind === 'THREAD' && d.status === 'CURRENT')
        .map((d) => [d.subjectRef, d] as const),
    );
    const out = new Map<string, CrmConversationIntelligence>();
    for (const [partyId, evidence] of mail.evidence) {
      const candidates = [...new Set(evidence.messages.map((m) => workIdByProviderThread.get(m.message.threadId)).filter((id): id is string => !!id))]
        .map((id) => digestByRef.get(`work_thread:${id}`))
        .filter((d): d is Exclude<typeof d, undefined> => d !== undefined)
        .sort((a, b) => (b.lastEvidenceAt?.getTime() ?? 0) - (a.lastEvidenceAt?.getTime() ?? 0));
      const d = candidates[0];
      if (!d) continue;
      const summary = d.content.synthesis ?? d.content.reading?.statement ?? null;
      if (!summary) continue;
      const signals = d.content.signals ?? [];
      const viewer = signals.find((s) => s.kind === 'OBLIGATION' && s.owedBy === 'VIEWER');
      const other = signals.find((s) => s.kind === 'OBLIGATION' && s.owedBy === 'COUNTERPARTY');
      const future = signals.find((s) => s.kind === 'UPCOMING' || s.kind === 'OPPORTUNITY');
      const review = signals.find((s) => s.kind === 'DECISION_PENDING' || s.kind === 'UNRESOLVED' || s.kind === 'RISK');
      const suggestion: CrmConversationIntelligence['suggestion'] = viewer ? 'REPLY' : other ? 'WAIT' : future ? 'CIRCLE_BACK' : review ? 'REVIEW' : 'NONE';
      const suggestionText = viewer?.statement ?? other?.statement ?? future?.statement ?? review?.statement ?? null;
      out.set(partyId, {
        summary,
        generatedAt: d.generatedAt,
        lastEvidenceAt: d.lastEvidenceAt,
        confidence: d.content.confidence ?? d.content.reading?.confidence ?? null,
        suggestion,
        suggestionText,
      });
    }
    return out;
  }

  private async discoveryFrom(actor: CrmOutreachActor, mail: ViewerMail): Promise<CrmDiscoveryCandidate[]> {
    const principal = { organizationId: actor.organizationId, userId: actor.userId };
    const [own, members, dismissals] = await Promise.all([this.work.ownAddresses(principal), this.outreach.memberAddresses(actor.organizationId), this.work.dismissals(principal)]);
    const ownSet = new Set(own);
    const memberSet = new Set(members);
    const internal = crmInternalDomains([...members, ...own]);
    const dismissed = new Set(dismissals.filter((d) => d.restoredAt === null).map((d) => d.correspondentHash));
    // Stage 1: address rules and the stored counts, so only plausible candidates are read in detail.
    const pre = mail.correspondents.filter((c) => {
      const d = decideCrmDiscovery(
        { address: c.displayAddress, domain: c.domain, directSends: c.outboundCount, humanInbound: 1, nonHumanInbound: 0, suppressed: c.suppressed },
        { ownAddresses: ownSet, memberAddresses: memberSet, internalDomains: internal, inCrm: mail.links.byCorrespondent.has(c.addressHash), dismissed: dismissed.has(c.addressHash) },
      );
      return d.surfaced;
    });
    if (pre.length === 0) return [];
    // Stage 2: exact qualification over the viewer's own messages with those addresses.
    const hashes = new Map(pre.map((c) => [c.addressHash, [c.addressHash]] as const));
    const messages = await this.work.messagesWith(principal, pre.map((c) => c.addressHash));
    const evidence = qualifyPartyMail(hashes, messages.rows, mail.addressOf);
    const out: CrmDiscoveryCandidate[] = [];
    for (const c of pre) {
      const e = evidence.get(c.addressHash);
      const directSends = e?.sends.length ?? 0;
      const humanReplies = e?.humanReplies.length ?? 0;
      const d = decideCrmDiscovery(
        { address: c.displayAddress, domain: c.domain, directSends, humanInbound: humanReplies, nonHumanInbound: (e?.automated.length ?? 0) + (e?.uncertain.length ?? 0), suppressed: c.suppressed },
        { ownAddresses: ownSet, memberAddresses: memberSet, internalDomains: internal, inCrm: false, dismissed: false },
      );
      if (!d.surfaced) continue;
      const last = [...(e?.messages ?? [])].filter((m) => m.qualification === 'QUALIFYING_SEND' || m.qualification === 'HUMAN_REPLY').sort((a, b) => b.message.internalDate.getTime() - a.message.internalDate.getTime())[0];
      out.push({
        correspondentHash: c.addressHash,
        address: c.displayAddress,
        proposedName: crmDiscoveryProposedName(c.displayName),
        displayName: c.displayName,
        firstObservedAt: c.firstSeenAt,
        lastObservedAt: c.lastSeenAt,
        directSends,
        humanReplies,
        reasons: d.reasons,
        recentThread: last ? { threadId: last.message.threadId, subject: last.message.subject, direction: last.message.direction, at: last.message.internalDate } : null,
      });
    }
    return out.sort((a, b) => b.lastObservedAt.getTime() - a.lastObservedAt.getTime() || (a.correspondentHash < b.correspondentHash ? -1 : 1));
  }
}

interface ViewerMail {
  readonly status: CrmViewerMailStatus;
  readonly correspondents: readonly OutreachCorrespondent[];
  readonly links: MailLinks;
  readonly evidence: ReadonlyMap<string, PartyMailEvidence>;
  readonly meetings: ReadonlyMap<string, OutreachEvent[]>;
  readonly addressOf: ReadonlyMap<string, string>;
}

function groupBy<T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = out.get(k) ?? [];
    list.push(x);
    out.set(k, list);
  }
  return out;
}

function latestDate(xs: readonly Date[]): Date | null {
  return xs.reduce<Date | null>((m, x) => (m === null || x > m ? x : m), null);
}

/** The import's recorded last human contact per Party, from its INDIVIDUAL Contact Points. */
function latestImportedContact(index: readonly { partyId: string; basis: string; lastHumanContactAt: Date | null }[]): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const p of index) {
    if (p.basis !== 'IMPORTED' || !p.lastHumanContactAt) continue;
    const prev = out.get(p.partyId);
    if (!prev || p.lastHumanContactAt > prev) out.set(p.partyId, p.lastHumanContactAt);
  }
  return out;
}

/** The latest current fact of a kind (facts arrive newest-recorded first). */
const latestFact = (facts: readonly CrmContextFactRecord[], kind: CrmContextFactKind) => facts.find((f) => f.kind === kind && f.retractedAt === null) ?? null;

function isMidnightUtc(d: Date): boolean {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

function buildRow(input: {
  partyId: string;
  displayName: string;
  establishedAt: Date;
  facts: readonly CrmContextFactRecord[];
  state: CrmOutreachStateRecord | null;
  imported: boolean;
  importedLastContact: Date | null;
  mail: ViewerMail;
  names: ReadonlyMap<string, string>;
  now: Date;
  timeZone: string;
}): CrmPeopleRow {
  const { facts, state, mail } = input;
  const title = latestFact(facts, 'TITLE');
  const company = latestFact(facts, 'COMPANY_CONTEXT');
  const creator = latestFact(facts, 'CREATOR_CONTEXT');
  const note = latestFact(facts, 'NOTE');
  const status = latestFact(facts, 'SOURCE_STATUS');
  const sourceContact = latestFact(facts, 'SOURCE_LAST_CONTACTED');
  const evidence = mail.evidence.get(input.partyId);
  const meetings = mail.meetings.get(input.partyId) ?? [];
  const nextMeetingAt = meetings.map(eventStart).filter((d): d is Date => d !== null && d.getTime() >= input.now.getTime()).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

  // The import's last contact: the Contact Point's recorded value, or the backfilled source fact.
  const importedAt = input.importedLastContact ?? sourceContact?.occurredAt ?? null;
  const importedPrecision: 'DATE' | 'INSTANT' =
    sourceContact && sourceContact.occurredAt && importedAt && sourceContact.occurredAt.getTime() === importedAt.getTime()
      ? sourceContact.occurredAtPrecision === 'INSTANT' ? 'INSTANT' : 'DATE'
      : importedAt && isMidnightUtc(importedAt) ? 'DATE' : 'INSTANT';

  const humanState = state?.state && isCrmHumanConversationState(state.state) ? state.state : null;
  const outreach: CrmOutreachDerivation = deriveCrmOutreach({
    mail: mail.status.gmail,
    sends: evidence?.sends ?? [],
    humanReplies: evidence?.humanReplies ?? [],
    automated: evidence?.automated ?? [],
    uncertain: evidence?.uncertain ?? [],
    importedLastContact: importedAt ? { at: importedAt, precision: importedPrecision } : null,
    human: state ? { state: humanState, stateSetAt: humanState ? state.stateSetAt : null, nextAction: state.nextAction, nextActionDueAt: state.nextActionDueAt } : null,
    nextMeetingAt,
    now: input.now,
    timeZone: input.timeZone,
  });
  const workedAt = [state?.stateSetAt && state.stateSetByUserId ? { at: state.stateSetAt, by: state.stateSetByUserId } : null, state?.nextActionSetAt && state.nextActionSetByUserId ? { at: state.nextActionSetAt, by: state.nextActionSetByUserId } : null]
    .filter((x): x is { at: Date; by: string } => x !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  return {
    partyId: input.partyId,
    displayName: input.displayName,
    establishedAt: input.establishedAt,
    title: title?.text ? { text: title.text, basis: title.basis } : null,
    company: company?.relatedPartyId ? { partyId: company.relatedPartyId, name: input.names.get(company.relatedPartyId) ?? company.text ?? null } : null,
    creator: creator?.text ? { label: creator.relatedPartyId ? input.names.get(creator.relatedPartyId) ?? creator.text : creator.text, partyId: creator.relatedPartyId } : null,
    origin: input.imported || facts.some((f) => f.basis === 'IMPORTED') ? 'IMPORTED' : 'MANUAL',
    latestNote: note?.text ? { text: note.text, at: note.occurredAt, precision: note.occurredAtPrecision, basis: note.basis } : null,
    sourceStatus: status?.text ?? null,
    outreach,
    workedByUserId: workedAt?.by ?? null,
    humanStateSetAt: humanState ? state?.stateSetAt ?? null : null,
    nextMeetingAt,
    lastHumanReplyAt: latestDate(evidence?.humanReplies ?? []),
  };
}

const QUALIFICATION_TITLE: Readonly<Record<CrmMessageQualification, string>> = {
  QUALIFYING_SEND: 'Email sent',
  HUMAN_REPLY: 'Reply received',
  AUTOMATED: 'Automated reply (not counted)',
  UNCERTAIN: 'Message received (needs review)',
  NOT_OUTREACH: 'Email (copied)',
};

const FACT_TITLE: Readonly<Record<string, string>> = {
  TITLE: 'Title recorded',
  NOTE: 'Note',
  SOURCE_STATUS: 'Source status',
  SOURCE_LAST_CONTACTED: 'Last contacted (source)',
  CREATOR_CONTEXT: 'Creator context',
  COMPANY_CONTEXT: 'Company context',
  ORIGIN: 'Added to People',
};

const STATE_EVENT_TITLE: Readonly<Record<string, string>> = {
  STATE_SET: 'Conversation state set',
  STATE_CLEARED: 'Conversation state cleared',
  NEXT_ACTION_SET: 'Next action set',
  NEXT_ACTION_CLEARED: 'Next action cleared',
};

function buildTimeline(
  facts: readonly CrmContextFactRecord[],
  events: Awaited<ReturnType<CrmOutreachRepository['events']>>,
  evidence: PartyMailEvidence | undefined,
  meetings: readonly OutreachEvent[],
  importedLastContact: Date | null,
  memberNames: ReadonlyMap<string, string>,
  partyNames: ReadonlyMap<string, string>,
): CrmTimelineEntry[] {
  const out: CrmTimelineEntry[] = [];
  for (const f of facts) {
    const related = f.relatedPartyId ? partyNames.get(f.relatedPartyId) ?? null : null;
    out.push({
      key: `fact:${f.id}`,
      at: f.occurredAt,
      precision: f.occurredAtPrecision,
      source: f.basis === 'IMPORTED' ? 'IMPORT' : 'OPERATOR',
      kind: f.kind,
      title: FACT_TITLE[f.kind] ?? f.kind,
      detail: f.kind === 'COMPANY_CONTEXT' ? related ?? f.text : f.kind === 'CREATOR_CONTEXT' ? related ?? f.text : f.text,
      threadId: null,
      private: false,
      retracted: f.retractedAt !== null,
      factId: f.id,
    });
  }
  for (const e of events) {
    const who = memberNames.get(e.actorUserId) ?? 'A team member';
    const detail =
      e.type === 'STATE_SET' ? e.state : e.type === 'NEXT_ACTION_SET' ? `${e.nextAction ?? ''}${e.nextActionDueAt ? ` (due ${e.nextActionDueAt.toISOString().slice(0, 10)})` : ''}` : null;
    out.push({ key: `event:${e.id}`, at: e.occurredAt, precision: 'INSTANT', source: 'CRM', kind: e.type, title: `${STATE_EVENT_TITLE[e.type] ?? e.type} by ${who}`, detail, threadId: null, private: false, retracted: false, factId: null });
  }
  for (const m of evidence?.messages ?? []) {
    out.push({
      key: `mail:${m.message.provider}:${m.message.messageId}`,
      at: m.message.internalDate,
      precision: 'INSTANT',
      source: 'GMAIL',
      kind: m.qualification,
      title: QUALIFICATION_TITLE[m.qualification],
      detail: m.message.subject,
      threadId: m.message.threadId,
      private: true,
      retracted: false,
      factId: null,
    });
  }
  for (const e of meetings) {
    out.push({ key: `meeting:${e.eventId}`, at: eventStart(e), precision: e.startsAt ? 'INSTANT' : 'DATE', source: 'CALENDAR', kind: 'MEETING', title: 'Meeting', detail: e.summary, threadId: null, private: true, retracted: false, factId: null });
  }
  if (importedLastContact && !facts.some((f) => f.kind === 'SOURCE_LAST_CONTACTED' && f.occurredAt?.getTime() === importedLastContact.getTime())) {
    out.push({
      key: 'import:last-contact',
      at: importedLastContact,
      precision: isMidnightUtc(importedLastContact) ? 'DATE' : 'INSTANT',
      source: 'IMPORT',
      kind: 'SOURCE_LAST_CONTACTED',
      title: 'Last contacted (import)',
      detail: null,
      threadId: null,
      private: false,
      retracted: false,
      factId: null,
    });
  }
  // Newest first; an unknown time is never placed as if it were known -- it goes last.
  return out.sort((a, b) => {
    if (a.at === null && b.at === null) return a.key < b.key ? -1 : 1;
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return b.at.getTime() - a.at.getTime() || (a.key < b.key ? -1 : 1);
  });
}
