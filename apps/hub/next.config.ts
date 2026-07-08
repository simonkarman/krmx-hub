import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // pg stays a runtime require in the Node server bundle (it pulls in optional
  // fs/pg-native deps that must not be bundled).
  serverExternalPackages: ['pg'],
  webpack: (config, { nextRuntime }) => {
    // instrumentation.ts is also compiled for the edge runtime, where webpack
    // would follow the (Node-only, guarded) reaper import into pg and fail to
    // resolve fs/pg-native. The reaper never runs on edge, so keep pg external
    // there.
    if (nextRuntime !== 'nodejs') {
      config.externals = [...(config.externals ?? []), 'pg', 'pg-native', 'pg-cloudflare'];
    }
    return config;
  },
};

export default nextConfig;
