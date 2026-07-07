import Link from "next/link";

type MarketplaceNavKey =
  | "overview"
  | "campaigns"
  | "buyers"
  | "sources"
  | "vendors"
  | "activity";

const NAV_ITEMS: { key: MarketplaceNavKey; label: string; href: string }[] = [
  { key: "overview", label: "Overview", href: "/app/admin/marketplace" },
  { key: "campaigns", label: "Campaigns", href: "/app/admin/marketplace/campaigns" },
  { key: "buyers", label: "Buyers", href: "/app/admin/marketplace/buyers" },
  { key: "sources", label: "Sources / Publishers", href: "/app/admin/marketplace/sources" },
  { key: "vendors", label: "Vendors", href: "/app/admin/marketplace/vendors" },
  { key: "activity", label: "Activity", href: "/app/admin/marketplace/activity" },
];

export function MarketplaceNav(props: { active: MarketplaceNavKey }) {
  return (
    <nav className="loop-mnav" aria-label="Marketplace sections">
      {NAV_ITEMS.map((item) => {
        const isActive = item.key === props.active;
        return (
          <Link
            key={item.key}
            href={item.href}
            className={isActive ? "loop-mnav__item loop-mnav__item--active" : "loop-mnav__item"}
            aria-current={isActive ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
