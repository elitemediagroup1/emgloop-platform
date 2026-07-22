import Link from 'next/link';
import { loadTeamWork } from '../work-data';

// Work OS › Team Work — everything in progress across the organization.
// Same shell + design language as the Work OS home; plain business terminology.

export const dynamic = 'force-dynamic';

export default async function TeamWorkPage() {
  const { rows } = await loadTeamWork();

  return (
    <div className="loop-os">
      <div className="cmd">
        <header className="cmd-head">
          <div className="cmd-head__main">
            <h1 className="cmd-head__greeting">Team Work</h1>
            <p className="cmd-head__meta">Everything in progress across the team.</p>
          </div>
          <Link href="/app/admin/work/new" className="adm-btn adm-btn--primary cmd-head__cta">Start Work</Link>
        </header>

        <section className="adm-card">
          {rows.length === 0 ? (
            <p className="adm-empty">No work is in progress right now. Start work to get things moving.</p>
          ) : (
            <div className="adm-tablewrap">
              <table className="adm-table">
                <thead>
                  <tr><th>Work</th><th>Owner</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td><Link href={r.href} className="adm-link">{r.title}</Link></td>
                      <td className="adm-faint">{r.owner}</td>
                      <td><span className="adm-badge">{r.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
