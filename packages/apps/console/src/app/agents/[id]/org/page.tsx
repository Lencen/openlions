// [UI-S6 / 屏06 智能体详情 · 组织]
// 服务端组件 (force-dynamic): 取数后套 AgentShell（对象页签 + 状态行）—— 与概览/配置/运行/版本一致；
//   面包屑与页头由本文件按口径表（PAGE-HEADER-31 §3 第 5 行）渲染后经 header 属性传入。
// 2026-10-13 round 76-AC: 此前该页签是**裸客户端组件、没套 shell**, 导致丢失导航且容器塌陷。
import AgentShell, { AgentTabHeader } from "../_components/AgentShell";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import AgentMissing from "../_components/AgentMissing";
import AgentSourceError from "../_components/AgentSourceError";
import AgentOrgPanel from "../_components/AgentOrgPanel";
import { loadAgent, loadLive } from "../_data";

export const dynamic = "force-dynamic";

export default async function AgentOrgPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id || "");
  const [agentLoad, liveS] = await Promise.all([loadAgent(id), loadLive(id)]);
  // 2026-11-06 D-03：先备好页签页头 —— 名册失败/智能体不存在/正常三条分支都要渲染它，
  //   否则 SSR 首屏没有 page-header（0.4.31 dev 实测 5 页 70/75 的根因就是只有"正常"分支带页头）。
  const tabHeader = (
    <AgentTabHeader
      id={id}
      tab="组织"
      title="智能体详情 · 组织"
      subtitle="所属部门与汇报关系"
      agent={agentLoad.ok ? agentLoad.agent : null}
      live={liveS.data}
    />
  );
  if (!agentLoad.ok) return <AgentSourceError id={id} header={tabHeader} />;
  const agent = agentLoad.agent;
  const live = liveS.data;
  if (!agent && !live) return <AgentMissing id={id} header={tabHeader} />;

  return (
    <AgentShell
      id={id}
      active="org"
      agent={agent}
      live={live}
      header={tabHeader}
    >
      <AgentOrgPanel agentId={id} />
    </AgentShell>
  );
}
