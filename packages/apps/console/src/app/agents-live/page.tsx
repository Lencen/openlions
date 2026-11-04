"use client";
// 2026-09-10 商业化改版: Agent 活跃看板
// 回答: 每个 Agent 现在在不在线 / 正在做什么任务 / 最近一次提交是什么时候 / 最近产出质量如何 / 是否卡住
// 2026-09-14 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数与拼装 (<200 行)。
import { useState } from "react";
import { Alert } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { useApi } from "@/lib/api";
import DataMoment from "@/components/DataMoment";
import { t } from "@/i18n";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { ErrorBlock, PageHero } from "@/components/ui";
import { OPEN_STATUSES } from "@/lib/todos";
import ViewSwitch from "./_components/ViewSwitch";
import AgentsLiveWorkplan from "./_components/AgentsLiveWorkplan";
import AgentsLiveCollab from "./_components/AgentsLiveCollab";
import AgentsLiveHero from "./_components/AgentsLiveHero";
import AgentsLiveMetrics from "./_components/AgentsLiveMetrics";
import AgentCardGrid from "./_components/AgentCardGrid";
import AgentsLiveBottom from "./_components/AgentsLiveBottom";

export default function AgentsLivePage() {
  const f = useGlobalFilter();
  const [view, setView] = useState<"board" | "collab" | "workplan">("board");
  const { data, loading, error, mutate } = useApi<any>(f.withQuery("/api/agents-live") + "&_n=" + f.nonce);
  // 2026-09-10: 每个 Agent 名下未完成的待办数 (TODO 一等实体, 与改进任务分开)
  const { data: todoData } = useApi<any>("/api/todos?ownerType=agent&status=ALL&limit=500");
  const todoByAgent = (() => {
    const map: Record<string, { open: number; done: number }> = {};
    for (const t of (Array.isArray(todoData?.rows) ? todoData.rows : [])) {
      const key = t.ownerId || "(未指派)";
      map[key] = map[key] || { open: 0, done: 0 };
      if (OPEN_STATUSES.includes(t.status)) map[key].open += 1;
      else if (t.status === "DONE") map[key].done += 1;
    }
    return map;
  })();
  const agentTodoOpen = Object.values(todoByAgent).reduce((a, b) => a + b.open, 0);

  if (view === "workplan") {
    return (
      <main className="page">
        <AgentsLiveWorkplan range={f.range} view={view} onChange={setView} />
      </main>
    );
  }

  if (view === "collab") {
    return (
      <main className="page">
        <AgentsLiveCollab range={f.range} agent={f.agent} theme={f.theme} view={view} onChange={setView} />
      </main>
    );
  }

  if (error) {
    return (
      <main className="page">
        <PageHero title={t('agentsLive.title')} subtitle={t('agentsLive.subtitle')} />
        <ErrorBlock message={String(error?.message || "")} onRetry={mutate} />
      </main>
    );
  }

  const loadingAll = loading && !data;
  const s = data?.summary ?? {};
  const agents = data?.agents ?? [];

  return (
    <main className="page">
      <AgentsLiveHero data={data} s={s} agent={f.agent} />

      <ViewSwitch view={view} onChange={setView} hint={t('agentsLive.switchHint')} />

      {data?.warnings?.length ? (
        <Alert type="warning" showIcon style={{ marginBottom: "var(--sp-4)" }} title="部分数据源降级" description={data.warnings.join("；")} />
      ) : null}

      <AgentsLiveMetrics s={s} loadingAll={loadingAll} agentTodoOpen={agentTodoOpen} />

      {/* ---------- Agent 卡片 ---------- */}
      <AgentCardGrid agents={agents} loadingAll={loadingAll} stateRules={s.stateRules} todoByAgent={todoByAgent} />

      {/* 2026-10-16（round 77-R, 决策③逐源 + 77-M 机检清单）: 本页有 2 个数据源 ——
          /api/agents-live（活跃看板）与 /api/todos?ownerType=agent（智能体名下待办, 见上方 agentTodoOpen）。
          此前本页**完全没有**"数据是什么时候的" -> 两组数字都无法判断新旧。
          实测两源各自都有顶层 asOf（agents-live / todos），故**无需改 BFF**, 纯页面改动 ✓。
          口径说明: 这里只在**默认视图**加；workplan / collab 是各自独立取数的子视图, 不属本页数据源 ✓。 */}
      <div className="tiny" style={{ textAlign: "right", color: "var(--text-dim)" }}>
        <DataMoment items={[{ label: "看板", at: data?.asOf }, { label: "待办", at: todoData?.asOf }]} style={{ marginLeft: 0 }} />
      </div>

      {/* ---------- 最近执行流水 ---------- */}
      <AgentsLiveBottom data={data} loadingAll={loadingAll} s={s} />
    </main>
  );
}
