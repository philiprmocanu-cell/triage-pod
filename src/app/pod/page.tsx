import PodScreen from "@/components/PodScreen";

// The full pod screen for the operator: camera, conversation, typed-answer box, region picker,
// accent teaching and the result panel side by side. The patient-facing version is /kiosk.
export default async function Pod({ searchParams }: { searchParams: Promise<{ pod?: string; village?: string }> }) {
  const { pod, village } = await searchParams;
  return <PodScreen village={village} podUrl={pod ? (pod.startsWith("http") ? pod : `http://${pod}`) : undefined} />;
}
