import PodScreen from "@/components/PodScreen";

// Patient-facing screen for the hardware pod: questions only, no diagnoses.
// With the wireless pod head: /kiosk?pod=triagepod.local (camera, finger sensor and button over Wi-Fi).
export default async function Kiosk({ searchParams }: { searchParams: Promise<{ pod?: string }> }) {
  const { pod } = await searchParams;
  return <PodScreen kiosk podUrl={pod ? (pod.startsWith("http") ? pod : `http://${pod}`) : undefined} />;
}
