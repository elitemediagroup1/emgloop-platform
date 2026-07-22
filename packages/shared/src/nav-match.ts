// Route → active nav item: pick the nav href that is the LONGEST prefix of the
// current path. Longest-match is what keeps a top-level product selected across
// all its child routes (e.g. /app/admin/work/new resolves to /app/admin/work,
// not the broader /app/admin). This is the ONE matcher behind both the sidebar
// active state and the breadcrumb.

export function pickActiveHref(hrefs: readonly string[], pathname: string | null): string | null {
  if (!pathname) return null;
  let best: string | null = null;
  for (const href of hrefs) {
    if (href.startsWith('#')) continue;
    if (pathname === href || pathname.startsWith(href + '/')) {
      if (best === null || href.length > best.length) best = href;
    }
  }
  return best;
}
