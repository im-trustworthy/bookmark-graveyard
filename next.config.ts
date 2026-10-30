import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  headers() {
    return [
      {
        // The OAuth consent page: never framed (an approve button in someone
        // else's iframe is a clickjacking target), and its URL, which carries the
        // client's state, is never sent on as a referrer.
        source: "/oauth/authorize/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
