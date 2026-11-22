/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @emgloop/brain: pure functions the database package composes for the Creator Hub (2026-09-22).
  transpilePackages: ['@emgloop/shared', '@emgloop/database', '@emgloop/providers', '@emgloop/brain'],
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', 'prisma'],
  },
};

// Sprint 17 note: the EMG Loop SDK is served as a static asset at
// public/sdk/emg-loop.js (CDN-served directly at /sdk/emg-loop.js, the most
// reliable approach since a Next route segment containing a dot is intercepted
// as a static file). The identical source is also served programmatically by
// the route at /api/sdk/emg-loop. No rewrite is needed.

export default nextConfig;
