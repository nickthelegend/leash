/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@leash/core'],
  // e2e/stack.sh can build a second console beside a running one (LEASH_E2E_NEXT_DIST).
  distDir: process.env.LEASH_NEXT_DIST_DIR || '.next',
};

export default nextConfig;
