/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@emgloop/shared', '@emgloop/database', '@emgloop/providers'],
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', 'prisma'],
  },
  // Sprint 17: serve the EMG Loop SDK at the familiar .js URL. A route segment
  // containing a dot is treated as a static file by the runtime and 404s, so the
  // handler lives at /api/sdk/emg-loop and this rewrite exposes /sdk/emg-loop.js.
  async rewrites() {
    return [
      { source: '/sdk/emg-loop.js', destination: '/api/sdk/emg-loop' },
    ];
  },
};

export default nextConfig;
