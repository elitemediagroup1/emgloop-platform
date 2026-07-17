import Link from 'next/link';
import { loadOrFallback, DbNotConfigured } from '../../../demo/db-health';
import { requireCrmContext } from '../../../crm/crm-data';
import { requirePermission } from '../../../auth/guard';
import {
  loadProviderCards,
  computeSystemHealth,
  connectionLabel,
  healthLabel,
  relativeTime,
  type ProviderCard,
} from '../../../crm/integration-os';

// Integration OS  -  Sprint 16 (The Connection Layer).
//
// The admin operations console for every external system. Replaces the static
// Sprint 10 integrations page with a provider-agnostic operating center driven
// entirely by the integration catalog + live status engine. Monitoring only  - 
// no credentials are entered or displayed here.

export const dynamic = 'force-dynamic';

function pctClass(p: number): string {
  if (p >= 80) return 'good';
  if (p >= 50) return 'warn';
  return 'bad';
}

function Card({ card }: { card: ProviderCard }) {
  const { spec, status } = card;
  return (
    <div className="ios-card">
      <div className="ios-card-head">
        <div>
          <div className="ios-card-name">{spec.displayName}</div>
          <div className="ios-card-cat">{spec.category}</div>
        </div>
        <span className={'ios-badge ' + status.connection}>
          <span className="ios-dot" />{connectionLabel(status.connection)}
        </span>
      </div>
      <div className="ios-card-blurb">{spec.blurb}</div>
      <div className="ios-card-meta">
        <div><span className="k">Health</span><span className="v">{healthLabel(status.health)}</span></div>
        <div><span className="k">Last Event</span><span className="v">{relativeTime(status.lastEvent ? status.lastEvent.receivedAt : null)}</span></div>
        <div><span className="k">Events Today</span><span className="v">{status.eventsToday}</span></div>
        <div><span className="k">Retry Queue</span><span className="v">{status.retryQueueDepth}</span></div>
        <div><span className="k">Auth</span><span className="v">{status.authVerified ? 'Verified' : 'Pending'}</span></div>
        <div><span className="k">Direction</span><span className="v">{spec.direction}</span></div>
      </div>
      <div className="ios-card-head">
        <span className={'ios-readiness ' + spec.readiness}>{spec.readiness.replace('_', ' ')}</span>
        <Link className="crm-btn-sm" href={'/crm/integrations/' + spec.id}>Open Setup</Link>
      </div>
    </div>
  );
}

export default async function IntegrationOsPage() {
  await requirePermission('integrations', 'view');
  const { organizationId } = await requireCrmContext();

  const result = await loadOrFallback(async () => {
    const cards = await loadProviderCards(organizationId);
    return { cards, health: computeSystemHealth(cards) };
  });

  if (!result.ok || !result.data) {
    return (
      <>
        <h1 className="crm-h1">Integration OS</h1>
        <DbNotConfigured />
      </>
    );
  }

  const { cards, health } = result.data;
  const groups: { label: string; ids: string[] }[] = [
    { label: 'Ingestion', ids: ['callgrid', 'website'] },
    { label: 'Analytics & Advertising', ids: ['ga4', 'google_ads', 'google_search_console', 'microsoft_clarity', 'meta'] },
    { label: 'Messaging & AI', ids: ['twilio', 'openai', 'anthropic', 'elevenlabs'] },
  ];

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <h1 className="crm-h1">Integration OS</h1>
          <p className="crm-sub">
            Connect, monitor, diagnose and manage every external system from one
            console. Configuration only  -  no secret values are ever displayed.
          </p>
        </div>
      </div>

      <div className="ios-tabs">
        <Link className="ios-tab active" href="/crm/integrations">Connections</Link>
        <Link className="ios-tab" href="/crm/integrations/assistant">Setup Assistant</Link>
        <Link className="ios-tab" href="/crm/integrations/secrets">Secret Status</Link>
        <Link className="ios-tab" href="/crm/integrations/website">Website Manager</Link>
      </div>

      <div className="ios-health-bar">
        <div className="ios-health-overall">
          <span className={'ios-health-pct ' + pctClass(health.overallPercent)}>{health.overallPercent}%</span>
          <span className="ios-health-stat"><span className="lbl">Overall</span></span>
        </div>
        <div className="ios-health-stat"><span className="num">{health.connected}</span><span className="lbl">Connected</span></div>
        <div className="ios-health-stat"><span className="num">{health.needsSetup}</span><span className="lbl">Needs Setup</span></div>
        <div className="ios-health-stat"><span className="num">{health.errors}</span><span className="lbl">Errors</span></div>
        <div className="ios-health-stat"><span className="num">{health.warnings}</span><span className="lbl">Warnings</span></div>
      </div>

      {health.missingItems.length > 0 ? (
        <div className="ios-missing">
          {health.missingItems.map((m, i) => (
            <span key={i} className="ios-missing-chip">{m}</span>
          ))}
        </div>
      ) : null}

      <div className="ios-assistant">
        <div className="prompt">&gt; Connect a provider...</div>
        <div className="reply">
          Tell the assistant which system to connect (e.g. <strong>Connect CallGrid</strong>
          {' '}or <strong>Connect ServicesInMyCity</strong>) and it will generate the webhook,
          required events, secret checklist and verification steps. {' '}
          <Link className="crm-link" href="/crm/integrations/assistant">Open the Setup Assistant</Link>.
        </div>
      </div>

      {groups.map((g) => {
        const groupCards = g.ids
          .map((id) => cards.find((c) => c.spec.id === id))
          .filter((c): c is ProviderCard => Boolean(c));
        if (groupCards.length === 0) return null;
        return (
          <div key={g.label} style={{ marginBottom: '1.75rem' }}>
            <h2 className="crm-h2" style={{ marginBottom: '0.85rem' }}>{g.label}</h2>
            <div className="ios-grid">
              {groupCards.map((c) => (<Card key={c.spec.id} card={c} />))}
            </div>
          </div>
        );
      })}
    </>
  );
}
