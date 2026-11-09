import { metaAnalyticsFingerprint, type MetaPrincipal } from '@emgloop/database';
import type { AiDomainReading } from '@emgloop/shared';
import type { MetaReport } from '@emgloop/providers';
import { getSessionBinding } from '../auth/auth';
import { viewerTime } from '../time/viewer-time';
import { Panel, StateBlock, Facts } from '../app/app/_loop-os/record';
import { metaRepository, metaService } from './meta-runtime';
import { readMetaEnvironment } from './meta-environment';
import { selectMetaAccountAction, disconnectMetaAction, refreshMetaAction, analyzeMetaAction } from './actions';
import { metaConnectionMessage, metaDiagnosticLabel, metaFailureReference } from './meta-errors';

const metricLabel: Record<string, string> = { views: 'Views', reach: 'Reach', total_interactions: 'Interactions', page_media_view: 'Views', page_post_engagements: 'Post engagements', post_media_view: 'Views' };
export async function MetaConnectionPanel({ principal, outcome, reference, diagnostic }: { principal: MetaPrincipal; outcome?: string; reference?: string; diagnostic?: { stage?: string; failure?: string; invalidResponse?: string; httpStatus?: string; graphCode?: string; graphSubcode?: string } }) {
  const configured = !!readMetaEnvironment();
  if (!configured) return <Panel title="Instagram & Facebook"><StateBlock kind="unavailable" compact title="Awaiting Meta setup" body="EMG is completing the app configuration and Meta review. You will be able to authorize your Facebook Page and linked professional Instagram account here." /></Panel>;
  try {
    const service = metaService();
    const status = await metaRepository().status(principal);
    const bound = await getSessionBinding();
    const choices = bound ? await service.choices(principal, bound.sessionId) : [];
    const time = viewerTime();
    const hasFixedTokenExpiry = status ? status.tokenExpiresAt.getUTCFullYear() < 9999 : true;
    const message = metaConnectionMessage(outcome, status ? !!status.instagramId : undefined);
    const failureReference = metaFailureReference(reference);
    const diagnosticLabel = diagnostic ? metaDiagnosticLabel(diagnostic) : null;
    return <Panel title="Instagram & Facebook">
      <p className="loop-note">Connect your Facebook Page and its linked Instagram Business or Creator account. Loop reads profile and content analytics for your Creator Hub.</p>
      {message ? <p role="status">{message}</p> : null}
      {failureReference ? <p className="loop-note">EMG support reference: {failureReference}</p> : null}
      {diagnosticLabel ? <p className="loop-note">Safe diagnostic: {diagnosticLabel}</p> : null}
      {choices.length ? <form action={selectMetaAccountAction} className="ch-form"><label className="loop-field"><span className="loop-label">Your Page</span><select className="loop-input" name="pageId" required>{choices.map(p => <option key={p.id} value={p.id}>{p.name}{p.hasInstagram ? ' · Instagram linked' : ' · Facebook only'}</option>)}</select></label><button className="loop-btn loop-btn--primary" type="submit">Connect selected account</button></form> : outcome === 'SELECT_ACCOUNT' ? <StateBlock kind="attention" compact title="No eligible Page returned" body="Confirm you have analytics access to the Page and selected it during Meta consent. Instagram must be a professional account linked to that Page for this connection." /> : null}
      {status && status.status !== 'DISCONNECTED' ? <>
        {outcome && !['CONNECTED', 'SELECT_ACCOUNT'].includes(outcome) ? <p className="loop-note">The saved connection below is from an earlier authorization. This attempt did not replace it.</p> : null}
        <Facts rows={[{ label: 'Page', value: status.pageName }, { label: 'Instagram', value: status.instagramId ? 'Linked professional account' : 'No linked account' }, { label: 'Connection', value: hasFixedTokenExpiry && +status.tokenExpiresAt <= Date.now() ? 'Reconnect required' : status.status.replace(/_/g, ' ').toLowerCase() }, { label: 'Last fetched', value: status.lastSyncedAt ? time.dateTime(status.lastSyncedAt.toISOString()) : 'Not fetched yet' }, { label: 'Authorization expires', value: hasFixedTokenExpiry ? time.dateTime(status.tokenExpiresAt.toISOString()) : 'No fixed expiry' }]} />
        {status.lastFailure ? <p role="status">Latest refresh: {status.lastFailure.replace(/_/g, ' ').toLowerCase()}. Previous observations keep their original timestamp.</p> : null}
        <div className="loop-btnrow"><a className="loop-btn" href="/api/integrations/meta/connect">Reconnect</a><form action={disconnectMetaAction}><button className="loop-btn" type="submit">Disconnect Instagram & Facebook</button></form></div>
      </> : <a className="loop-btn loop-btn--primary" href="/api/integrations/meta/connect">Connect Instagram & Facebook</a>}
      <p className="loop-note">You can stop collection here or remove EMG Loop in Meta’s Business Integrations settings. Existing Loop sign-in stays linked to your creator invitation.</p>
    </Panel>;
  } catch { return <Panel title="Instagram & Facebook"><StateBlock kind="attention" compact title="Connection status unavailable" body="EMG Loop could not check the connection. Try again later or contact EMG." /></Panel>; }
}

