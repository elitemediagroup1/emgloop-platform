import { SidebarIcon } from '../app/crm/_brand/SidebarIcon';

// Loop OS — Shell Page (Phase 2, PR #47).
//
// A premium, minimal empty-state used by every workspace page in Phase 2. The
// operating system is being built BEFORE the functionality that will live in
// it, so each page renders its title, a one-line purpose, and an honest "shell
// only" marker — clean, information-dense, no clutter. When a real feature
// lands in a later PR, it replaces the <ShellPage> body; the route, guard, and
// nav entry already exist.

export interface ShellPageProps {
  eyebrow: string;
  title: string;
  description: string;
  icon?: string;
  /** Optional notes describing what will plug in here later. */
  plannedFor?: string[];
}

export default function ShellPage({
  eyebrow,
  title,
  description,
  icon = 'grid',
  plannedFor,
}: ShellPageProps & { plannedFor?: string[] }) {
  return (
    <div>
      <div className="ds-pagehead">
        <div className="ds-eyebrow">{eyebrow}</div>
        <h1 className="ds-title">{title}</h1>
        <p className="ds-subtitle">{description}</p>
      </div>

      <div className="ds-card" style={{ marginTop: '1.25rem' }}>
        <div className="ds-card-body ds-empty">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span className="crm-icon-btn" aria-hidden="true">
              <SidebarIcon name={icon} />
            </span>
            <div>
              <strong>Workspace shell</strong>
              <div className="ds-subtitle" style={{ margin: 0 }}>
                This surface is part of the Loop OS shell. Functionality arrives in a later PR.
              </div>
            </div>
          </div>

          {plannedFor && plannedFor.length > 0 ? (
            <ul style={{ marginTop: '1rem', paddingLeft: '1.1rem', opacity: 0.85 }}>
              {plannedFor.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}
