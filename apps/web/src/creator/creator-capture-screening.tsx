import { AI_OUTPUT_REJECTIONS } from '@emgloop/shared';
// Manager-only aggregate diagnostics. Never render candidate identities, mail or model output.
const RESULTS = [
  ['CURRENT', 'Accepted summary (may be stale)'],
  ['UNMATCHED_CREATOR', 'Creator not matched in staff subject'],
  ['MIXED_CREATORS', 'Another onboarded creator mentioned'],
  ['UNMAPPED_BRAND', 'No single established company matched in subject or external domain'],
  ['SOURCE_UNAVAILABLE', 'Source unreadable, excluded or outside the time window'],
  ['WITHHELD', 'Internal, automated or withheld by AI'],
  ['MODEL_UNAVAILABLE', 'AI summary unavailable'],
] as const;
type Source = { readonly label: string; readonly readings: readonly { readonly state: string; readonly rejections?: readonly string[] }[] };

export function CreatorCaptureScreening({ sources }: { sources: readonly Source[] }) {
  if (!sources.some(s => s.readings.length)) return null;
  const known = new Set<string>(RESULTS.map(([state]) => state));
  const rows = [...RESULTS.map(([state, label]) => ({ label, counts: sources.map(s => s.readings.filter(r => r.state === state).length) })),
    { label: 'Unclassified result', counts: sources.map(s => s.readings.filter(r => !known.has(r.state)).length) }]
    .filter(row => row.counts.some(Boolean));
  const rejected = AI_OUTPUT_REJECTIONS.map(code => ({ code, counts: sources.map(s => s.readings.filter(r => r.state === 'MODEL_UNAVAILABLE' && Array.isArray(r.rejections) && r.rejections.includes(code)).length) })).filter(row => row.counts.some(Boolean));
  return <details>
    <summary>Why checked threads are not showing summaries</summary>
    <div className="loop-table-wrap"><table aria-label="Creator email screening results">
      <thead><tr><th scope="col">Latest screening result</th>{sources.map((s, i) => <th scope="col" key={i}>{s.label}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.label}><th scope="row">{row.label}</th>{row.counts.map((count, i) => <td key={i}>{count}</td>)}</tr>)}</tbody>
    </table></div>
    {rejected.length ? <div className="loop-table-wrap"><table aria-label="Creator email validation retry reasons">
      <thead><tr><th scope="col">Validation rejection awaiting retry</th>{sources.map((s, i) => <th scope="col" key={i}>{s.label}</th>)}</tr></thead>
      <tbody>{rejected.map(row => <tr key={row.code}><th scope="row">{row.code}</th>{row.counts.map((count, i) => <td key={i}>{count}</td>)}</tr>)}</tbody>
    </table><p className="loop-note">Rejected conversations wait before another AI attempt while the remaining queue continues. Reasons can overlap for one thread.</p></div> : null}
    <p className="loop-note">Counts describe the latest stored result per source thread, not unique brands or AI calls. An unmatched or unmapped thread stops before AI. A withheld result can come from early screening or an AI decision. No email text, candidate brand names or rejected AI output is shown here.</p>
  </details>;
}
