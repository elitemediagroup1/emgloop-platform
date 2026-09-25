// Intelligence execution status -- the view. A server component over the loader's projection;
// it reads nothing and decides nothing. Every section says when its read failed or is not exposed,
// and a figure no run reported is words, never 0.

import type { ReactNode } from 'react';
import { intelligenceCoverageLabel, isIntelligenceCoverage, type TimeView } from '@emgloop/shared';
import { LabelBadge } from '../../_loop-os/product-state';
import { Panel, StateBlock } from '../../_loop-os/record';
import { num } from '../../_loop-os/format';
import {
  STATUS_WINDOWS,
  type CapacityStatus,
  type DigestCount,
  type DigestMetadata,
  type FabricStatus,
  type IntelligenceStatus,
  type ProviderPolicyRow,
  type Section,
  type TaskStatus,
  type TaskWindowStatus,
} from './status';

const NOT_RECORDED = 'Not recorded';

function dollarsFromMicros(micros: number): string {
  const dollars = micros / 1_000_000;
  return dollars < 0.01 && dollars > 0 ? '< $0.01' : '$' + dollars.toFixed(2);
}

function SectionState<T>({ section, what, children }: { section: Section<T>; what: string; children: (value: T) => ReactNode }) {
  if (section.state === 'UNAVAILABLE') {
    return <StateBlock kind="error" compact title={`Loop could not read ${what} just now`} body="This is a failure to read, not a finding: it does not mean there is nothing. Try again shortly." />;
  }
  if (section.state === 'NOT_EXPOSED') {
    return <StateBlock kind="unavailable" compact title={`No read of ${what} is available to this page yet`} body="The authority that owns this data does not yet offer a read this page may use, so nothing was read and nothing is shown." />;
  }
  return <>{children(section.value)}</>;
}

function WindowCell({ w, time }: { w: TaskWindowStatus; time: TimeView }) {
  if (w.runs === 0) return <span className="loop-table__muted">No runs</span>;
  return (
    <span>
      <span className="loop-table__strong">{num(w.runs)} runs</span> · {num(w.answered)} answered
      {w.inFlight > 0 ? ` · ${num(w.inFlight)} in flight` : ''}
      {w.notAnswered.length > 0 ? (
        <>
          <br />
          Not answered: {w.notAnswered.map((f) => `${f.reason} ${num(f.runs)}`).join(', ')}
        </>
      ) : null}
      <br />
      <span className="loop-table__muted">Last {w.lastRunAt ? time.relative(w.lastRunAt) : NOT_RECORDED}</span>
    </span>
  );
}

function TaskRow({ t, time }: { t: TaskStatus; time: TimeView }) {
  const week = t.windows['7d'];
  return (
    <tr data-status-task={t.taskId}>
      <td data-label="Task">
        <span className="loop-table__strong">{t.name}</span>
        <br />
        <span className="loop-table__muted">{t.taskId}</span>
      </td>
      {STATUS_WINDOWS.map((w) => (
        <td key={w.key} data-label={w.label}>
          <WindowCell w={t.windows[w.key]} time={time} />
        </td>
      ))}
      <td data-label="Latest route">{t.latestRoute ? `${t.latestRoute.providerId} · ${t.latestRoute.servedModel ?? t.latestRoute.model}` : <span className="loop-table__muted">No run in 7 days</span>}</td>
      <td data-label="Median latency (7 days)">{week.medianLatencyMs === null ? <span className="loop-table__muted">{NOT_RECORDED}</span> : `${num(week.medianLatencyMs)} ms`}</td>
      <td data-label="Tokens (7 days)">
        {week.tokens === null ? (
          <span className="loop-table__muted">{NOT_RECORDED}</span>
        ) : (
          <>
            {num(week.tokens.input)} in · {num(week.tokens.output)} out
            <br />
            <span className="loop-table__muted">reported by {num(week.tokens.reported)} of {num(week.runs)} runs</span>
          </>
        )}
      </td>
      <td data-label="Reserved cost estimate (7 days)">
        {week.reservedCostMicros === null ? (
          <span className="loop-table__muted">{NOT_RECORDED}</span>
        ) : (
          <>
            {dollarsFromMicros(week.reservedCostMicros.total)}
            <br />
            <span className="loop-table__muted">estimate reserved for {num(week.reservedCostMicros.recorded)} runs; not the cost of record</span>
          </>
        )}
      </td>
      <td data-label="Your runs">
        {num(t.windows['24h'].yours)} today · {num(week.yours)} in 7 days
        {t.yourLastRunAt ? (
          <>
            <br />
            <span className="loop-table__muted">Last {time.relative(t.yourLastRunAt)}</span>
          </>
        ) : null}
      </td>
    </tr>
  );
}

