import { redirect } from "next/navigation";

export default function TracksRedirect() {
  redirect("/globe?view=tracks");
}
