import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The demo runs a production build next to the dev server: give it its own folder so a build
  // never wipes the dev server's files (NEXT_DIST=.next-prod next build / next start).
  distDir: process.env.NEXT_DIST ?? ".next",
  // Quote marks inside JSX text are fine for a demo; the type check still runs.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
