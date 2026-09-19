import Link from "next/link";

// CallGrid Intelligence — the product's OWN section selector, rendered inside the
// product page area (never in the global sidebar). The global sidebar shows only
// the top-level product "CallGrid Intelligence"; entering it reveals these
// sections. "Bids" is the operator term — the word "Auctions" is not used.
//
// A section REPLACES the workspace beneath the executive layer; it is never a
// section stacked onto one long page. Activity is still a route (bookmarks keep
// working) and is reached from Intelligence, where its findings belong.

export type CallGridNavKey =
  | "overview"
  | "money"
  | "buyers"
  | "vendors"
  | "sources"
  | "campaigns"
  | "bids"
  | "intelligence"
  | "activity";

export const CALLGRID_SECTIONS: readonly { key: Exclude<CallGridNavKey, "activity">; label: string; href: string }[] = [
  { key: "overview", label: "Overview", href: "/app/admin/marketplace" },
  { key: "money", label: "Money", href: "/app/admin/marketplace/money" },
  { key: "buyers", label: "Buyers", href: "/app/admin/marketplace/buyers" },
  { key: "vendors", label: "Vendors", href: "/app/admin/marketplace/vendors" },
  { key: "sources", label: "Sources", href: "/app/admin/marketplace/sources" },
  { key: "campaigns", label: "Campaigns", href: "/app/admin/marketplace/campaigns" },
  { key: "bids", label: "Bids", href: "/app/admin/marketplace/bids" },
  { key: "intelligence", label: "Intelligence", href: "/app/admin/marketplace/intelligence" },
];

// `rangeQuery` is the selection's own query (e.g. "period=weekly&date=2026-09-07",
// or a legacy "range=last_7_days"), carried on every link so the selected period
// persists as the operator moves between sections.
export function CallGridNav({ active, rangeQuery }: { active: CallGridNavKey; rangeQuery?: string }) {
  const suffix = rangeQuery ? `?${rangeQuery}` : "";
  return (
    <nav className="loop-mnav cgx-nav" aria-label="CallGrid Intelligence sections">
      {CALLGRID_SECTIONS.map((item) => {
        const isActive = item.key === active;
        return (
          <Link
            key={item.key}
            href={item.href + suffix}
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
