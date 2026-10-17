import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: [
        'zen-try.site',
        '*.zen-try.site',
        'zen-try.com',
        '*.zen-try.com',
        'chatifyhelp.com',
        '*.chatifyhelp.com',
        'localhost:3000',
        '127.0.0.1:3000',
      ],
    },
  },
};

export default nextConfig;
