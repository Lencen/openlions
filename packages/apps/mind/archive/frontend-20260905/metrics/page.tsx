// P2: /metrics -> /flywheel (指标在飞轮页总览 Tab)
import { redirect } from "next/navigation";

export const dynamic = "force-static";

export default function MetricsRedirect() {
  redirect("/flywheel");
}
