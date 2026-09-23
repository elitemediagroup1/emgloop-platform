import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ProductionView, VersionView } from '@emgloop/database';
import { requireWorkspace } from '../../../../../../../workspaces/guard';
import { creatorDomain, CREATOR_HREFS, EMG_HREFS } from '../../../../../../../creator/creator-runtime';
import { recordBrandApprovalAction, recordEmgApprovalAction, relayBrandFeedbackAction } from '../../../../../../../creator/emg-actions';
import { InstructionSetItem } from '../../../../../../../creator/production-panel';
import { viewerTime } from '../../../../../../../time/viewer-time';
import { Facts, LoopPage, PageHead, Panel, RecordLayout, StateBlock, SummaryStrip } from '../../../../../_loop-os/record';
import { ContentStatePill, Pill, RefusedBlock, TRAIL, firstNameOf, playLink, stepLine, turnaround } from '../../../_shared';

// EMG Creator Operations — the EMG projection of a Content record.
//
// THE SAME RECORD THE CREATOR HAS, WITH EVERYTHING. The regions are the creator's own --
// state, media, where it fits with its requirement checklist, production, versions -- but
// the EMG seat also sees every instruction set, every comment with its visibility, every
// version including EMG-only drafts, and every internal note, each marked "EMG only" so
// nobody mistakes it for something the creator can read. The acts here are marks and
// relayed feedback; editing itself happens on the Work OS detail this page links to.

export const dynamic = 'force-dynamic';

function stepWord(status: string): string {
  if (status === 'completed') return 'Completed';
  if (status === 'ready') return 'Ready';
  if (status === 'in_progress') return 'In progress';
  if (status === 'skipped') return 'Skipped';
  return 'Waiting';
}

