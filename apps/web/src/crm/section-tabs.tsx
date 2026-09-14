import Link from 'next/link';

// Section navigation for CRM record pages (customer, workspace organization).
//
// Each section is its own URL (?tab=), so this is navigation, not an ARIA
// tablist: role="tab" promises arrow-key switching and linked tabpanels that a
// server-rendered link row cannot deliver. Links with aria-current are what a
// keyboard or screen-reader user can actually operate.
//
// A section that is not built yet renders as a labelled, non-focusable item —
// never a link to a page that does not exist.

export interface SectionTab {
  label: string;
  href: string;
  active?: boolean;
  soon?: boolean;
}

export function SectionTabs({ label, tabs }: { label: string; tabs: SectionTab[] }) {
  return (
    <nav className="crm-section-tabs" aria-label={label}>
      <ul role="list">
        {tabs.map((t) => (
          <li key={t.label}>
            {t.soon ? (
              <span className="crm-section-tab is-disabled" aria-disabled="true">
                {t.label}
                <span className="crm-section-tab__soon">Soon</span>
              </span>
            ) : (
              <Link
                href={t.href}
                className={'crm-section-tab' + (t.active ? ' is-active' : '')}
                aria-current={t.active ? 'page' : undefined}
              >
                {t.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
