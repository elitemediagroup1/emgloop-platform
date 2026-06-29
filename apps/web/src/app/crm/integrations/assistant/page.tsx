import Link from 'next/link';
import { requirePermission } from '../../../../auth/guard';
import { ensureLiveOrganization } from '../../../../crm/live-org';
import { loadOrFallback, DbNotConfigured } from '../../../../demo/db-health';
import { loadProviderCard, webhookUrlFor, connectionLabel } from '../../../../crm/integration-os';
import { listProviders } from '@emgloop/brain';

// AI Setup Assistant — Sprint 16 (deterministic, no external AI).
//
// Type or click a 'Connect <provider>' intent; the assistant resolves it to a
// catalog provider and replies with the generated webhook, required events,
// secret checklist, authentication posture and live verification status. The
// resolver is a deterministic keyword match today — an LLM can be swapped in
// later without changing this UI contract.

export const dynamic = 'force-dynamic';

/** Deterministic intent resolver: map free text to a catalog provider id. */
function resolveProvider(query: string): string | null {
  const q = query.toLowerCase();
  const providers = listProviders();
  // Website properties resolve to the website provider.
  if (/website|servicesinmycity|inmycity|consumersupport|property|sdk/.test(q)) return 'website';
  for (const spec of providers) {
    if (q.includes(spec.id.replace(/_/g, ' ')) || q.includes(spec.displayName.toLowerCase())) {
      return spec.id;
    }
  }
  if (q.includes('call')) return 'callgrid';
  if (q.includes('analytics')) return 'ga4';
  if (q.includes('ads')) return 'google_ads';
  return null;
}

export default async function AssistantPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  await requirePermission('integrations', 'view');
  const { organizationId } = await ensureLiveOrganization();
  const query = (searchParams.q ?? '').trim();
  const providerId = query ? resolveProvider(query) : null;

  const result = await loadOrFallback(async () => {
    if (!providerId) return { card: null };
    const card = await loadProviderCard(organizationId, providerId);
    return { card };
  });

  const card = result.ok && result.data ? result.data.card : null;
  const suggestions = ['Connect CallGrid', 'Connect ServicesInMyCity', 'Connect Google Analytics', 'Connect Twilio'];

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <p className="crm-sub" style={{ marginBottom: '0.25rem' }}>
            <Link href="/crm/integrations" className="crm-link">Integration OS</Link> / Setup Assistant
          </p>
          <h1 className="crm-h1">AI Setup Assistant</h1>
          <p className="crm-sub">Describe what you want to connect. Deterministic today — no external AI required.</p>
        </div>
      </div>

      <form method="get" className="crm-form" style={{ display: 'flex', gap: '0.6rem', marginBottom: '1rem' }}>
        <input type="text" name="q" defaultValue={query} className="crm-input" style={{ flex: 1 }} placeholder="e.g. Connect CallGrid" />
        <button type="submit" className="crm-btn">Ask</button>
      </form>
      <div className="ios-tabs">
        {suggestions.map((s) => (
          <Link key={s} className="ios-tab" href={'/crm/integrations/assistant?q=' + encodeURIComponent(s)}>{s}</Link>
        ))}
      </div>

      {!result.ok ? <DbNotConfigured /> : null}

      {query && !card ? (
        <div className="ios-assistant">
          <div className="prompt">&gt; {query}</div>
          <div className="reply">I could not match that to a known provider. Try a name like CallGrid, EMG Websites, Google Analytics, Twilio, OpenAI or Anthropic.</div>
        </div>
      ) : null}

      {card ? (() => {
        const { spec, status } = card;
        const webhookUrl = webhookUrlFor(spec);
        const missing = status.missingRequiredSecrets;
        return (
          <div className="ios-assistant">
            <div className="prompt">&gt; {query || ('Connect ' + spec.displayName)}</div>
            <div className="reply">
              <p>Here is everything to connect <strong>{spec.displayName}</strong> ({connectionLabel(status.connection)}):</p>
              <ul>
                {webhookUrl ? (<li>Webhook generated — <code>POST {webhookUrl}</code></li>) : (<li>No webhook — this provider connects via {spec.delivery.join('/')}.</li>)}
                {spec.recommendedEvents ? (<li>Required events: {spec.recommendedEvents.map((e) => (<span key={e} className="ios-eventtag">{e}</span>))}</li>) : null}
                {spec.secrets.length ? (<li>Secret checklist: {spec.secrets.map((s) => (<span key={s.envVar}> <code>{s.envVar}</code>{status.secrets.find((x) => x.envVar === s.envVar && x.configured) ? ' ✓' : ' (missing)'}</span>))}</li>) : null}
                <li>Authentication: {spec.authentication} — {status.authVerified ? 'verified' : 'waiting for first event'}</li>
                <li>{missing.length === 0 ? 'All required secrets are configured.' : ('Configure these before going live: ' + missing.join(', '))}</li>
                <li>{status.lastEvent ? ('Last event received ' + status.lastEvent.receivedAt) : 'Waiting for first live event…'}</li>
              </ul>
              <p style={{ marginTop: '0.6rem' }}>
                <Link className="crm-btn-sm" href={'/crm/integrations/' + spec.id}>Open full setup &amp; monitoring →</Link>
              </p>
            </div>
          </div>
        );
      })() : null}
    </>
  );
}
