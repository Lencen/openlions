// [UI-S6 / 屏06 智能体详情 · 概览] 服务端渲染, curl 到的 HTML 即含真实名册字段
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function AgentIndexPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id || "");
  redirect(`/agents/${encodeURIComponent(id)}/overview`);
}