function ProductionBlock({ p, creatorFirst }: { p: ProductionView; creatorFirst: string }) {
  const time = viewerTime();
  const t = turnaround(p, time);
  return (
    <div className="loop-stack" style={{ gap: 10 }}>
      <div>
        <span className="loop-table__strong">Production {p.number}</span>{' '}
        {p.workStatus === 'active' ? <Pill tone="info">Active</Pill> : p.workStatus === 'completed' ? <Pill tone="good">Completed</Pill> : <Pill tone="neutral">Cancelled</Pill>}
        <span className="loop-table__muted"> · requested by {p.requestedBy?.name ?? 'someone'} · {time.dateTime(p.createdAt)}</span>
        {' · '}
        <Link className="loop-link" href={EMG_HREFS.adminWork(p.workInstanceId)}>Open the Work OS detail</Link>
      </div>
      <Facts
        rows={[
          { label: 'Now', value: p.workStatus === 'active' ? stepLine(p.currentStep) : p.workStatus === 'completed' ? `Finished ${p.completedAt ? time.dateTime(p.completedAt) : ''}` : 'Cancelled' },
          { label: 'Requested return', value: t.requested, unknownText: 'Not asked for' },
          { label: 'Expected return', value: t.expected, unknownText: 'Not set yet' },
        ]}
      />
      <ol className="loop-stack" style={{ margin: 0, paddingLeft: 18, gap: 4 }}>
        {p.steps.map((s) => (
          <li key={s.id}>
            {s.name} — {stepWord(s.status)} · {s.owner ? s.owner.name : 'no owner yet'}
            {s.completedAt ? <span className="loop-table__muted"> · completed {time.dateTime(s.completedAt)}{s.completedBy ? ` by ${s.completedBy.name}` : ''}</span> : null}
            {s.note ? <span className="loop-note"> · “{s.note}”</span> : null}
          </li>
        ))}
      </ol>
      <div>
        <p className="loop-label" style={{ margin: '0 0 6px' }}>Instructions · in order</p>
        {p.instructions.length === 0 ? (
          <p className="loop-note">No instruction set on this production.</p>
        ) : (
          <ol className="loop-stack" style={{ margin: 0, paddingLeft: 18 }}>
            {[...p.instructions].sort((a, b) => a.sequence - b.sequence).map((i) => (
              <InstructionSetItem key={i.id} i={i} time={time} />
            ))}
          </ol>
        )}
      </div>
      <div>
        <p className="loop-label" style={{ margin: '0 0 6px' }}>Comments</p>
        {p.comments.length === 0 ? (
          <p className="loop-note">No comments on this production.</p>
        ) : (
          <ul className="loop-stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6 }}>
            {p.comments.map((c) => (
              <li key={c.id}>
                <span className="loop-table__strong">{c.by?.name ?? 'Someone'}</span>{' '}
                {c.visibility === 'creator_visible' ? <Pill tone="info">Visible to {creatorFirst}</Pill> : <Pill tone="neutral">Internal · EMG only</Pill>}
                <span className="loop-table__muted"> · {time.dateTime(c.at)}</span>
                <div>{c.body}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function VersionBlock({ v, contentId, returnTo }: { v: VersionView; contentId: string; returnTo: string }) {
  const time = viewerTime();
  const hasEmg = v.approvals.some((a) => a.requirementKey === 'emg');
  const hasBrand = v.approvals.some((a) => a.requirementKey === 'brand');
  return (
    <li className="loop-stack" style={{ gap: 6 }}>
      <div>
        <span className="loop-table__strong">{v.label}</span>
        <span className="loop-table__muted"> · {v.kind === 'ORIGINAL' ? 'original' : 'edit'} · {v.uploadedBy?.name ?? 'Someone'} ({v.uploadedByKind === 'EMG' ? 'EMG' : 'creator'}) · {time.dateTime(v.createdAt)}</span>{' '}
        {v.uploadState === 'READY' ? <Pill tone="good">Ready</Pill> : v.uploadState === 'FAILED' ? <Pill tone="critical">Failed</Pill> : <Pill tone="neutral">Pending</Pill>}{' '}
        {!v.visibleToCreator ? <Pill tone="neutral">EMG-only draft</Pill> : null} {playLink(v)}
      </div>
      {v.fileName || v.durationSeconds !== null || v.width !== null ? (
        <p className="loop-note" style={{ margin: 0 }}>
          {v.fileName ?? ''}
          {v.durationSeconds !== null ? ` · ${Math.round(v.durationSeconds)}s` : ''}
          {v.width !== null && v.height !== null ? ` · ${v.width}×${v.height}` : ''}
        </p>
      ) : null}
      {v.noteToCreator ? <p className="loop-note" style={{ margin: 0 }}>Note to the creator: “{v.noteToCreator}”</p> : null}
      {v.internalNote ? (
        <p className="loop-note" style={{ margin: 0 }}>
          <Pill tone="neutral">EMG only</Pill> {v.internalNote}
        </p>
      ) : null}
      {v.approvals.length > 0 ? (
        <p className="loop-note" style={{ margin: 0 }}>
          Approvals: {v.approvals.map((a) => `${a.requirementKey} — ${a.approverKind === 'BRAND_RELAYED' ? `${a.originatorLabel ?? 'the brand'} (relayed by ${a.by?.name ?? 'someone'})` : a.by?.name ?? 'someone'} · ${time.dateTime(a.at)}`).join('; ')}
        </p>
      ) : null}
      {v.publications.length > 0 ? (
        <p className="loop-note" style={{ margin: 0 }}>
          Published: {v.publications.map((p) => `${p.platform}${p.url ? ` (${p.url})` : ''} · ${time.dateTime(p.at)}`).join('; ')}
        </p>
      ) : null}
      {v.uploadState === 'READY' ? (
        <div className="loop-btnrow">
          {!hasEmg ? (
            <form action={recordEmgApprovalAction} className="loop-btnrow" aria-label={`EMG approval on ${v.label}`}>
              <input type="hidden" name="contentId" value={contentId} />
              <input type="hidden" name="versionId" value={v.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <input className="loop-input" name="note" maxLength={2000} placeholder="Note (optional)" style={{ width: 'auto' }} />
              <button className="loop-btn" type="submit">Record EMG approval</button>
            </form>
          ) : null}
          {!hasBrand ? (
            <form action={recordBrandApprovalAction} className="loop-btnrow" aria-label={`Brand approval on ${v.label}`}>
              <input type="hidden" name="contentId" value={contentId} />
              <input type="hidden" name="versionId" value={v.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <input className="loop-input" name="originatorLabel" maxLength={120} placeholder="Who approved (brand or agency)" required style={{ width: 'auto' }} />
              <input className="loop-input" name="note" maxLength={2000} placeholder="Note (optional)" style={{ width: 'auto' }} />
              <button className="loop-btn" type="submit">Record brand approval</button>
            </form>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export default async function CreatorContentPage({ params, searchParams }: { params: { profileId: string; contentId: string }; searchParams?: { refused?: string } }) {
  const session = await requireWorkspace('ADMIN');
  const organizationId = session.organizationId;
  const domain = creatorDomain();
  const record = await domain.records.contentRecord({ kind: 'EMG', organizationId }, params.contentId);
  // A foreign, missing, or mis-addressed record is not found, never explained.
  if (!record || record.creator.profileId !== params.profileId) notFound();
  const time = viewerTime();
  const notice = await domain.records.contentNotice({ kind: 'EMG', organizationId }, record!, time.now);
  const here = EMG_HREFS.creatorContent(record!.creator.profileId, record!.id);
  const creatorFirst = firstNameOf(record!.creator.displayName);
  const versions = [...record!.versions].sort((a, b) => b.number - a.number);
  const playable = record!.latestVersion && record!.latestVersion.uploadState === 'READY' ? record!.latestVersion : null;
  const active = record!.activeProduction;
  const ctx = record!.context;

  return (
    <LoopPage label={record!.title}>
      <PageHead
        trail={[TRAIL.operations, TRAIL.creators, { label: record!.creator.displayName, href: EMG_HREFS.creator(record!.creator.profileId) }, { label: record!.title }]}
        title={record!.title}
        subtitle={`${record!.kind === 'PHOTO' ? 'Photo' : 'Video'} · ${record!.creator.displayName} · EMG projection`}
        actions={
          <div className="loop-btnrow">
            {active ? <Link className="loop-btn loop-btn--primary" href={EMG_HREFS.adminWork(active.workInstanceId)}>Open the Work OS detail</Link> : null}
            <Link className="loop-btn" href={EMG_HREFS.creator(record!.creator.profileId)}>Creator overview</Link>
          </div>
        }
      />
      <RefusedBlock refused={searchParams?.refused} />

      <SummaryStrip
        label="State"
        items={[
          { label: 'State', value: record!.stateLabel === record!.stateLabel ? null : null, unknownText: '' },
          { label: 'Latest version', value: record!.latestVersion ? `${record!.latestVersion.label}${record!.latestVersion.visibleToCreator ? '' : ' (EMG-only draft)'}` : null, unknownText: 'None yet' },
          { label: 'Judged on', value: record!.judgedVersion?.label ?? null, unknownText: 'No visible ready version' },
          { label: 'Now', value: active ? stepLine(active.currentStep) : 'Not in production' },
        ]}
      />
      <p style={{ margin: '-6px 0 0' }}>
        <ContentStatePill state={record!.state} />
      </p>

      <RecordLayout
        railLabel="Where it fits and what Loop noticed"
        main={
          <>
            <Panel title="Media">
              {playable ? (
                record!.kind === 'PHOTO' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={CREATOR_HREFS.media(playable.id)} alt={`${record!.title} · ${playable.label}`} style={{ maxWidth: '100%', borderRadius: 8 }} />
                ) : (
                  <video controls preload="metadata" src={CREATOR_HREFS.media(playable.id)} style={{ maxWidth: '100%', borderRadius: 8 }} />
                )
              ) : (
                <StateBlock kind="empty" compact title="No version is ready to play." body="The media appears here once a version's bytes are confirmed in storage." />
              )}
              {playable ? <p className="loop-note">Playing {playable.label}{playable.visibleToCreator ? '' : ' (an EMG-only draft)'}.</p> : null}
            </Panel>

            <Panel title="Production" lead="Every production on this content, with every instruction set and every comment, internal ones included.">
              {record!.productions.length === 0 ? (
                <StateBlock kind="empty" compact title="Not in production." body="A production starts when the creator asks for an edit or brand feedback is relayed." />
              ) : (
                <div className="loop-stack" style={{ gap: 18 }}>
                  {[...record!.productions].sort((a, b) => b.number - a.number).map((p) => (
                    <ProductionBlock key={p.id} p={p} creatorFirst={creatorFirst} />
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Versions" lead="The whole lineage, including drafts the creator cannot see. Marks are recorded on one version.">
              {versions.length === 0 ? (
                <p className="loop-note">No version yet.</p>
              ) : (
                <ul className="loop-stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 14 }}>
                  {versions.map((v) => (
                    <VersionBlock key={v.id} v={v} contentId={record!.id} returnTo={here} />
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Relay brand feedback" lead="Feedback from a brand or agency, entered by you, as an instruction set the editor answers.">
              {!versions.some((v) => v.uploadState === 'READY') ? (
                <p className="loop-note">Nothing can be relayed until a version is ready.</p>
              ) : !record!.creator.userId ? (
                <StateBlock kind="unavailable" compact title="This creator has no login yet." body="Relayed feedback opens a review step for the creator, which needs a bound login. Bind one on the creator overview." />
              ) : (
                <form action={relayBrandFeedbackAction} className="loop-stack" aria-label="Relay brand feedback">
                  <input type="hidden" name="contentId" value={record!.id} />
                  <input type="hidden" name="returnTo" value={here} />
                  <label className="loop-field">
                    <span className="loop-label">Who the feedback is from</span>
                    <input className="loop-input" name="originatorLabel" maxLength={120} required />
                  </label>
                  <label className="loop-field">
                    <span className="loop-label">Summary</span>
                    <textarea className="loop-textarea" name="summary" rows={2} maxLength={2000} />
                  </label>
                  <label className="loop-field">
                    <span className="loop-label">Timestamped notes (optional, JSON)</span>
                    <textarea className="loop-textarea" name="notes" rows={2} placeholder='[{"id":"n1","atSeconds":2,"kind":"CHANGE","text":"…"}]' />
                  </label>
                  <label className="loop-field">
                    <span className="loop-label">Requested return (your local time)</span>
                    <input className="loop-input" type="datetime-local" name="requestedReturnAt" />
                  </label>
                  <p className="loop-note" style={{ margin: 0 }}>
                    {active ? `Continues Production ${active.number}.` : `Starts Production ${record!.productions.length + 1} on this content.`}
                  </p>
                  <div className="loop-btnrow"><button className="loop-btn" type="submit">Relay feedback</button></div>
                </form>
              )}
            </Panel>
          </>
        }
        rail={
          <>
            <Panel title="Where it fits">
              <Facts
                rows={[
                  { label: 'Campaign', value: ctx.campaign ? `${ctx.campaign.name} · ${ctx.campaign.state.toLowerCase()}${ctx.campaign.brandLabel ? ` · ${ctx.campaign.brandLabel}` : ''}` : null, unknownText: 'Independent content' },
                  { label: 'Deliverable', value: ctx.deliverable ? `${ctx.deliverable.title} · ${ctx.deliverable.line}${ctx.deliverable.dueAt ? ` · due ${time.dateTime(ctx.deliverable.dueAt)}` : ''}${ctx.deliverable.acceptsUnedited ? ' · accepts an unedited original' : ''}` : null, unknownText: 'None' },
                  { label: 'Opportunity', value: ctx.opportunity ? `${ctx.opportunity.title}${ctx.opportunity.label ? ` · creator sees: ${ctx.opportunity.label}` : ' · not shown to the creator'}` : null, unknownText: 'None' },
                ]}
              />
              <p className="loop-label" style={{ margin: '12px 0 6px' }}>{ctx.deliverable ? `Needed for ${ctx.deliverable.title}` : 'Needed'}</p>
              <ul className="loop-stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 4 }}>
                {record!.requirementStatuses.map((r) => (
                  <li key={r.key}>
                    {r.met ? <Pill tone="good">Met</Pill> : <Pill tone="neutral">Not yet</Pill>} {r.label.replace('Your approval', 'Creator approval')}
                    {r.met ? <span className="loop-note"> · {r.by ?? ''}{r.versionLabel ? ` on ${r.versionLabel}` : ''}{r.at ? ` · ${time.dateTime(r.at)}` : ''}</span> : null}
                  </li>
                ))}
              </ul>
              <p className="loop-note">{ctx.deliverable ? 'From the campaign’s deliverable, not from any production.' : 'Independent content: only the creator’s own approval is owed.'}</p>
            </Panel>

            <Panel title="What Loop noticed">
              {notice.rungs.length === 0 ? (
                <p className="loop-note">Nothing to notice yet.</p>
              ) : (
                <ul className="loop-stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6 }}>
                  {notice.rungs.map((r, i) => (
                    <li key={i}>
                      <Pill tone={r.rung === 'FACT' ? 'neutral' : r.rung === 'NOT_YET' ? 'neutral' : r.rung === 'PROPOSED' ? 'attention' : 'info'}>{r.rung.toLowerCase().replace('_', ' ')}</Pill> {r.text}
                      <div className="loop-note">
                        {r.source}
                        {r.observedAt ? ` · ${time.dateTime(r.observedAt)}` : ''}
                        {typeof r.sample === 'number' ? ` · sample of ${r.sample}` : ''}
                        {r.restsOn ? ` · rests on: ${r.restsOn}` : ''}
                        {r.limitations && r.limitations.length ? ` · ${r.limitations.join('; ')}` : ''}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {notice.seeded ? <p className="loop-note">Some of this rests on seeded demo data, labelled as such.</p> : null}
            </Panel>

            <Panel title="Creator">
              <p className="loop-note">
                <Link className="loop-link" href={EMG_HREFS.creator(record!.creator.profileId)}>{record!.creator.displayName}</Link>
                {' · '}
                <Link className="loop-link" href={`/app/crm/people/${encodeURIComponent(record!.creator.partyId)}`}>Person record</Link>
              </p>
              <p className="loop-note">{record!.creator.userId ? 'Has a creator login.' : 'No login yet: the creator cannot sign in to review.'}</p>
            </Panel>
          </>
        }
      />
    </LoopPage>
  );
}
