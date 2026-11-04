"use client";
// 任务详情页 · 智能体执行记录 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Collapse, Tag } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { PanelCard, StateBlock } from "@/components/ui";
import { fmtNum, relTime } from "@/lib/format";
import Block from "./Block";

export default function TaskExecutionsPanel({ data, id }: { data: any; id: string }) {
  return (
    <PanelCard title="智能体执行记录" extra={<span className="tiny">展开可看产出全文</span>}>
      {(data?.executions ?? []).length === 0 ? (
        <StateBlock title="没有智能体执行记录（可能由定时任务直接处理）" rows={2} />
      ) : (
        <Collapse
          defaultActiveKey={[(data.executions[0]?.id as string) || ""]}
          items={(data.executions ?? []).map((e: any) => ({
            key: e.id,
            label: (
              <span style={{ display: "inline-flex", gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap", fontSize: "var(--fs-base)" }}>
                <span className="actor-chip agent">🤖 {e.agentId}</span>
                <Tag color={e.status === "COMPLETED" ? "success" : "error"}>{e.status}</Tag>
                {e.qualityPassed !== null && e.qualityPassed !== undefined ? (
                  <Tag color={e.qualityPassed ? "success" : "error"}>{e.qualityPassed ? "质量通过" : "质量未过"}</Tag>
                ) : null}
                <span className="tiny">产出 {fmtNum(e.outputLength)} 字{e.outputLength > String(e.output || "").length ? "（页面已截断）" : ""}</span>
                {e.retryCount ? <span className="tiny">重试 {e.retryCount}</span> : null}
                <span className="tiny">· {relTime(e.completedAt ?? e.startedAt ?? e.createdAt)}</span>
              </span>
            ),
            children: (
              <div>
                <Block title="产出" text={e.output} fullLength={e.outputLength} taskId={id} />
                <Block title="思考过程" text={e.thoughtProcess} fullLength={e.thoughtProcessLength} taskId={id} />
                <Block title="遇到的问题" text={e.problemsEncountered} fullLength={e.problemsEncounteredLength} taskId={id} />
                <Block title="采取的措施" text={e.solutionsApplied} fullLength={e.solutionsAppliedLength} taskId={id} />
                <Block title="下一步" text={e.nextSteps} fullLength={e.nextStepsLength} taskId={id} />
                <div className="tiny">
                  角色={e.agentRole} · 开始 {e.startedAt ? relTime(e.startedAt) : "-"} · 完成 {e.completedAt ? relTime(e.completedAt) : "-"}
                </div>
              </div>
            ),
          }))}
        />
      )}
    </PanelCard>
  );
}
