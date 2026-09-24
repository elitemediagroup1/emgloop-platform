import '../loop-os.css';

// The public legal documents (/terms, /privacy). This layout exists for one reason: to load the
// Loop design system's stylesheet for pages that live outside the signed-in /app and /crm trees.
// It renders no shell, resolves no session and reads nothing; each page is a static server
// component (see _legal/legal-document.tsx). The route group keeps the URLs at the root.

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return children;
}
