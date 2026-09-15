import ShellPage from './ShellPage';
import { LOOP_NAV } from './config';

// What an address with no built surface renders.
//
// When Loop's navigation offers the module (Creator Hub, Accounting), it says
// plainly that the module is not built. Any other address, including legacy
// placeholder URLs, says the page is not available. It never claims a surface
// lives here, shows no data, and so needs no authority beyond its route's own.

export default function UnavailablePage({ href }: { href: string }) {
  const item = LOOP_NAV.nav.flatMap((g) => g.items).find((i) => i.href === href && !i.soon);
  return item ? (
    <ShellPage
      eyebrow="Not built yet"
      title={item.label}
      description={`${item.label} is not built yet. Nothing here is live.`}
      icon={item.icon}
    />
  ) : (
    <ShellPage
      eyebrow="Not available"
      title="This page is not available"
      description="Nothing is built at this address. Use the navigation to open what you have access to."
    />
  );
}
