/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    transpilePackages: ['@emgloop/shared', '@emgloop/database', '@emgloop/providers', '@emgloop/brain'],
    experimental: {
          serverComponentsExternalPackages: ['@prisma/client', 'prisma'],
    },
};

export default nextConfig;
