import Link from "next/link";

// CallGrid Intelligence — the product's OWN internal navigation, rendered inside
// the product page area (never in the global sidebar). The global sidebar shows
// only the top-level product "CallGrid Intelligence"; entering it reveals these
// sections. "Bids" is the operator term — the word "Auctions" is not used.

export type CallGridNavKey =
  | "overview"
  | "buyers"
  | "vendors"
  | "sources"
  | "campaigns"
  | "activity"
  | "bids";

const ITEMS: { key: CallGridNavKey; label: string; href: string }[] = [
  { key: "overview", label: "Overview", href: "/app/admin/marketplace" },
  { key: "buyers", label: "Buyers", href: "/app/admin/marketplace/buyers" },
  { key: "vendors", label: "Vendors", href: "/app/admin/marketplace/vendors" },
  { key: "sources", label: "Sources", href: "/app/admin/marketplace/sources" },
  { key: "campaigns", label: "Campaigns", href: "/app/admin/marketplace/campaigns" },
  { key: "activity", label: "Activity", href: "/app/admin/marketplace/activity" },
  { key: "bids", label: "Bids", href: "/app/admin/marketplace/auction" },
];

export function CallGridNav({ active }: { active: CallGridNavKey }) {
  return (
    <nav className="loop-mnav" aria-label="CallGrid Intelligence sections">
      {ITEMS.map((item) => {
        const isActive = item.key === active;
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
