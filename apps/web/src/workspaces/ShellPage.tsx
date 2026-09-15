import { SidebarIcon } from '../app/crm/_brand/SidebarIcon';

/**
 * ShellPage — the honest empty state for an address with nothing built behind
 * it. It shows no data and makes no claim about what will arrive.
 */
export default function ShellPage({
  eyebrow,
  title,
  description,
  icon = 'grid',
}: {
  eyebrow: string;
  title: string;
  description: string;
  icon?: string;
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
      </div>
    </>
  );
}
