import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Mosquito listener",
  description: "Phone microphone, wingbeat frequencies, Oxford HumBug species models.",
  appleWebApp: { capable: true, title: "Mosquito", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function MosquitoLayout({ children }: { children: React.ReactNode }) {
  return children;
}
