import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'EMG Loop',
  description: 'AI-first operating system for customer-facing businesses.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
