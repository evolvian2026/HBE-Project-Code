// Local development reads the same .env.local as the server (repo root). Deployed
// processes get their environment from the platform instead.
if (process.env.NODE_ENV === "development") {
  try {
    process.loadEnvFile("../../.env.local");
  } catch {
    // no local env file
  }
}

/** @type {import("next").NextConfig} */
const config = {
  poweredByHeader: false,
  // The repo-wide ESLint run covers this app.
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ["@hbe/core"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;
