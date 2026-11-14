import type { ReactNode } from 'react';
export function CreatorPageHead({
  section,
  title,
  description,
  actions,
}: {
  section: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="ch-page-head">
      <div>
        <p className="ch-eyebrow">{section}</p>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="ch-page-head__actions">{actions}</div> : null}
    </header>
  );
}
