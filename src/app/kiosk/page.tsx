import PodScreen from "@/components/PodScreen";

// Patient-facing screen for the hardware pod: questions only, no diagnoses.
// With the wireless pod head: /kiosk?pod=triagepod.local (camera, finger sensor and button over Wi-Fi).
// ?village=Katete says which village the pod stands in (for the live map at /globe).
export default async function Kiosk({ searchParams }: { searchParams: Promise<{ pod?: string; village?: string }> }) {
  const { pod, village } = await searchParams;
  return <PodScreen kiosk village={village} podUrl={pod ? (pod.startsWith("http") ? pod : `http://${pod}`) : undefined} />;
}
