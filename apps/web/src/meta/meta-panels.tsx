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

export async function MetaAnalyticsPanel({ principal, outcome, platform }: { principal: MetaPrincipal; outcome?: string; platform: 'FACEBOOK' | 'INSTAGRAM' }) {
  if (!readMetaEnvironment()) return null;
  try {
    const repository = metaRepository();
    const rows = await repository.observations(principal);
    const connection = await repository.status(principal);
    const ai = rows.length ? await repository.reading(principal, metaAnalyticsFingerprint(rows)) : null;
    const reading = ai?.reading as unknown as AiDomainReading | undefined;
    const time = viewerTime();
    const row = rows.find(item => (item.report as unknown as MetaReport).platform === platform);
    const name = platform === 'FACEBOOK' ? 'Facebook' : 'Instagram';

    const reportView = () => {
      if (!row) {
        const instagramMissing = platform === 'INSTAGRAM' && !!connection && !connection.instagramId;
        const notConnected = !connection || connection.status === 'DISCONNECTED';
        return <Panel title={name}>
          <StateBlock
            kind={notConnected ? 'unavailable' : instagramMissing ? 'attention' : 'empty'}
            compact
            title={notConnected ? name + ' analytics are not connected' : instagramMissing ? 'Instagram account not linked' : 'No Instagram report yet'}
            body={notConnected
              ? 'Connect this account from Profile to fetch its analytics.'
              : instagramMissing
                ? 'Link a professional Instagram account to the connected Page. Facebook analytics can still be viewed separately.'
                : 'Refresh to fetch the latest available Meta report.'}
          />
        </Panel>;
      }

      const report = row.report as unknown as MetaReport;
      const viewsName = platform === 'INSTAGRAM' ? 'views' : 'post_media_view';
      const viewsMetric = report.metrics.find(metric => metric.name === viewsName);
      const engagementMetric = report.metrics.find(metric => metric.name === 'total_interactions' || metric.name === 'page_post_engagements');
      const measured = report.media
        .map(media => ({ ...media, views: media.metrics.find(metric => metric.name === viewsName)?.value ?? null }))
        .filter((media): media is typeof media & { views: number } => media.views !== null)
        .sort((a,b) => b.views - a.views);
      const sorted = measured.map(media => media.views).sort((a,b) => a-b);
      const middle = Math.floor(sorted.length / 2);
      const median = sorted.length ? sorted.length % 2 ? sorted[middle]! : (sorted[middle-1]! + sorted[middle]!)/2 : null;
      const metric = (label: string, value: number | null | undefined) => (
        <div key={label}><span>{label}</span><strong>{value == null ? 'Not reported' : value.toLocaleString('en-US')}</strong></div>
      );

      return <Panel title={name}>
        <div className="ch-meta-report">
          <div className="ch-meta-report__heading">
            <h3>{report.name}</h3>
            <span>Updated {time.dateTime(row.observedAt.toISOString())} · {time.date(report.windowStart)}–{time.date(report.windowEnd)}</span>
          </div>
          <div className="ch-snapshot__metrics ch-snapshot__metrics--meta">
            {metric('Followers', report.followers)}
            {metric('Views', viewsMetric?.value)}
            {metric(platform === 'INSTAGRAM' ? 'Interactions' : 'Post engagements', engagementMetric?.value)}
          </div>
          {measured.length ? (
            <section className="ch-meta-posts" aria-label={name + ' recent content'}>
              <div className="ch-meta-posts__heading">
                <h4>Recent content</h4>
                <span>{measured.length} posts with view counts</span>
              </div>
              <p className="ch-meta-posts__median">{median === null ? 'Median not available' : 'Median lifetime views: ' + median.toLocaleString('en-US')}</p>
              <ol>{measured.slice(0, 6).map(media => (
                <li key={media.id}>
                  <span>{safePostUrl(media.permalink) ? <a href={media.permalink!} target="_blank" rel="noreferrer noopener">{media.type}</a> : media.type}</span>
                  <strong>{media.views.toLocaleString('en-US')} views</strong>
                  {media.publishedAt && Number.isFinite(Date.parse(media.publishedAt)) ? <time>{time.date(media.publishedAt)}</time> : null}
                </li>
              ))}</ol>
              {measured.length >= 2 && median !== null && median > 0 ? (
                <p className="ch-meta-posts__note">Your leading post has {(measured[0]!.views / median).toFixed(1)}× the median lifetime views in this sample. Post age and distribution differ, so this does not show what caused the result.</p>
              ) : null}
            </section>
          ) : null}
          <details className="ch-meta-notes">
            <summary>About this report</summary>
            <ul>{report.limitations.map(text => <li key={text}>{text}</li>)}</ul>
          </details>
        </div>
      </Panel>;
    };

    const statusText = outcome === 'ANALYZED' ? 'Analysis updated.' : outcome === 'UNCHANGED' ? 'Analysis is already current.' : outcome === 'SYNCED' ? 'Latest available data fetched.' : outcome === 'NOT_DUE' ? 'No refresh was due yet.' : outcome ? 'Refresh result: ' + outcome.replace(/_/g, ' ').toLowerCase() + '.' : null;

    return <div className="ch-meta-analytics">
      <div className="ch-meta-actions" aria-label={name + ' analytics actions'}>
        <form action={refreshMetaAction}><button className="loop-btn loop-btn--primary" type="submit">Refresh Meta data</button></form>
        {rows.length ? <form action={analyzeMetaAction}><button className="loop-btn" type="submit">Analyze with Loop AI</button></form> : null}
        {statusText ? <p role="status">{statusText}</p> : null}
      </div>
      {reading && ai ? (
        <details className="ch-meta-ai">
          <summary>Loop AI reading <span>Based on the latest stored Meta observations</span></summary>
          <div>
            <p>{reading.reading.statement}</p>
            <ul>{reading.signals.map(signal => <li key={signal.key}>{signal.statement} <small>({signal.knowledge.toLowerCase()})</small></li>)}</ul>
            <ul className="ch-meta-ai__limits">{reading.limitations.map(text => <li key={text}>{text}</li>)}</ul>
            <p className="ch-meta-ai__date">Analyzed {time.dateTime(ai.observedAt.toISOString())}.</p>
          </div>
        </details>
      ) : null}
      {reportView()}
    </div>;
  } catch {
    return <Panel title={platform === 'FACEBOOK' ? 'Facebook' : 'Instagram'}><StateBlock kind="error" compact title="Could not read Meta analytics" body="Stored evidence could not be loaded. This does not mean there are zero views or followers." /></Panel>;
  }
}
function safePostUrl(value: string | null): boolean {
  if (!value) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && ['instagram.com', 'www.instagram.com', 'facebook.com', 'www.facebook.com'].includes(url.hostname); } catch { return false; }
}
