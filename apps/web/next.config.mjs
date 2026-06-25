/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@emgloop/shared', '@emgloop/database'],
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', 'prisma'],
    outputFileTracingIncludes: {
      '/demo/**': [
        '../../packages/database/node_modules/.prisma/client/**',
        '../../node_modules/.prisma/client/**',
        '../../packages/database/prisma/schema.prisma',
        ],
    },
  },
};

export default nextConfig;
