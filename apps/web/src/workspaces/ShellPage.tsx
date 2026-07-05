import { SidebarIcon } from '../app/crm/_brand/SidebarIcon';

/**
 * ShellPage — the premium empty-state used by every workspace page in Phase 2.
 * Prop contract is unchanged from PR #47 so all callers keep working; only the
 * presentation is upgraded for the Loop OS dark theme (PR #48).
 */
export default function ShellPage({
  eyebrow,
  title,
  description,
  icon = 'grid',
  plannedFor,
}: {
  eyebrow: string;
  title: string;
  description: string;
  icon?: string;
  plannedFor?: string[];
}) {
  return (
    <>
      <div className="loop-pagehead">
        <div className="loop-eyebrow">{eyebrow}</div>
        <h1 className="loop-title">{title}</h1>
        <p className="loop-subtitle">{description}</p>
      </div>
      <div className="loop-empty">
        <span className="loop-empty__icon">
          <SidebarIcon name={icon} />
        </span>
        <h2 className="loop-empty__title">Nothing here yet</h2>
        <p className="loop-empty__body">{description}</p>
        {plannedFor && plannedFor.length > 0 ? (
          <div className="loop-empty__next">
            Coming to this workspace: {plannedFor.join(' · ')}
          </div>
        ) : null}
      </div>
    </>
  );
}
