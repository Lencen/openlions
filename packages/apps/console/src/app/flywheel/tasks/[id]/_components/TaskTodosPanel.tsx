"use client";
// 任务详情页 · 相关待办 (反向关联) (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Tag, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { PanelCard, Pill, StateBlock } from "@/components/ui";
import { t } from "@/i18n";
import { fmtNum, relTime, truncate } from "@/lib/format";

export default function TaskTodosPanel({ data }: { data: any }) {
  return (
    <PanelCard
      title="相关待办"
      tone="var(--status-warn)"
      extra={
        <Tooltip title="来源: 待办 meta.taskIds 里含本任务, 或待办的 sourceRefId = 本任务">
          <span className="tiny">{fmtNum(data?.todos?.length ?? 0)} 条 · 点开可直接在待办中心展开</span>
        </Tooltip>
      }
    >
      {(data?.todos ?? []).length === 0 ? (
        <StateBlock
          title="这条任务还没有引发待办"
          desc={<span className="tiny">如果任务里出现需要人决策/执行的内容（如 [需要人类决策]），可在上方「转成待办」或在待办中心手动建单。</span>}
          rows={2}
        />
      ) : (
        <div style={{ display: "grid", gap: "var(--sp-2-5)" }}>
          {(data.todos ?? []).map((td: any) => (
            <div
              key={td.id}
              style={{
                border: "1px solid var(--border)",
                borderLeft: "3px solid " + (td.status === "DONE" ? "var(--status-ok)" : td.status === "BLOCKED" ? "var(--status-crit)" : "var(--status-warn)"),
                borderRadius: "var(--radius-md)", background: "var(--bg-surface2)", padding: "var(--sp-2-5) var(--sp-3)",
              }}
            >
              <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center", flexWrap: "wrap", marginBottom: "var(--sp-1)" }}>
                <Tag color={td.status === "DONE" ? "success" : td.status === "BLOCKED" ? "error" : td.status === "DOING" ? "processing" : "blue"}>
                  {td.status === "OPEN" ? "待办" : td.status === "DOING" ? "进行中" : td.status === "BLOCKED" ? "受阻" : td.status === "DONE" ? "已完成" : td.status}
                </Tag>
                <span className="mono" style={{ color: td.priority === "P0" ? "var(--status-crit)" : td.priority === "P1" ? "var(--status-warn)" : "var(--text-muted)", fontWeight: 600, fontSize: "var(--fs-sm)" }}>{td.priority}</span>
                <Pill tone={td.ownerType === "human" ? "warn" : "info"}>{td.ownerType === "human" ? "🧑 人类" : "🤖 " + (td.ownerId || t('common.agent'))}</Pill>
                {td.viaMeta ? <Pill tone="mute">经 meta.taskIds 关联</Pill> : <Pill tone="mute">sourceRefId 直连</Pill>}
                {td.structured ? <Pill tone="ok">结构化详情</Pill> : <Pill tone="warn">旧格式</Pill>}
                <span className="tiny" style={{ marginLeft: "auto" }}>{relTime(td.updatedAt)}</span>
              </div>
              <div style={{ fontSize: "var(--fs-base)", marginBottom: "var(--sp-1)" }}>{td.title}</div>
              {td.detailPreview ? <div className="tiny" style={{ whiteSpace: "pre-wrap", marginBottom: "var(--sp-1)" }}>{truncate(td.detailPreview, 160)}</div> : null}
              <div style={{ display: "flex", gap: "var(--sp-2-5)", alignItems: "center", flexWrap: "wrap" }}>
                <a href={`/todo?open=${td.id}`} style={{ fontSize: "var(--fs-base)" }}>在待办中心展开详情 →</a>
                <span className="tiny mono">{td.id}</span>
                {td.doneAt ? <span className="tiny">完成于 {relTime(td.doneAt)}{td.doneBy ? " · " + td.doneBy : ""}</span> : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </PanelCard>
  );
}
