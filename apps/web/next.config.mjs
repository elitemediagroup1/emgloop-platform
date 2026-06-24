/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow importing shared workspace packages directly.
  transpilePackages: ['@emgloop/shared'],
};

export default nextConfig;
