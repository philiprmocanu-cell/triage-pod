import { redirect } from "next/navigation";

export default function RoutesRedirect() {
  redirect("/globe?view=routes");
}