function ProviderRow({ p, time }: { p: ProviderPolicyRow; time: TimeView }) {
  const state = p.state === 'ACTIVE' ? 'Approved' : p.state === 'KILLED' ? 'Stopped' : 'No policy recorded';
  return (
    <tr data-status-provider={p.providerId}>
      <td data-label="Provider"><span className="loop-table__strong">{p.providerId}</span></td>
      <td data-label="Policy">{state}</td>
      <td data-label="Highest data class">{p.ceiling ?? <span className="loop-table__muted">{p.state === 'NOT_RECORDED' ? 'None — Loop sends this provider nothing' : NOT_RECORDED}</span>}</td>
      <td data-label="Version">{p.version === null ? <span className="loop-table__muted">—</span> : `v${p.version}`}</td>
      <td data-label="Recorded">{p.recordedAt ? time.dateTime(p.recordedAt) : <span className="loop-table__muted">—</span>}</td>
    </tr>
  );
}

function CoverageBadge({ coverage }: { coverage: string }) {
  return isIntelligenceCoverage(coverage) ? <LabelBadge label={intelligenceCoverageLabel(coverage)} /> : <span>{coverage}</span>;
}

function DigestRow({ d, time }: { d: DigestMetadata; time: TimeView }) {
  return (
    <tr data-status-digest={d.domain}>
      <td data-label="Domain"><span className="loop-table__strong">{d.domain}</span> · {d.subjectKind}</td>
      <td data-label="Coverage"><CoverageBadge coverage={d.coverage} /></td>
      <td data-label="Status">{d.status}</td>
      <td data-label="Generated">{time.dateTime(d.generatedAt)}</td>
      <td data-label="Evidence up to">{time.dateTime(d.windowEnd)}</td>
      <td data-label="Evidence">{num(d.evidenceCount)}</td>
      <td data-label="Version">v{d.version}</td>
      <td data-label="Expires">{time.dateTime(d.expiresAt)}</td>
    </tr>
  );
}

function CountRow({ c }: { c: DigestCount }) {
  return (
    <tr data-status-digest-count={c.domain}>
      <td data-label="Domain">{c.domain}</td>
      <td data-label="Status">{c.status}</td>
      <td data-label="Coverage"><CoverageBadge coverage={c.coverage} /></td>
      <td data-label="Digests">{num(c.count)}</td>
    </tr>
  );
}

const LANE_LABEL: Record<CapacityStatus['lanes'][number]['lane'], string> = {
  FORWARD: 'Live (new messages)',
  SYNTHESIS: 'Readings, situations, briefing',
  INTERACTIVE: 'Requested by a person',
  BACKGROUND: 'Background catch-up',
};

