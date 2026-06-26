/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Compile raw-TS workspace packages used by the app.
  // Sprint 11 adds @emgloop/providers (the CallGrid adapter is imported by the
  // database service layer and the webhook route).
  transpilePackages: ['@emgloop/shared', '@emgloop/database', '@emgloop/providers'],
  // Keep Prisma out of the function bundler (esbuild) so its runtime engine is
  // traced as-is and its .d.ts files are never parsed as JS. This is what makes
  // the /demo/intake server action work on Netlify serverless functions.
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', 'prisma'],
  },
};

export default nextConfig;
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Compile raw-TS workspace packages used by the app.
  transpilePackages: ['@emgloop/shared', '@emgloop/database'],
  // Keep Prisma out of the function bundler (esbuild) so its runtime engine is
  // traced as-is and its .d.ts files are never parsed as JS. This is what makes
  // the /demo/intake server action work on Netlify serverless functions.
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', 'prisma'],
  },
};

export default nextConfig;
