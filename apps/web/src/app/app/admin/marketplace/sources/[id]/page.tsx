// Source detail — a single traffic source's story, on the canonical EntityPage.
//
// This is the "understanding" page: who this source is, whether it is healthy,
// what changed vs the prior week, why it matters, what to do, the call-economics
// evidence, related dimensions, and history. Discovery ("what sources exist?")
// stays on the lightweight listing — the two never duplicate the story.

import { requireCrmContext } from '../../../../../../crm/crm-data';
import {
  EntityPage,
  money,
  num,
  type EntityPageModel,
  type EntityChange,
  type EntityEvidence,
  type EntityRelatedItem,
} from '../../../../_loop-os';
import { loadDimensionWindows, rowHealth } from '../../callgrid-dimensions';

export const dynamic = 'force-dynamic';

const OVERVIEW = '/app/admin/marketplace';

function deltaPct(cur: number, prior: number): string {
  if (prior <= 0) return '';
  const p = Math.round(((cur - prior) / prior) * 100);
  return ` (${p >= 0 ? '+' : ''}${p}%)`;
}

export default async function SourceDetailPage({ params }: { params: { id: string } }) {
  const { organizationId: org } = await requireCrmContext();
  const id = decodeURIComponent(params.id);

  const windows = org ? await loadDimensionWindows(org, 'sources') : null;
  const readFailed = !windows || !windows.current.ok;
  const row = windows?.current.rows.find((r) => r.key === id) ?? null;
  const priorRow = windows?.prior.rows.find((r) => r.key === id) ?? null;

  const label = row?.label || id;
  const rate = row && row.calls > 0 ? Math.round((row.monetized / row.calls) * 100) : 0;

  const health: EntityPageModel['health'] = readFailed
    ? { label: 'Unavailable', tone: 'crit', line: 'Loop could not reach this source’s data right now, so nothing here can be trusted yet.' }
    : rowHealth(row, 'This source');

  // Identity facts.
  const stats = row
    ? [
        { label: 'Revenue', value: money(row.revenueCents), hint: 'Last 7 days' },
        { label: 'Calls', value: num(row.calls) },
        { label: 'Margin', value: money(row.marginCents), tone: (row.marginCents < 0 ? 'crit' : 'good') as EntityPageModel['health']['tone'] },
        { label: 'Monetized', value: rate + '%', hint: num(row.monetized) + ' of ' + num(row.calls) },
      ]
    : undefined;

  // 3. What changed — this source vs the prior 7 days.
  const changes: EntityChange[] = [];
  if (row && priorRow) {
    changes.push({
      label: 'Revenue',
      direction: row.revenueCents >= priorRow.revenueCents ? 'up' : 'down',
      detail: money(row.revenueCents) + ' vs ' + money(priorRow.revenueCents) + ' prior' + deltaPct(row.revenueCents, priorRow.revenueCents),
    });
    changes.push({
      label: 'Calls',
      direction: row.calls >= priorRow.calls ? 'up' : 'down',
      detail: num(row.calls) + ' vs ' + num(priorRow.calls) + ' prior' + deltaPct(row.calls, priorRow.calls),
      tone: 'idle',
    });
    changes.push({
      label: 'Margin',
      direction: row.marginCents >= priorRow.marginCents ? 'up' : 'down',
      detail: money(row.marginCents) + ' vs ' + money(priorRow.marginCents) + ' prior',
    });
  }

  // 4. Why it matters.
  const whyItMatters = row
    ? `This source produced ${money(row.revenueCents)} across ${num(row.calls)} calls at ${money(row.marginCents)} margin over the last 7 days.`
    : undefined;

  // 5. What to do next — derived ONLY from unambiguous facts; the Brain's full
  // recommendations live on the Overview, linked rather than duplicated.
  const actions = [];
  if (row && row.marginCents < 0) {
    actions.push({
      title: 'Review this source’s economics',
      why: 'It is returning less than it costs right now — margin is negative.',
      href: OVERVIEW,
      cta: 'Open Intelligence',
    });
  } else if (row && row.calls > 0 && row.monetized / row.calls >= 0.5 && row.marginCents > 0) {
    actions.push({
      title: 'Consider giving this source more volume',
      why: 'It monetizes well at a positive margin — it may be worth scaling.',
      href: OVERVIEW,
      cta: 'Open Intelligence',
    });
  }

  // 6. Evidence — the call economics behind the story.
  const evidence: EntityEvidence[] = row
    ? [
        {
          label: 'Call economics · last 7 days',
          tone: row.marginCents < 0 ? 'crit' : 'good',
          facts: [
            { statement: 'Calls', value: num(row.calls) },
            { statement: 'Monetized', value: num(row.monetized), source: rate + '% of calls' },
            { statement: 'Converted', value: num(row.converted) },
            { statement: 'Revenue', value: money(row.revenueCents) },
            { statement: 'Payout', value: money(row.payoutCents) },
            { statement: 'Cost', value: money(row.costCents) },
            { statement: 'Margin', value: money(row.marginCents), source: 'revenue − payout − cost' },
          ],
          note: 'Margin is derived, never stored. Absent economics are excluded, not counted as zero.',
        },
      ]
    : [];

  // 7. Related dimensions.
  const related: EntityRelatedItem[] = [
    { icon: 'brain', title: 'CallGrid Overview', detail: 'The Brain’s full read across every source', href: OVERVIEW },
    { icon: 'flow', title: 'All sources', detail: 'Compare this source against the rest', href: '/app/admin/marketplace/sources' },
    { icon: 'users', title: 'Buyers', detail: 'Who the demand side is', href: '/app/admin/marketplace/buyers' },
    { icon: 'activity', title: 'Activity', detail: 'The live event stream', href: '/app/admin/marketplace/activity' },
  ];

  const model: EntityPageModel = {
    eyebrow: 'CallGrid Intelligence · Sources',
    title: label,
    subtitle: 'A traffic source in your marketplace.',
    backHref: '/app/admin/marketplace/sources',
    backLabel: 'Sources',
    stats,
    health,
    changes,
    whyItMatters,
    actions,
    evidence,
    related,
    history: [],
    empty: {
      changes: priorRow
        ? 'Nothing moved versus the prior week.'
        : 'No prior week to compare against yet — a second period of data is needed to state what changed.',
      actions: 'Nothing about this source needs a decision right now. The Brain surfaces cross-source moves on the Overview.',
      evidence: readFailed
        ? 'The economics could not be read right now.'
        : 'No calls were attributed to this source in the last 7 days, so there is nothing to show yet.',
      history: 'Per-source history is not recorded yet — only the current and prior windows are available.',
    },
  };

  return <EntityPage model={model} />;
}