function CapacityView({ c, time }: { c: CapacityStatus; time: TimeView }) {
  const budget =
    c.budget.state === 'RECORDED'
      ? `Operating budget ${c.budget.label} (version ${c.budget.version}), recorded ${time.dateTime(c.budget.recordedAt)}.`
      : c.budget.state === 'UNREADABLE'
        ? 'The recorded operating budget cannot be read, so Loop refuses every AI call until corrected figures are recorded.'
        : 'No operating budget is recorded. Loop admits against the reviewed budget policy, plus the emergency ceiling.';
  return (
    <>
      <p className="loop-panel__lead">{budget}</p>
      <table className="loop-table" aria-label="AI spend by lane today">
        <thead>
          <tr>
            <th>Lane</th>
            <th>Spent today</th>
            <th>Daily cap</th>
            <th>Calls today</th>
            <th>Call cap</th>
          </tr>
        </thead>
        <tbody>
          {c.lanes.map((l) => (
            <tr key={l.lane}>
              <td>{LANE_LABEL[l.lane]}</td>
              <td>{dollarsFromMicros(l.spentMicros)}</td>
              <td>{l.capMicros === null ? <span className="loop-table__muted">No lane cap</span> : dollarsFromMicros(l.capMicros)}</td>
              <td>{num(l.invocations)}</td>
              <td>{l.callCap === null ? <span className="loop-table__muted">None</span> : num(l.callCap)}</td>
            </tr>
          ))}
          <tr>
            <td>
              <strong>Organization today</strong>
            </td>
            <td>
              <strong>{dollarsFromMicros(c.organizationSpentMicros)}</strong>
            </td>
            <td>
              {c.organizationCapMicros === null ? (
                <span className="loop-table__muted">No cost cap</span>
              ) : (
                <>
                  {dollarsFromMicros(c.organizationCapMicros)}
                  {c.forwardReserveMicros ? <span className="loop-table__muted"> (incl. {dollarsFromMicros(c.forwardReserveMicros)} live reserve)</span> : null}
                </>
              )}
            </td>
            <td colSpan={2} />
          </tr>
          <tr>
            <td>Trailing 24 hours (this organization)</td>
            <td>{dollarsFromMicros(c.trailingDayMicros)}</td>
            <td>{dollarsFromMicros(c.emergencyCapMicros)} emergency ceiling</td>
            <td colSpan={2} />
          </tr>
        </tbody>
      </table>
      {c.storedKills.length === 0 ? (
        <p className="loop-panel__lead">No recorded stop applies here.</p>
      ) : (
        <p className="loop-panel__lead">
          Recorded stops in force: {c.storedKills.map((k) => (k.value ? `${k.scope} ${k.value}` : k.scope)).join(', ')}.
        </p>
      )}
    </>
  );
}

