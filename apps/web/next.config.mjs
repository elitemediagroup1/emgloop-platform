/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    transpilePackages: ['@emgloop/shared', '@emgloop/database', '@emgloop/providers'],
    experimental: {
          serverComponentsExternalPackages: ['@prisma/client', 'prisma'],
    },
};

export default nextConfig;
