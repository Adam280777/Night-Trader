import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@libsql/client", "yahoo-finance2"],
  outputFileTracingIncludes: { "/*": ["./drizzle/**/*"] },
};

export default nextConfig;