function FabricView({ f, time }: { f: FabricStatus; time: TimeView }) {
  return (
    <>
      <p className="loop-panel__lead">
        {f.totals.producers === 0 ? 'No domain producer is built into this release yet' : `${num(f.totals.producers)} producers known to this release`}
        {' · '}
        {f.queueMigrated ? `${num(f.totals.queued)} refreshes queued · ${num(f.totals.held)} held` : 'The refresh queue has not been migrated into this database yet'}
        {' · '}
        {num(f.totals.stale)} stale and {num(f.totals.error)} unreadable digests
      </p>
      <table className="loop-table" aria-label="Intelligence domains">
        <thead>
          <tr>
            <th>Domain</th>
            <th>Scope</th>
            <th>Lives on</th>
            <th>Reading</th>
            <th>Producers</th>
            <th>Digests</th>
            <th>Refresh queue</th>
          </tr>
        </thead>
        <tbody>
          {f.domains.map((d) => (
            <tr key={d.domain} data-fabric-domain={d.domain}>
              <td className="loop-table__strong">{d.label}</td>
              <td>{d.scopes.map((s) => (s === 'PRINCIPAL' ? 'Personal' : 'Organization')).join(' and ')}</td>
              <td>
                {d.surfaces.join(', ')}
                <br />
                <span className="loop-table__muted">{d.homeTile ? 'Home tile' : 'No Home tile'}</span>
              </td>
              <td>{d.readingTask ? taskLabel(d.readingTask) : <span className="loop-table__muted">No reading task</span>}</td>
              <td>{d.producers.length === 0 ? <span className="loop-table__muted">None built</span> : d.producers.map((p) => `${p.id} (${p.kind === 'RULE' ? 'rule' : 'model'})`).join(', ')}</td>
              <td>
                {d.digests ? (
                  <>
                    {num(d.digests.principal)} personal · {num(d.digests.organization)} organization
                    {d.digests.stale + d.digests.error > 0 ? (
                      <>
                        <br />
                        <span className="loop-table__muted">
                          {num(d.digests.stale)} stale · {num(d.digests.error)} unreadable
                        </span>
                      </>
                    ) : null}
                  </>
                ) : (
                  <span className="loop-table__muted">Could not read</span>
                )}
              </td>
              <td>
                {d.queue ? (
                  <>
                    {num(d.queue.pending)} pending · {num(d.queue.claimed)} running · {num(d.queue.held)} held
                    {d.queue.oldestPendingAt ? (
                      <>
                        <br />
                        <span className="loop-table__muted">Oldest requested {time.relative(d.queue.oldestPendingAt)}</span>
                      </>
                    ) : null}
                  </>
                ) : (
                  <span className="loop-table__muted">Not migrated</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function taskLabel(taskId: string): string {
  return taskId === 'telegram.content.triage' ? 'Telegram content triage' : taskId;
}

export function IntelligenceStatusView({ status, time }: { status: IntelligenceStatus; time: TimeView }) {
  return (
    <>
      <Panel
        title="AI capacity"
        lead="What this organization's AI work has cost today, by lane, against the recorded operating budget. Spent is what providers reported, or the reserve while a call is still running."
      >
        <SectionState section={status.capacity} what="AI capacity">
          {(c) => <CapacityView c={c} time={time} />}
        </SectionState>
      </Panel>

      <Panel
        title="AI tasks"
        lead="Every governed AI task, from the AI usage ledger. Organization totals only: no figure here says whose run it was, except your own. The ledger keeps no prompt and no response."
      >
        <SectionState section={status.tasks} what="the AI usage ledger">
          {(tasks) => (
            <>
              <table className="loop-table" aria-label="AI task runs">
                <thead>
                  <tr>
                    <th>Task</th>
                    {STATUS_WINDOWS.map((w) => (
                      <th key={w.key}>{w.label}</th>
                    ))}
                    <th>Latest route</th>
                    <th>Median latency (7 days)</th>
                    <th>Tokens (7 days)</th>
                    <th>Reserved cost estimate (7 days)</th>
                    <th>Your runs</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.rows.map((t) => (
                    <TaskRow key={t.taskId} t={t} time={time} />
                  ))}
                </tbody>
              </table>
              {tasks.latencySampled ? <p className="loop-panel__lead">Median latency is taken over the most recent runs only; the window held more.</p> : null}
            </>
          )}
        </SectionState>
      </Panel>

      <Panel title="Provider policies" lead="The recorded approval to send a class of data to each AI provider. With no policy recorded, Loop sends that provider nothing.">
        <SectionState section={status.providers} what="provider policies">
          {(rows) => (
            <table className="loop-table" aria-label="Provider policies">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Policy</th>
                  <th>Highest data class</th>
                  <th>Version</th>
                  <th>Recorded</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <ProviderRow key={p.providerId} p={p} time={time} />
                ))}
              </tbody>
            </table>
          )}
        </SectionState>
      </Panel>

      <Panel title="Your domain intelligence" lead="When Loop last generated each of your own digests, and how well it could see. Metadata only: what a digest says stays in the place it belongs to.">
        <SectionState section={status.yourDigests} what="your digests">
          {(rows) =>
            rows.length === 0 ? (
              <StateBlock kind="empty" compact title="No digests for you yet" body="Loop has not generated domain intelligence for you. That is not a reading of your sources." />
            ) : (
              <table className="loop-table" aria-label="Your digests">
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th>Coverage</th>
                    <th>Status</th>
                    <th>Generated</th>
                    <th>Evidence up to</th>
                    <th>Evidence</th>
                    <th>Version</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <DigestRow key={`${d.domain}:${d.subjectKind}:${d.generatedAt.toISOString()}`} d={d} time={time} />
                  ))}
                </tbody>
              </table>
            )
          }
        </SectionState>
      </Panel>

      <Panel
        title="Intelligence fabric"
        lead="Every domain Loop can hold intelligence about, what reads it, and whether readings are being refreshed. Counts only: never a subject, never whose, never what."
      >
        <SectionState section={status.fabric} what="the intelligence fabric">
          {(f) => <FabricView f={f} time={time} />}
        </SectionState>
      </Panel>

      <Panel title="Organization domain intelligence" lead="How many digests exist across the organization, by domain, status and coverage. Counts only: never whose, never what.">
        <SectionState section={status.organizationDigests} what="organization digest counts">
          {(rows) =>
            rows.length === 0 ? (
              <StateBlock kind="empty" compact title="No digests in this organization yet" body="Loop has not generated domain intelligence for anyone here." />
            ) : (
              <table className="loop-table" aria-label="Organization digest counts">
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th>Status</th>
                    <th>Coverage</th>
                    <th>Digests</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <CountRow key={`${c.scope ?? ''}:${c.domain}:${c.status}:${c.coverage}`} c={c} />
                  ))}
                </tbody>
              </table>
            )
          }
        </SectionState>
      </Panel>
    </>
  );
}
