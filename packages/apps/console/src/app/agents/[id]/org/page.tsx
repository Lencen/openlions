// [UI-S6 / 屏06 智能体详情 · 组织]
// 服务端组件 (force-dynamic): 取数后套 AgentShell —— 与概览/配置/运行/版本一致(面包屑 + 头部 + 对象页签)。
// 2026-10-13 round 76-AC: 此前该页签是**裸客户端组件、没套 shell**, 导致丢失导航且容器塌陷。
import AgentShell from "../_components/AgentShell";
import AgentMissing from "../_components/AgentMissing";
import AgentSourceError from "../_components/AgentSourceError";
import AgentOrgPanel from "../_components/AgentOrgPanel";
import { loadAgent, loadLive } from "../_data";

export const dynamic = "force-dynamic";

export default async function AgentOrgPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id || "");
  const [agentLoad, liveS] = await Promise.all([loadAgent(id), loadLive(id)]);
  if (!agentLoad.ok) return <AgentSourceError id={id} />;
  const agent = agentLoad.agent;
  const live = liveS.data;
  if (!agent && !live) return <AgentMissing id={id} />;

  return (
    <AgentShell id={id} active="org" agent={agent} live={live}>
      <AgentOrgPanel agentId={id} />
    </AgentShell>
  );
}
