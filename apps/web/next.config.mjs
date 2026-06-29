/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@emgloop/shared', '@emgloop/database', '@emgloop/providers'],
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', 'prisma'],
  },
  // Sprint 17: serve the EMG Loop SDK at the familiar .js URL. A route segment
  // containing a dot is treated as a static file and 404s, so the handler lives
  // at /api/sdk/emg-loop. The rewrite is placed in beforeFiles so it runs BEFORE
  // static-file resolution - otherwise the .js path 404s before the rewrite.
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/sdk/emg-loop.js', destination: '/api/sdk/emg-loop' },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