export async function MetaAnalyticsPanel({ principal, outcome }: { principal: MetaPrincipal; outcome?: string }) {
  if (!readMetaEnvironment()) return null;
  try {
    const rows = await metaRepository().observations(principal);
    const ai = rows.length ? await metaRepository().reading(principal, metaAnalyticsFingerprint(rows)) : null;
    const reading = ai?.reading as unknown as AiDomainReading | undefined;
    const time = viewerTime();
    return <Panel title="Instagram & Facebook performance">
      <p className="loop-note">Automatically checked about every 15 minutes when background collection is enabled. Meta determines when insights update. Each card is the latest stored reading of 28 complete UTC days; overlapping readings are never added together.</p>
      <form action={refreshMetaAction}><button className="loop-btn" type="submit">Refresh Meta analytics</button></form>
      {rows.length ? <form action={analyzeMetaAction}><button className="loop-btn" type="submit">Analyze latest data with Loop AI</button></form> : null}
      {reading && ai ? <section className="loop-stack" aria-label="Loop AI performance analysis"><h3>Loop AI analysis</h3><p>{reading.reading.statement}</p><ul>{reading.signals.map(signal => <li key={signal.key}>{signal.statement} <small>({signal.knowledge.toLowerCase()})</small></li>)}</ul><ul className="loop-note">{reading.limitations.map(text => <li key={text}>{text}</li>)}</ul><p className="loop-note">Analyzed {time.dateTime(ai.observedAt.toISOString())}. Based on the stored Meta observations shown below. This interpretation is not a guarantee of future performance.</p></section> : rows.length ? <p className="loop-note">Loop has not produced an AI reading of these observations yet. Try Analyze latest data, or check back after processing.</p> : null}
      {outcome ? <p role="status">{outcome === 'ANALYZED' ? 'AI analysis updated.' : outcome === 'UNCHANGED' ? 'The existing AI analysis already covers this data.' : outcome === 'SYNCED'  ? 'Latest available data fetched.' : outcome === 'NOT_DUE' ? 'No refresh was due. Refreshes are limited to once every 15 minutes.' : `Refresh result: ${outcome.replace(/_/g, ' ').toLowerCase()}.`}</p> : null}
      {!rows.length ? <StateBlock kind="empty" compact title="No Meta analytics read yet" body="Connect your account from Profile, then refresh here. No metrics are estimated." /> : rows.map(row => {
        const report = row.report as unknown as MetaReport;
        const viewsName = report.platform === 'INSTAGRAM' ? 'views' : 'post_media_view';
        const measured = report.media.map(m => ({ ...m, views: m.metrics.find(metric => metric.name === viewsName)?.value ?? null })).filter((m): m is typeof m & { views: number } => m.views !== null).sort((a,b) => b.views - a.views);
        const sorted = measured.map(m => m.views).sort((a,b) => a-b);
        const middle = Math.floor(sorted.length/2);
        const median = sorted.length ? sorted.length % 2 ? sorted[middle]! : (sorted[middle-1]! + sorted[middle]!)/2 : null;
        return <section key={row.id} aria-label={`${report.platform} analytics`} className="loop-stack" style={{ marginTop: 24 }}>
          <h3>{report.platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook'} · {report.name}</h3>
          <p className="loop-note">Fetched {time.dateTime(row.observedAt.toISOString())} · Reporting {time.date(report.windowStart)} to {time.date(report.windowEnd)} (end exclusive).</p>
          <Facts rows={[{ label: 'Followers', value: report.followers?.toLocaleString('en-US') ?? 'Not reported' }, ...report.metrics.map(m => ({ label: metricLabel[m.name] ?? m.name, value: m.value === null ? 'Unavailable from Meta' : m.value.toLocaleString('en-US') })), { label: 'Median lifetime views in recent sample', value: median === null ? 'Not reported' : `${median.toLocaleString('en-US')} across ${sorted.length} measured posts` }]} />
          <h4>Recent content by lifetime views</h4>
          {measured.length ? <ol>{measured.map(m => <li key={m.id}>{safePostUrl(m.permalink) ? <a href={m.permalink!} target="_blank" rel="noreferrer noopener">{m.type}</a> : m.type} · {m.views.toLocaleString('en-US')} views{m.publishedAt && Number.isFinite(Date.parse(m.publishedAt)) ? ` · ${time.date(m.publishedAt)}` : ''}</li>)}</ol> : <p>No content with measured views in this sample.</p>}
          {measured.length >= 2 && median !== null && median > 0 ? <p>Sample analysis: your leading measured post has {(measured[0]!.views / median).toFixed(1)}× the median lifetime views in this sample. Compare its opening, topic and format with the other posts. Post age and distribution differ; this does not establish what caused the result.</p> : <p>More measured posts are needed for a comparison.</p>}
          <ul className="loop-note">{report.limitations.map(s => <li key={s}>{s}</li>)}</ul>
        </section>;
      })}
    </Panel>;
  } catch { return <Panel title="Instagram & Facebook performance"><StateBlock kind="error" compact title="Could not read Meta analytics" body="Stored evidence could not be loaded. This does not mean there are zero views or followers." /></Panel>; }
}
function safePostUrl(value: string | null): boolean {
  if (!value) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && ['instagram.com', 'www.instagram.com', 'facebook.com', 'www.facebook.com'].includes(url.hostname); } catch { return false; }
}
